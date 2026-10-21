# BTC/USD tracker — standalone rebuild

This is a standalone rebuild of a BTC/USD paper-trading tracker that originally ran as a
Claude artifact (reading CoinStats, Crypto.com, Alpha Vantage and Kalshi through Claude's own
MCP connectors). It now runs as:

- eight small **Cloudflare Workers** (`workers/*`) that each proxy one or more upstream data
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
data to a Claude MCP connector at `/mcp/<MCP_PATH_TOKEN>`. This repo adds three new REST routes
(`/api/market`, `/api/orderbook`, `/api/history`) for the standalone page, alongside the original
MCP route, without touching it.

The deploy workflow **deliberately does not set or rotate** that Worker's `MCP_PATH_TOKEN`
secret — redeploying the code does not change an existing secret's value. If you ever do need to
rotate it, run this yourself from a machine with `wrangler` installed and logged in:

```
wrangler secret put MCP_PATH_TOKEN --config workers/kalshi-btc15/wrangler.toml
```

`/api/history` (`get_btc15_history`) backs the page's "auto-fill the BRTI from Kalshi's own
settlement value" feature (the `kalshiOfficialOn` checkbox): it calls the same public, no-auth
`/markets` endpoint already used for the open market, just with `status=settled`, and reads each
settled window's own `expiration_value` field — the index value Kalshi actually judged that
window against — plus its strike and result. No API key or account needed; this is public data.

`/api/orderbook` (`get_btc15_orderbook`) now also feeds the momentum model directly, as the
"Kalshi book imbalance (Yes vs No bids)" signal — turned on automatically whenever `kalshiOn` is
checked, polled at the same cadence as the market price (`kalshiEvery`). Every other signal in the
model reads BTC spot or futures data and infers what the contract *should* be worth; this one
reads the resting orders of the people actually pricing KXBTC15M right now, which is genuinely
independent of everything else here. It sums the size resting on the Yes-bid and No-bid ladders
(the ask ladders are mechanically derived from the opposite side's bids in `worker.js`'s
`parseBook()`, so they carry no new information and are skipped to avoid double-counting) and
leans toward whichever side has more size behind it. It's skipped — contributes nothing, pushes no
item — when the book is empty, too thin to mean anything, or doesn't match the ticker of the
window currently being traded. No API key or account needed; this is the same public, no-auth
route `/api/market` already uses.

One Kalshi feature in the page still isn't implemented on this Worker and will show as
unavailable rather than erroring loudly: the live, authenticated BRTI ticker feed
(`get_brti_live`), which needs your own Kalshi API key and possibly a separate CF Benchmarks
entitlement. It's optional — the core page (price tracking, the model, paper trading, the Kalshi
strike comparison, and the settlement-history BRTI autofill above) works fully without it.

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

## Live automation, Phase 1: shadow mode (no real trading yet)

Added to `site/coinstats-btc.html` only (no new Worker) — a rehearsal for a real money-connected
trading bot, with no real account or API key involved yet:

- Every auto-trade placed on the existing paper Kalshi ledger is mirrored as a same-dollar Coinbase
  position, using the live Coinbase price this page already polls through `refprice-proxy` — long
  when betting over, a synthetic short-equivalent when betting under (a plain spot buy can't
  literally short, so this approximates what a futures/margin short would have done).
- The mirror opens at the live Coinbase price when the bet is placed and closes at the Coinbase
  price read when the window settles (a few seconds after the real close, not the exact tick).
- A daily loss cap, in dollars, combines today's Kalshi-shadow (the paper ledger's auto-trade
  results) and Coinbase-shadow results. Once crossed, both stop opening new shadow trades until
  manually re-armed — the same behavior a real bot would need, tested here with zero financial risk.

**Phase 2 (real order placement) is a separate, much bigger build, not yet started.** It needs:
- A Kalshi account with a generated API key (RSA key pair) under Account → API Keys, and separately
  a Coinbase Advanced Trade API key scoped with *trade* (not just view) permission.
- A hard server-side daily loss cap (not just client-side) that disarms live order submission the
  moment it's crossed, requiring a manual re-arm — mirroring what shadow mode already rehearses.
- Secure handling of real trading keys as Worker secrets, never exposed to the browser.

Claude will not place a real trade or transfer real funds on your behalf under any circumstance —
that's a fixed rule, not a setting. Phase 2, if and when you want it, is code you'd run yourself
under your own credentials and your own risk.

## Decision-quality improvements (calibration, consecutive-loss stop, source agreement)

Added to `site/coinstats-btc.html` only (no new Worker) — three additions aimed at making entry
decisions more evidence-based rather than just intuition-tuned:

