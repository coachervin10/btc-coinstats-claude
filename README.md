# BTC/USD tracker — standalone rebuild

This is a standalone rebuild of a BTC/USD paper-trading tracker that originally ran as a
Claude artifact (reading CoinStats, Crypto.com, Alpha Vantage and Kalshi through Claude's own
MCP connectors). It now runs as:

- five small **Cloudflare Workers** (`workers/*`) that each proxy one upstream data source,
  reshaping responses so the page's existing parsing code didn't need to change
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

1. Deploy `coinstats-proxy`, `cryptocom-proxy`, `newsflow-proxy`, `kalshi-btc15` and
   `paper-store` as five separate Workers.
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
  cryptocom-proxy/     Crypto.com order book/trades/candles/mark+index price (no key needed)
  newsflow-proxy/      Alpha Vantage news sentiment + FX rate (needs ALPHA_VANTAGE_API_KEY)
  kalshi-btc15/        Kalshi 15-min BTC market (existing MCP route + new REST routes)
  paper-store/         D1-backed cross-device paper-trading persistence
site/
  coinstats-btc.html   the standalone page; publish target for Cloudflare Pages
.github/workflows/
  deploy.yml           deploys all five Workers + the page on push to main
```
