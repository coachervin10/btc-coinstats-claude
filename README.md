# BTC/USD tracker — standalone rebuild

This is a standalone rebuild of a BTC/USD paper-trading tracker that originally ran as a
Claude artifact (reading CoinStats, Crypto.com, Alpha Vantage and Kalshi through Claude's own
MCP connectors). It now runs as:

- six small **Cloudflare Workers** (`workers/*`) that each proxy one or more upstream data
  sources, reshaping responses so the page's existing parsing code didn't need to change
- one **static page** (`site/coinstats-btc.html`) that calls those Workers directly with
  `fetch()` — no Claude account, connector, or artifact needed to use it
- a **GitHub Actions workflow** (`.github/workflows/deploy.yml`) that deploys all of the above
  to your own Cloudflare account on every push to `main`

I (Claude) have push access to this repo, but no way to deploy to Cloudflare or set secrets on
your account directly from this session — so the actual deploy happens through GitHub Actions,
using secrets you add once. Nothing below asks you to paste a raw key into chat.

## What you need to set up, once

### 1. A Cloudflare API token

Create one at <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → use the
**Edit Cloudflare Workers** template, or a custom token with at least:
- Account → Workers Scripts → Edit
- Account → Workers KV Storage → Edit (D1 uses this permission group)
- Account → D1 → Edit
- Account → Cloudflare Pages → Edit
- Account → Account Settings → Read

### 2. Four GitHub Actions **secrets**

In this repo: **Settings → Secrets and variables → Actions → Secrets → New repository secret**.

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID — dashboard right sidebar, or `wrangler whoami` |
| `COINSTATS_API_KEY` | your CoinStats API key |
| `ALPHA_VANTAGE_API_KEY` | your Alpha Vantage API key |

### 3. One GitHub Actions **variable**

Same screen, **Variables** tab instead of **Secrets**:

| Variable name | Value |
|---|---|
| `CF_ACCOUNT_SUBDOMAIN` | your account's `*.workers.dev` subdomain, e.g. if a worker shows up at `foo.coachervin10.workers.dev` this is `coachervin10` |

This is how the deployed page finds your Workers — it's filled into `site/coinstats-btc.html` at
deploy time, replacing the `__CF_SUBDOMAIN__` placeholders in the `API_BASE` block near the top
of the script.

### 4. Push to `main`

Once the secrets and variable above are set, push (or re-run the workflow from the **Actions**
tab — **Deploy** → **Run workflow**). It will:

1. Deploy `coinstats-proxy`, `cryptocom-proxy`, `newsflow-proxy`, `kalshi-btc15`,
   `paper-store` and `refprice-proxy` as six separate Workers.
2. Apply `workers/paper-store/schema.sql` to the `btc-paper-store` D1 database (already created
   in your Cloudflare account; this step is safe to run repeatedly — it's `CREATE TABLE IF NOT
   EXISTS`).
3. Substitute your subdomain into `site/coinstats-btc.html` and publish it to Cloudflare Pages
   as the `btc-coinstats-tracker` project.

The Pages URL (something like `https://btc-coinstats-tracker.pages.dev`) is where you'll use the
tracker day to day. Find it under **Workers & Pages** in the Cloudflare dashboard after the first
successful run, or in that job's log output.

## A note on `kalshi-btc15`

This Worker was already live before this project existed, serving Kalshi's 15-minute BTC market
data to a Claude MCP connector at `/mcp/<MCP_PATH_TOKEN>`. This repo adds two new REST routes
(`/api/market`, `/api/orderbook`) for the standalone page, alongside the original MCP route,
without touching it.

The deploy workflow **deliberately does not set or rotate** that Worker's `MCP_PATH_TOKEN`
secret — redeploying the code does not change an existing secret's value. If you ever do need to
rotate it, run this yourself from a machine with `wrangler` installed and logged in:

```
wrangler secret put MCP_PATH_TOKEN --config workers/kalshi-btc15/wrangler.toml
```

Two Kalshi features in the page aren't implemented yet on this Worker and will show as
unavailable rather than erroring loudly:
- the BRTI settlement-history backfill (`get_btc15_history`)
- the live BRTI ticker feed (`get_brti_live`)

Both are optional — the core page (price tracking, the model, paper trading, the Kalshi strike
comparison) works fully without them.

## Three new order-flow signals (CVD, open interest, funding rate)

Added to `cryptocom-proxy` and wired into the page's live momentum model (not just the Trade
Readiness checklist — these three change the model's actual probability output, the same as every
other indicator already in there):

- **Cumulative volume delta (CVD), this window** — net buyer-initiated minus seller-initiated
  trade volume since the current 15-minute window opened, using Crypto.com's own per-trade side
  tag (not a candle-close proxy). Counts as part of the existing "volume readings" vote alongside
  the 5-/15-minute volume ratios and the hourly signed-volume reading.
