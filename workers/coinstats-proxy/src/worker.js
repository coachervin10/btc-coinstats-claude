/**
 * coinstats-proxy — a thin, CORS-enabled reverse proxy in front of CoinStats' API, so the
 * static page (site/coinstats-btc.html) can read BTC prices and chart history without ever
 * holding a CoinStats API key in the browser. The key lives only as a Worker secret
 * (COINSTATS_API_KEY) set via `wrangler secret put` — see the repo root README.md.
 *
 * Routes:
 *   GET /v1/tickers/markets?coinId=bitcoin&toCoin=USD&limit=100
 *       -> CoinStats "Get Ticker Markets": per-exchange BTC/USD prices.
 *   GET /v1/coins/:coinId/charts?period=24h
 *       -> CoinStats "Get Coin Chart By Id": [timestamp_seconds, priceUsd, priceBtc, priceEth][]
 *
 * Both routes return the upstream JSON body unchanged, wrapped as { payload: <body> } so the
 * page's existing parsing (which expects a connector `callTool` result's .payload field) needs
 * no changes beyond how it fetches the result.
 *
 * Every response is cached at Cloudflare's edge for a few seconds (TICKER_CACHE_S / CHART_CACHE_S
 * vars in wrangler.toml) so a page with several open tabs, or several viewers, doesn't multiply
 * your CoinStats credit usage.
 */

const UPSTREAM = 'https://api.coinstats.app';
const UPSTREAM_TIMEOUT_MS = 8000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS, extraHeaders || {}),
  });
}

async function upstreamGet(path, search, apiKey) {
  const url = UPSTREAM + path + (search && [...search].length ? '?' + search.toString() : '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'X-API-KEY': apiKey },
      signal: ctl.signal,
      cf: { cacheTtl: 0 }, // edge caching is handled explicitly below, keyed by our own path+query
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: 0, data: { error: timedOut ? 'CoinStats did not answer in time.' : String((e && e.message) || e) } };
  } finally {
    clearTimeout(timer);
  }
}

async function cachedUpstreamGet(request, ctx, path, search, apiKey, cacheSeconds) {
  const cacheKey = new Request(new URL(request.url).origin + path + '?' + search.toString(), { method: 'GET' });
  const cache = caches.default;
  let hit = await cache.match(cacheKey);
  if (hit) return hit;

  const r = await upstreamGet(path, search, apiKey);
  if (!r.ok) {
    return json(r.status === 429 ? 429 : 502, {
      error: 'coinstats_upstream_error',
      status: r.status,
      detail: r.data,
    });
  }
  const resp = json(200, { payload: r.data }, { 'cache-control': 'public, max-age=' + cacheSeconds });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(200, { ok: true, name: 'coinstats-proxy', configured: !!env.COINSTATS_API_KEY });
    }
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (!env.COINSTATS_API_KEY) {
      return json(500, { error: 'not_configured', detail: 'COINSTATS_API_KEY is not set on this Worker. See README.md.' });
    }

    if (url.pathname === '/v1/tickers/markets') {
      const search = new URLSearchParams();
      ['coinId', 'toCoin', 'fromCoin', 'exchange', 'page', 'limit', 'onlyVerified'].forEach((k) => {
        if (url.searchParams.has(k)) search.set(k, url.searchParams.get(k));
      });
      return cachedUpstreamGet(request, ctx, '/v1/tickers/markets', search, env.COINSTATS_API_KEY, Number(env.TICKER_CACHE_S || 3));
    }

    const chartMatch = url.pathname.match(/^\/v1\/coins\/([^/]+)\/charts$/);
    if (chartMatch) {
      const search = new URLSearchParams();
      search.set('period', url.searchParams.get('period') || '24h');
      if (url.searchParams.has('currency')) search.set('currency', url.searchParams.get('currency'));
      return cachedUpstreamGet(request, ctx, '/v1/coins/' + encodeURIComponent(chartMatch[1]) + '/charts', search, env.COINSTATS_API_KEY, Number(env.CHART_CACHE_S || 60));
    }

    return json(404, { error: 'not_found' });
  },
};
