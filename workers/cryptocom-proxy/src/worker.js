/**
 * cryptocom-proxy — CORS-enabled reverse proxy in front of Crypto.com Exchange's public
 * market-data API (https://api.crypto.com/exchange/v1/public/...), which needs no API key.
 *
 * It exists for two reasons, not just CORS:
 *  1. A browser can't set the Origin-restricted headers some upstream deployments expect, and
 *     Crypto.com's public API doesn't send CORS headers a page running on your own domain can
 *     read directly.
 *  2. The raw API's field names are terse (o/h/l/c/v/t for candles, p/q/s for trades, bare
 *     [price, qty, count] arrays for book levels) and timestamps are epoch milliseconds. The
 *     page's own parsing code (site/coinstats-btc.html, parseCandles/readObj/readNumber) expects
 *     friendlier shapes — open/high/low/close/volume/timestamp(ISO), {price,qty} objects, etc.
 *     That's what this worker reshapes the upstream response into, confirmed field-for-field
 *     against the live API while building this (see each handler's comment).
 *
 * Routes (all GET, instrument_name required unless noted):
 *   /book?instrument_name=BTC_USD&depth=50
 *   /trades?instrument_name=BTC_USD&count=150
 *   /candlestick?instrument_name=BTC_USD&timeframe=1m   (timeframe: 1m/5m/15m/30m/1h/...)
 *   /mark-price?instrument_name=BTCUSD-PERP
 *   /index-price?instrument_name=BTCUSD-INDEX
 */

const UPSTREAM = 'https://api.crypto.com/exchange/v1/public';
const UPSTREAM_TIMEOUT_MS = 8000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, CORS, extraHeaders || {}) });
}

async function upstreamGet(path, search) {
  const url = UPSTREAM + path + '?' + search.toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!res.ok || !data || data.code !== 0) {
      return { ok: false, status: res.ok ? 502 : res.status, detail: (data && data.message) || text.slice(0, 300) };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: 504, detail: timedOut ? 'Crypto.com did not answer in time.' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function withCache(request, ctx, path, search, cacheSeconds, build) {
  const cacheKey = new Request(new URL(request.url).origin + path + '?' + search.toString(), { method: 'GET' });
  const cache = caches.default;
  return cache.match(cacheKey).then(async (hit) => {
    if (hit) return hit;
    const resp = await build();
    if (resp.status === 200) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });
}

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }

/* get-book: result.data[0].{bids,asks}, each level [priceStr, qtyStr, countStr] -> {price,qty} */
async function handleBook(instrumentName, depth, env) {
  const search = new URLSearchParams({ instrument_name: instrumentName });
  if (depth) search.set('depth', String(depth));
  const r = await upstreamGet('/get-book', search);
  if (!r.ok) return json(r.status, { error: 'cryptocom_upstream_error', detail: r.detail });
  const level0 = r.result && Array.isArray(r.result.data) && r.result.data[0];
  const toLevels = (arr) => (Array.isArray(arr) ? arr : []).map((l) => ({ price: num(l[0]), qty: num(l[1]) })).filter((l) => l.price != null && l.qty != null);
  const bids = level0 ? toLevels(level0.bids) : [];
  const asks = level0 ? toLevels(level0.asks) : [];
  return json(200, { payload: { bids, asks } });
}

/* get-trades: result.data[], {p,q,s,t} -> {price,qty,side,timestamp(ISO)} */
async function handleTrades(instrumentName, count) {
  const search = new URLSearchParams({ instrument_name: instrumentName });
  if (count) search.set('count', String(count));
  const r = await upstreamGet('/get-trades', search);
  if (!r.ok) return json(r.status, { error: 'cryptocom_upstream_error', detail: r.detail });
  const rows = (r.result && Array.isArray(r.result.data) ? r.result.data : []).map((t) => ({
    price: num(t.p), qty: num(t.q), side: t.s, timestamp: iso(t.t),
  }));
  return json(200, { payload: { data: rows } });
}

/* get-candlestick: result.data[], {o,h,l,c,v,t(ms)} -> {open,high,low,close,volume,timestamp(ISO)} */
async function handleCandlestick(instrumentName, timeframe) {
  const search = new URLSearchParams({ instrument_name: instrumentName, timeframe: timeframe || '5m' });
  const r = await upstreamGet('/get-candlestick', search);
  if (!r.ok) return json(r.status, { error: 'cryptocom_upstream_error', detail: r.detail });
  const rows = (r.result && Array.isArray(r.result.data) ? r.result.data : []).map((c) => ({
    open: num(c.o), high: num(c.h), low: num(c.l), close: num(c.c), volume: num(c.v), timestamp: iso(c.t),
  }));
  return json(200, { payload: { data: rows } });
}

/* get-valuations: result.data[], {v,t} (latest last) -> {price} */
async function handleValuation(instrumentName, valuationType) {
  const search = new URLSearchParams({ instrument_name: instrumentName, valuation_type: valuationType, count: '1' });
  const r = await upstreamGet('/get-valuations', search);
  if (!r.ok) return json(r.status, { error: 'cryptocom_upstream_error', detail: r.detail });
  const rows = r.result && Array.isArray(r.result.data) ? r.result.data : [];
  const last = rows.length ? rows[rows.length - 1] : null;
  return json(200, { payload: { price: last ? num(last.v) : null } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'cryptocom-proxy' });
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });

    const q = url.searchParams;
    const instrumentName = q.get('instrument_name');
    if (!instrumentName && url.pathname !== '/health') return json(400, { error: 'instrument_name is required' });

    if (url.pathname === '/book') return withCache(request, ctx, url.pathname, q, Number(env.BOOK_TRADES_CACHE_S || 2), () => handleBook(instrumentName, q.get('depth'), env));
    if (url.pathname === '/trades') return withCache(request, ctx, url.pathname, q, Number(env.BOOK_TRADES_CACHE_S || 2), () => handleTrades(instrumentName, q.get('count')));
    if (url.pathname === '/candlestick') return withCache(request, ctx, url.pathname, q, Number(env.CANDLE_CACHE_S || 15), () => handleCandlestick(instrumentName, q.get('timeframe')));
    if (url.pathname === '/mark-price') return withCache(request, ctx, url.pathname, q, Number(env.VALUATION_CACHE_S || 3), () => handleValuation(instrumentName, 'mark_price'));
    if (url.pathname === '/index-price') return withCache(request, ctx, url.pathname, q, Number(env.VALUATION_CACHE_S || 3), () => handleValuation(instrumentName, 'index_price'));

    return json(404, { error: 'not_found' });
  },
};