- **Probability calibration, feeding Kelly sizing.** A new table in Indicator calibration buckets
  your own settled bets by the model's stated probability at entry and checks the realized win
  rate in each bucket — a different question from the existing per-indicator agree/disagree table,
  which only asks whether a bet matched what an indicator said. With the new "shrink Kelly's
  probability toward this page's own calibration" toggle on (default on), `kellySizeNow()` shrinks
  the probability it feeds into the Kelly formula toward whatever a bucket's own realized hit rate
  has actually been, weighted by how much settled data is in that bucket — so a model that's
  overconfident at high stated odds can't oversize on an edge that hasn't shown up in results. It
  only touches the Kelly *sizing* input; the contract price you'd actually pay is unaffected. Needs
  at least 20 settled bets in a probability bucket before it does anything; with less, sizing is
  unchanged.
- **A consecutive-loss stop, separate from the existing daily dollar cap.** "Stop auto-trading
  after N losses in a row" (default 6, in the auto-trading settings) switches auto-trading off the
  same way the daily balance cap already does, and needs the same manual re-check to resume. The
  dollar cap can take a while to trip on a run of small bets; this catches that run on its own
  terms, since a losing streak that long against gates that were passing is more likely a regime
  the model doesn't currently fit than bad luck.
- **Price-source agreement check.** New bets now save how far apart CoinStats, Kalshi's live BRTI,
  and the cross-exchange reference price were at the moment they were placed (whichever of those
  are fresh right now, regardless of which one is actually wired up as the main price). A new
  read-only check in Indicator calibration splits settled bets at the median of that spread and
  compares win rates, so "is some of my edge actually just two price sources disagreeing" has an
  actual answer instead of a hunch. Only bets placed after this was added carry the reading.

## Model-accuracy improvements (settlement bias check, calibration-weighted model)

Two more additions to `site/coinstats-btc.html`, this time aimed at the probability estimate
itself rather than sizing or risk management:

- **Settlement-bias diagnostic.** The existing price-adjustment system (the `adj` dollar offset,
  auto-set from recent typed-or-Kalshi BRTI readings) already self-corrects live — that part was
  already built. What's new: Indicator calibration's Kalshi-history section now reports whether
  the *residual* bias after that adjustment is still statistically distinguishable from zero
  (`khStat`'s new `se`/`significant` fields, a continuous-quantity version of the Wilson-interval
  checks already used elsewhere on this page). If it's still significantly off, that's a sign the
  flat-offset adjustment is hitting its own `ADJ_STEP_LIMIT`/`ADJ_MAX` guardrails rather than fully
  absorbing the gap. This check is far more reliable with `kalshiOfficialOn` switched on, since
  that's what gives it a reading from every close instead of only the ones you typed yourself.
- **Calibration-weighted model (opt-in).** A new "weight each reading by its own proven record"
  toggle in Indicator calibration (off by default) feeds that same card's own agree/disagree
  verdicts back into `computeMomentumRaw()` live: a reading shown "predictive" (significant, beyond
  sampling noise) votes at 1.5x, one shown "inverted" votes at 0x (zeroed, not flipped — inversions
  are a weaker, less stable thing to act on than just not counting a reading), and anything without
  enough settled bets yet is unchanged. Previously every reading counted equally regardless of its
  own track record. Off by default, and deliberately separate from `calibShrinkOn` (which only
  affects Kelly sizing) — this one changes the probability estimate itself, which is why it stays
  opt-in until the calibration table has enough data to actually trust.

## Momentum proportionality check, and an ETH/BTC relative-strength signal

Two more additions to `site/coinstats-btc.html`:

- **Momentum proportionality.** "Nudge" mode (the default way momentum enters the odds) shifts
  the odds by up to a flat 8 points at full momentum strength — a constant that had never been
  checked against what actually happened. A new table in Indicator calibration buckets decided
  bets by how strongly momentum agreed with the side taken and compares the win rate each bucket
  actually realized against what that 8-point constant predicted for nudge-mode bets in it, so
  "is stronger momentum actually proportionally more valuable, or does it plateau" has a real
  answer instead of a guess. Purely a read-only diagnostic — doesn't change the constant itself.
- **ETH/BTC relative strength.** A new, off-by-default vote in the Order flow card: whether ETH
  is outperforming or underperforming BTC over the same 30 minutes, using the same no-key
  `cryptocom-proxy` Worker already used for everything else here (just a second
  `instrument_name` — no new Worker needed). Every other reading on this page is some transform
  of BTC's own price, volume or order book; this is the one genuinely independent signal, read as
  broad crypto-market risk-on/risk-off strength rather than BTC's own (already-captured)
  momentum. New and unproven, so it's off by default — same spirit as everything else optional
  here, worth switching on and then checking back in the calibration table once it's accumulated
  bets.

## Deribit implied-vol cross-check

