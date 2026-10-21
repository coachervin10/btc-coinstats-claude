-- paper-store schema: one row per account token, holding the page's entire persisted state
-- (paper balance + bet history + your settings) as one JSON blob. This replaces the segmented
-- settings/big_<key>_<i> scheme the Claude-artifact version used (ArtifactData's own doc-size
-- limits drove that design; a plain D1 TEXT column has no such limit at this size).
CREATE TABLE IF NOT EXISTS state (
  token TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- price_5m: a growing, server-side BTC/USD 5-minute price history, built by coinstats-proxy's
-- own scheduled() cron (see workers/coinstats-proxy/wrangler.toml). CoinStats' chart endpoint
-- only ever exposes the trailing 24 hours itself; this is what lets a backtest reach further
-- back than that, a little more every 20 minutes, for as long as this project stays deployed.
CREATE TABLE IF NOT EXISTS price_5m (
  ts INTEGER PRIMARY KEY,
  price REAL NOT NULL
);
