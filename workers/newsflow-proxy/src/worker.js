/**
 * newsflow-proxy — CORS-enabled reverse proxy in front of Alpha Vantage's `query` endpoint, so
 * the static page can read NEWS_SENTIMENT and CURRENCY_EXCHANGE_RATE without holding an Alpha
 * Vantage API key in the browser. The key lives only as a Worker secret (ALPHA_VANTAGE_API_KEY).
 *
 * Unlike the Crypto.com proxy, this one does NOT reshape the response -- the page's own parsing
 * (findExchangeRateObj, and the NEWS_SENTIMENT feed/topics/ticker_sentiment walk) already reads
 * Alpha Vantage's native field names directly, so this is a transparent passthrough of
 * `?function=<FUNCTION_NAME>&...` to https://www.alphavantage.co/query, with the API key
 * injected server-side and the result wrapped as { payload: <raw body> }.
 *
 * Alpha Vantage's free tier is tightly rate-limited, so every response is cached at Cloudflare's
 * edge (NEWS_CACHE_S / FX_CACHE_S in wrangler.toml) -- long enough to match how often the page
 * itself polls, so one slow viewer doesn't burn through a day's quota.
 *
 * Route: GET /query?function=NEWS_SENTIMENT&tickers=CRYPTO:BTC&sort=LATEST&limit=200
 *        GET /query?function=CURRENCY_EXCHANGE_RATE&from_currency=BTC&to_currency=USD
 */

const UPSTREAM = 'https://www.alphavantage.co/query';
const UPSTREAM_TIMEOUT_MS = 10000;
const ALLOWED_FUNCTIONS = new Set(['NEWS_SENTIMENT', 'CURRENCY_EXCHANGE_RATE']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, CORS, extraHeaders || {}) });
}

async function upstreamGet(search) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM + '?' + search.toString(), { headers: { accept: 'application/json' }, signal: ctl.signal });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!res.ok || !data) return { ok: false, status: res.ok ? 502 : res.status, detail: text.slice(0, 300) };
    // Alpha Vantage answers HTTP 200 even for a bad key, a throttled call, or a bad request --
    // it reports those as JSON fields instead of HTTP status codes.
    if (data['Error Message']) return { ok: false, status: 400, detail: data['Error Message'] };
    if (data['Note']) return { ok: false, status: 429, detail: data['Note'] };
    if (data['Information']) return { ok: false, status: 429, detail: data['Information'] };
    return { ok: true, data };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: 504, detail: timedOut ? 'Alpha Vantage did not answer in time.' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'newsflow-proxy', configured: !!env.ALPHA_VANTAGE_API_KEY });
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (url.pathname !== '/query') return json(404, { error: 'not_found' });
    if (!env.ALPHA_VANTAGE_API_KEY) return json(500, { error: 'not_configured', detail: 'ALPHA_VANTAGE_API_KEY is not set on this Worker. See README.md.' });

    const fn = url.searchParams.get('function');
    if (!ALLOWED_FUNCTIONS.has(fn)) return json(400, { error: 'unsupported_function', detail: 'function must be one of: ' + [...ALLOWED_FUNCTIONS].join(', ') });

    const search = new URLSearchParams(url.searchParams);
    search.set('apikey', env.ALPHA_VANTAGE_API_KEY);
    const cacheSeconds = fn === 'NEWS_SENTIMENT' ? Number(env.NEWS_CACHE_S || 180) : Number(env.FX_CACHE_S || 60);

    const cacheKey = new Request(url.origin + url.pathname + '?' + url.searchParams.toString(), { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const r = await upstreamGet(search);
    if (!r.ok) return json(r.status, { error: 'alphavantage_upstream_error', detail: r.detail });
    const resp = json(200, { payload: r.data }, { 'cache-control': 'public, max-age=' + cacheSeconds });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