- **Open interest change, 5 minutes** — read together with price direction over the same stretch:
  price and OI rising together reads as real money confirming the move; price up with OI falling
  reads as more likely short-covering. Also counts as part of the volume-readings vote.
- **Funding rate** — its own, separate vote, and deliberately a different *kind* of signal from
  the rest: very positive funding means longs are paying a premium to stay long (crowded, more
  prone to a squeeze lower), so this one leans against the sign of the rate rather than with it.
  It's a crowding/reversion read, not a trend-following one, and can pull against the other votes
  on purpose.

All three are scaled against their own recent history (the same adaptive-threshold style the
existing mark/index basis reading already uses) rather than a guessed fixed number, since there's
no textbook-normal value for things like "typical open interest change over 5 minutes" for this
specific instrument.

## Cross-exchange reference price (`refprice-proxy`)

`workers/refprice-proxy` fetches Coinbase, Kraken, Bitstamp, Gemini, Bullish and itBit's public
ticker endpoints in parallel and combines them into a volume-weighted average price — a
"Cross-exchange reference price" card on the page. None of these six need an API key or account;
they're all open, unauthenticated endpoints.

**Why these six:** they're most of the real constituent exchanges behind CF Benchmarks' BRTI, the
index Kalshi's 15-minute BTC contract actually settles against. The one real constituent left out
is **LMAX Digital** — an institutional-only venue with no open public API, so there's nothing for
this Worker to call without you having an LMAX account of your own. That means this is an
**approximation** of BRTI, not a reproduction of it — useful for comparison and as a volume
signal, not a guarantee that it matches Kalshi's settlement price exactly.

**What it feeds into:** the page's own tracked price and model (CoinStats-based, used for every
indicator and the strike/edge math) are unchanged — swapping that out would mean re-validating
every indicator against a different polling cadence. Instead, the reference price is shown
side-by-side for comparison, and its volume trend (is combined 24h volume across these exchanges
rising or flat over the last minute?) feeds one new, optional "Volume confirmation" row in Trade
Readiness: a signal backed by a real rise in cross-exchange volume is on firmer ground than the
same signal on flat or falling volume. It's off (informational-only) by default, like the other
optional gates.

**A caveat worth knowing:** `itBit`'s endpoint here uses its older public v1 API shape, which
wasn't independently re-verified as still live in its documented form at the time this was built
(Paxos, itBit's parent, has since shifted its newer API toward an institutional, mostly
authenticated one). If it's gone or changed shape, this Worker just excludes it from the blend
like any other exchange outage — the page will show it with an error in the per-exchange table
rather than breaking anything.

## How cross-device sync works

There's no real login. The page generates a random token (`crypto.randomUUID()`) on first run
and stores it in `localStorage`. That token is your "account" — the `paper-store` Worker stores
one JSON blob of balance + bet history per token in D1, keyed by that token.

To use the same paper-trading history on a second device or browser, open the Settings panel on
the first device, copy the token shown there, and paste it into the same field on the second
device.

**This has the same trust model as a long, unguessable share link, not a real account system.**
Anyone who has your token can read or overwrite that token's data. Don't reuse a token anywhere
sensitive, and treat it like you would a password you don't want to lose — if you clear
`localStorage` without copying it down first, that history is gone.

## Local development

Each Worker is a standalone `wrangler` project under `workers/<name>/`. With `wrangler` installed
and logged in (`wrangler login`):

```
cd workers/coinstats-proxy
wrangler secret put COINSTATS_API_KEY     # once, per environment
wrangler dev                              # local dev server
wrangler deploy                           # manual deploy, if you'd rather not wait for CI
```

`site/coinstats-btc.html` can be opened directly from disk for local testing — just edit the
`API_BASE` block near the top of its `<script>` to point at your `wrangler dev` URLs (or your
already-deployed Worker URLs) instead of the `__CF_SUBDOMAIN__` placeholders.

## Repo layout

```
workers/
  coinstats-proxy/    CoinStats prices + chart data (needs COINSTATS_API_KEY)
  cryptocom-proxy/     Crypto.com order book/trades/candles/mark+index price/funding rate/open interest (no key needed)
  newsflow-proxy/      Alpha Vantage news sentiment + FX rate (needs ALPHA_VANTAGE_API_KEY)
  kalshi-btc15/        Kalshi 15-min BTC market (existing MCP route + new REST routes)
  paper-store/         D1-backed cross-device paper-trading persistence
  refprice-proxy/      Coinbase/Kraken/Bitstamp/Gemini/Bullish/itBit volume-weighted reference price (no key needed)
site/
  coinstats-btc.html   the standalone page; publish target for Cloudflare Pages
.github/workflows/
  deploy.yml           deploys all six Workers + the page on push to main
```