A third addition rounding out the model-accuracy batch: a new, no-key `deribit-iv-proxy` Worker
that reads Deribit's public options market (`get_book_summary_by_currency`) and reports the mark
implied vol of the near-the-money BTC option at the nearest expiry at least 20 hours out (skipping
0DTE pin/gamma noise). Everything else this page uses to size volatility — the `vol.fast`/`vol.slow`
blend — is backward-looking: it only ever measures what volatility already *was* over a trailing
window. Implied vol is forward-looking: it's the options market's own best guess at what
volatility will be between now and that option's expiry, which reacts faster than realized vol
right as a regime shifts into or out of a scheduled event. Shown as an informational line in the
volatility note next to the existing realized-vol text (annualized percent and days-to-expiry of
the option it came from, converted to the same "per 5 minutes" scale used elsewhere on the page)
— it is never applied to any calculation, purely a second opinion to eyeball. On by default
(`#useDeribitIv`, display-only, same reasoning as the always-on Kalshi implied-range display) but
degrades silently to nothing shown if Deribit's options data doesn't parse (e.g. no live option at
least 20 hours from expiry).

## Real Coinbase cash balance (read-only, optional)

A new `coinbase-balance-proxy` Worker shows your actual Coinbase cash balance next to the paper
account, purely for reference -- it is architecturally incapable of placing an order or moving
funds. It only ever calls Coinbase's read-only `GET /portfolios` and `GET /portfolios/{uuid}`
endpoints, nothing else, so there is no code path in this Worker that could trade or withdraw even
if you wanted it to.

It deliberately does **not** use Coinbase's plain `GET /accounts` wallet list. That endpoint only
shows balances held in individual currency "accounts" (BTC, USDC, random dust tokens, etc), and for
someone actively trading Coinbase's prediction markets (Kalshi's contracts, hosted inside the
Coinbase app) it can come back with nothing but unrelated crypto and no cash account at all, even
though real cash is sitting in the app. Instead this reads the portfolio-level
`total_cash_equivalent_balance` -- the one number that reflects real spendable cash across the
whole account, prediction-market activity included -- and ignores every individual crypto holding.

**Setup (optional -- everything else on this page works without it):**

1. Go to <https://www.coinbase.com/settings/api> and create a new API key.
2. Check **only** the **View** permission. Leave **Trade**, **Transfer**, and **Receive**
   unchecked -- this is what actually makes the key incapable of trading or withdrawing, enforced
   by Coinbase itself, independent of anything this repo's code does.
3. Coinbase shows you a key name (`organizations/{org_id}/apiKeys/{key_id}`) and a private key
   **once**, at creation time. Copy both immediately. The private key comes in one of two shapes
   depending on what the CDP portal gave you -- `coinbase-balance-proxy` detects and handles
   either, so paste it in exactly as shown, as-is:
   - a bare base64 string with no `-----BEGIN-----` markers (Ed25519, the portal's current
     default), or
   - a PEM block starting `-----BEGIN EC PRIVATE KEY-----` or `-----BEGIN PRIVATE KEY-----`
     (ECDSA/P-256, the legacy key type).
4. Add two repo secrets (Settings -> Secrets and variables -> Actions -> Secrets) named
   `COINBASE_CDP_KEY_NAME` and `COINBASE_CDP_PRIVATE_KEY`, pasting the two values from step 3.
   Do this directly in GitHub's UI -- never paste an API key or private key into a chat with
   Claude or anyone else.
5. Push to `main` (or re-run the workflow) so the new `deploy-coinbase-balance-proxy` job picks up
   the secrets.
6. On the page, check "show my real Coinbase cash balance here" in the new "Coinbase cash balance
   (read-only)" card.

Until you do this, the Worker deploys fine and the card just says "Not set up yet" -- nothing
breaks, nothing is required. The balance shown is read-only and refreshes every 60 seconds; it is
never read by any sizing, odds, or auto-trading logic elsewhere on the page -- except if you
explicitly click "Set balance from Coinbase cash" in Paper trading, which copies that one number
into the paper account's starting balance (still fake money; no real funds move).

**Known limitation:** Coinbase hasn't published a dedicated API endpoint for prediction-markets
cash, and in practice the auto-fetched figure has been observed running noticeably behind what the
app's own Predictions screen shows. There's an **override field** right under the card for exactly
this -- type in the number you see in the Coinbase app and the page uses that everywhere instead
(including for "Set balance from Coinbase cash"); clear it to go back to auto-fetch.

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
  deribit-iv-proxy/    Deribit near-the-money BTC option implied vol, forward-looking (no key needed)
  coinbase-balance-proxy/  read-only real Coinbase account balances (optional, needs COINBASE_CDP_KEY_NAME + COINBASE_CDP_PRIVATE_KEY)
site/
  coinstats-btc.html   the standalone page; publish target for Cloudflare Pages
.github/workflows/
  deploy.yml           deploys all eight Workers + the page on push to main
```
