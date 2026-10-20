/**
 * refprice-proxy -- a volume-weighted BTC/USD reference price built from the same exchanges
 * CF Benchmarks' BRTI (the index Kalshi's 15-minute BTC contract settles against) draws from:
 * Coinbase, Kraken, Bitstamp, Gemini, Bullish, and itBit. LMAX Digital is a real BRTI
 * constituent too, but it's an institutional-only venue with no open public API, so it's not
 * included here -- this is an approximation of BRTI, not a reproduction of it. The goal is a
 * reference price that tracks the actual settlement benchmark more closely than a single
 * exchange or a single aggregator (CoinStats) would, not an exact replica.
 *
 * Each exchange's raw fields are reshaped into one common shape:
 *   { price, volume (24h, base currency / BTC), bid, ask, high24h, low24h, timestamp }
 * then combined into a volume-weighted average:
 *   vwap = sum(price_i * volume_i) / sum(volume_i)
 * over whichever exchanges answered successfully -- one slow or broken exchange degrades the
 * blend gracefully rather than failing the whole response.
 *
 * Route:
 *   GET /api/vwap -> { payload: {
 *     vwap, totalVolume, sourcesUsed, sourcesTotal,
 *     exchanges: { <name>: {price, volume, bid, ask, high24h, low24h, timestamp} | {error} },
 *     generatedAt
 *   } }
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, cacheS) {
  const headers = Object.assign({ 'content-type': 'application/json' }, CORS);
  if (cacheS) headers['cache-control'] = 'public, max-age=' + cacheS;
  else headers['cache-control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

async function fetchJson(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 4000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchCoinbase() {
  const j = await fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
  return {
    price: num(j.price), volume: num(j.volume), bid: num(j.bid), ask: num(j.ask),
    high24h: NaN, low24h: NaN, timestamp: j.time ? Date.parse(j.time) : Date.now(),
  };
}

async function fetchKraken() {
  const j = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
  if (j.error && j.error.length) throw new Error(j.error.join('; '));
  const keys = Object.keys(j.result || {});
  if (!keys.length) throw new Error('no result pair in response');
  const r = j.result[keys[0]];
  return {
    price: num(r.c && r.c[0]), volume: num(r.v && r.v[1]), bid: num(r.b && r.b[0]), ask: num(r.a && r.a[0]),
    high24h: num(r.h && r.h[1]), low24h: num(r.l && r.l[1]), timestamp: Date.now(),
  };
}

async function fetchBitstamp() {
  const j = await fetchJson('https://www.bitstamp.net/api/v2/ticker/btcusd/');
  return {
    price: num(j.last), volume: num(j.volume), bid: num(j.bid), ask: num(j.ask),
    high24h: num(j.high), low24h: num(j.low),
    timestamp: j.timestamp ? num(j.timestamp) * 1000 : Date.now(),
  };
}

async function fetchGemini() {
  const j = await fetchJson('https://api.gemini.com/v1/pubticker/btcusd');
  const vol = j.volume || {};
  return {
    price: num(j.last), volume: num(vol.BTC), bid: num(j.bid), ask: num(j.ask),
    high24h: NaN, low24h: NaN,
    timestamp: vol.timestamp ? num(vol.timestamp) : Date.now(),
  };
}

async function fetchBullish() {
  // Bullish's BTC market trades against USDC, not USD -- usually ~1:1, but this is a real
  // (small) basis difference against the other, USD-quoted exchanges here.
  const j = await fetchJson('https://api.exchange.bullish.com/trading-api/v1/markets/BTCUSDC/tick');
  return {
    price: num(j.last), volume: num(j.baseVolume), bid: num(j.bestBid), ask: num(j.bestAsk),
    high24h: num(j.high), low24h: num(j.low),
    timestamp: num(j.publishedAtTimestamp) || num(j.createdAtTimestamp) || Date.now(),
  };
}

async function fetchItbit() {
  // itBit's classic public v1 ticker. Paxos (itBit's parent) has since repositioned around an
  // institutional, mostly-authenticated API, so this endpoint's continued availability in its
  // old public shape is NOT independently confirmed as of writing -- if it 404s or the shape
  // has changed, this just throws and itBit is excluded from the blend like any other outage.
  const j = await fetchJson('https://api.itbit.com/v1/markets/XBTUSD/ticker');
  return {
    price: num(j.lastPrice), volume: num(j.volume24h), bid: num(j.bid), ask: num(j.ask),
    high24h: num(j.high24h), low24h: num(j.low24h),
    timestamp: j.serverTimeUTC ? Date.parse(j.serverTimeUTC) : Date.now(),
  };
}

const SOURCES = [
  ['coinbase', fetchCoinbase],
  ['kraken', fetchKraken],
  ['bitstamp', fetchBitstamp],
  ['gemini', fetchGemini],
  ['bullish', fetchBullish],
  ['itbit', fetchItbit],
];

async function buildVwap() {
  const settled = await Promise.allSettled(SOURCES.map(function (s) { return s[1](); }));
  const exchanges = {};
  let sumPV = 0, sumV = 0, ok = 0;
  settled.forEach(function (res, i) {
    const name = SOURCES[i][0];
    const v = res.status === 'fulfilled' ? res.value : null;
    const good = v && Number.isFinite(v.price) && Number.isFinite(v.volume) && v.price > 0 && v.volume > 0;
    if (good) {
      exchanges[name] = v;
      sumPV += v.price * v.volume;
      sumV += v.volume;
      ok++;
    } else {
      exchanges[name] = { error: res.status === 'rejected' ? String((res.reason && res.reason.message) || res.reason) : 'missing or invalid price/volume in response' };
    }
  });
  return {
    vwap: sumV > 0 ? sumPV / sumV : null,
    totalVolume: sumV,
    sourcesUsed: ok,
    sourcesTotal: SOURCES.length,
    exchanges: exchanges,
    generatedAt: Date.now(),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'refprice-proxy', sources: SOURCES.map(function (s) { return s[0]; }) });
    if (url.pathname !== '/api/vwap') return json(404, { error: 'not_found' });

    const cacheS = Number(env.VWAP_CACHE_S || 3);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let data;
    try {
      data = await buildVwap();
    } catch (e) {
      return json(502, { error: 'aggregate_failed', detail: String((e && e.message) || e) });
    }
    const res = json(200, { payload: data }, cacheS);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
