/**
 * deribit-iv-proxy -- a near-the-money BTC implied-volatility reading from Deribit's public
 * options market, for a forward-looking second opinion against this page's realized-vol blend
 * (which is entirely backward-looking: it only ever measures what volatility already was over a
 * few trailing windows). Realized vol is slow to react right as a regime shifts into or out of a
 * scheduled event; an options market's own implied vol often isn't, since it's pricing in what
 * traders expect BETWEEN now and that option's expiry, not just what already happened.
 *
 * No API key needed -- Deribit's market-data endpoints are public. This worker exists for the
 * same two reasons every other proxy in this repo does: the browser can't rely on Deribit sending
 * CORS headers for a page on your own domain, and the raw response is reshaped into something
 * simpler than "every live BTC option, as one big array" (see pickAtmOption below).
 *
 * Also returns a 25-delta risk reversal (skew_25d = the 25-delta put's IV minus the 25-delta
 * call's IV, in vol points): positive means the market is paying up for downside protection
 * relative to upside (a "fear" skew), negative the reverse. This is genuinely different
 * information from the ATM level above -- it reads the market's expected DIRECTION of a big move,
 * not just its expected SIZE. Deribit's bulk book-summary endpoint (used for everything else here)
 * carries no greeks, so the 25-delta strikes are found by computing each option's own delta from
 * its own mark_iv with a plain Black-Scholes approximation (deltaApprox below) -- not Deribit's own
 * reported greek, and said so in the field names (*_delta is this page's own estimate).
 *
 * Route:
 *   GET /api/iv -> { payload: {
 *     ok, mark_iv, call_mark_iv, put_mark_iv, underlying_price, atm_strike,
 *     expiry (ISO), days_to_expiry, instrument_call, instrument_put,
 *     skew_25d, call25_strike, call25_iv, call25_delta, put25_strike, put25_iv, put25_delta,
 *     fetched_at, warnings
 *   } }
 */

const UPSTREAM = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency';
const UPSTREAM_TIMEOUT_MS = 6000;
// Deribit 0DTE/near-expiry options get noisy, pinned IV right before expiry -- this is a general
// market-wide vol read, not a hedge for one specific 15-minute window, so skip anything expiring
// sooner than this and use the next one out instead.
const MIN_HOURS_TO_EXPIRY = 20;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, cacheS) {
  const headers = Object.assign({ 'content-type': 'application/json' }, CORS);
  headers['cache-control'] = cacheS ? 'public, max-age=' + cacheS : 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

function num(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }

/* Deribit option instrument names look like "BTC-27DEC24-60000-C" -- currency, expiry date
   (DMMMYY, always UTC 08:00), strike, and C/P for call/put. Parsed here rather than trusting any
   one summary object's own fields, since expiry/strike aren't part of the documented response
   shape (only instrument_name, mark_iv, underlying_price, open_interest etc. are). */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseInstrument(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(name || '');
  if (!m) return null;
  const day = Number(m[1]), mon = MONTHS[m[2]], year = 2000 + Number(m[3]);
  if (mon == null) return null;
  const expiryMs = Date.UTC(year, mon, day, 8, 0, 0);     // Deribit options expire 08:00 UTC
  return { strike: Number(m[4]), kind: m[5] === 'C' ? 'call' : 'put', expiryMs: expiryMs };
}

async function fetchOptions() {
  const search = new URLSearchParams({ currency: 'BTC', kind: 'option' });
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM + '?' + search.toString(), { headers: { accept: 'application/json' }, signal: ctl.signal });
    const body = await res.json().catch(function () { return null; });
    if (!res.ok || !body || !Array.isArray(body.result)) {
      throw new Error('Deribit answered HTTP ' + res.status + (body && body.error ? ': ' + JSON.stringify(body.error) : ''));
    }
    return body.result;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Deribit did not answer within ' + (UPSTREAM_TIMEOUT_MS / 1000) + ' seconds.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* Groups every live option by expiry, picks the nearest expiry at least MIN_HOURS_TO_EXPIRY away,
   then within that expiry finds the call and put nearest the group's own underlying_price (each
   option already carries the index price Deribit priced it against). Returns null, with a reason,
   if nothing qualifies (e.g. everything live expires sooner than the minimum). */
function pickAtmOption(rows, now) {
  const byExpiry = {};
  for (const r of rows) {
    const parsed = parseInstrument(r.instrument_name);
    if (!parsed || !(parsed.expiryMs > now)) continue;
    const iv = num(r.mark_iv);
    const underlying = num(r.underlying_price);
    if (iv == null || iv <= 0 || underlying == null || underlying <= 0) continue;
    const key = String(parsed.expiryMs);
    if (!byExpiry[key]) byExpiry[key] = { expiryMs: parsed.expiryMs, options: [] };
    byExpiry[key].options.push({ strike: parsed.strike, kind: parsed.kind, iv: iv, underlying: underlying, instrument: r.instrument_name });
  }
  const expiries = Object.keys(byExpiry).map(function (k) { return byExpiry[k]; }).sort(function (a, b) { return a.expiryMs - b.expiryMs; });
  const minMs = now + MIN_HOURS_TO_EXPIRY * 3600000;
  const group = expiries.find(function (g) { return g.expiryMs >= minMs; }) || expiries[expiries.length - 1];
  if (!group) return { ok: false, reason: 'no live BTC options with a readable mark_iv were found' };
  const underlying = group.options[0].underlying;
  const byStrike = {};
  group.options.forEach(function (o) { const k = String(o.strike); if (!byStrike[k]) byStrike[k] = {}; byStrike[k][o.kind] = o; });
  let best = null, bestDist = Infinity;
  Object.keys(byStrike).forEach(function (k) {
    const dist = Math.abs(Number(k) - underlying);
    if (dist < bestDist) { bestDist = dist; best = byStrike[k]; }
  });
  if (!best) return { ok: false, reason: 'no matching call/put pair at a common strike was found' };
  const call = best.call, put = best.put;
  const ivs = [call, put].filter(Boolean).map(function (o) { return o.iv; });
  if (!ivs.length) return { ok: false, reason: 'the nearest strike had no readable mark_iv on either side' };
  return {
    ok: true,
    mark_iv: ivs.reduce(function (a, x) { return a + x; }, 0) / ivs.length,
    call_mark_iv: call ? call.iv : null, put_mark_iv: put ? put.iv : null,
    underlying_price: underlying, atm_strike: Number(Object.keys(byStrike).find(function (k) { return byStrike[k] === best; })),
    expiry: new Date(group.expiryMs).toISOString(),
    days_to_expiry: Math.round((group.expiryMs - now) / 86400000 * 10) / 10,
    instrument_call: call ? call.instrument : null, instrument_put: put ? put.instrument : null,
    group: group, underlying: underlying,   // handed to pickSkew below; not part of the public payload
  };
}

/* Standard-normal CDF (Abramowitz & Stegun 7.1.26) -- accurate to ~1e-7, plenty for picking the
   nearest-to-25-delta strike out of whatever strikes Deribit happens to list. */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}
/* Black-Scholes delta from the OPTION'S OWN mark_iv (zero rate/dividend -- these are short-dated,
   coin-margined BTC options, where that approximation is standard and the error is negligible next
   to bid/ask spread). Returns null rather than guessing if any input is unusable. */
function deltaApprox(kind, S, K, sigma, T) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0)) return null;
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const callDelta = normCdf(d1);
  return kind === 'call' ? callDelta : callDelta - 1;
}
/* Within the same expiry group pickAtmOption already chose, find the call nearest 0.25 delta and
   the put nearest -0.25 delta, each computed from its own mark_iv, and the resulting IV skew
   between them. Returns an object with everything null (not an error) if nothing in the group has
   enough strikes to estimate deltas from -- the ATM reading above still stands on its own either way. */
function pickSkew(group, underlying, now) {
  const empty = { skew_25d: null, call25_strike: null, call25_iv: null, call25_delta: null, put25_strike: null, put25_iv: null, put25_delta: null };
  if (!group) return empty;
  const T = (group.expiryMs - now) / (365 * 86400000);
  if (!(T > 0)) return empty;
  let bestCall = null, bestCallDist = Infinity, bestPut = null, bestPutDist = Infinity;
  group.options.forEach(function (o) {
    const d = deltaApprox(o.kind, underlying, o.strike, o.iv / 100, T);     // o.iv is mark_iv as a PERCENT (e.g. 55 for 55%), Black-Scholes needs a decimal fraction
    if (d == null) return;
    if (o.kind === 'call') { const dist = Math.abs(d - 0.25); if (dist < bestCallDist) { bestCallDist = dist; bestCall = { o: o, delta: d }; } }
    else { const dist = Math.abs(d - (-0.25)); if (dist < bestPutDist) { bestPutDist = dist; bestPut = { o: o, delta: d }; } }
  });
  if (!bestCall || !bestPut) return empty;
  return {
    skew_25d: bestPut.o.iv - bestCall.o.iv,
    call25_strike: bestCall.o.strike, call25_iv: bestCall.o.iv, call25_delta: Math.round(bestCall.delta * 1000) / 1000,
    put25_strike: bestPut.o.strike, put25_iv: bestPut.o.iv, put25_delta: Math.round(bestPut.delta * 1000) / 1000,
  };
}

async function buildIv() {
  const rows = await fetchOptions();
  const now = Date.now();
  const picked = pickAtmOption(rows, now);
  if (!picked.ok) return { ok: false, error: picked.reason, fetched_at: new Date(now).toISOString() };
  const skew = pickSkew(picked.group, picked.underlying, now);
  delete picked.group; delete picked.underlying;   // internal to this worker only, not part of the public payload
  return Object.assign({ fetched_at: new Date(now).toISOString(), warnings: [] }, picked, skew);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'deribit-iv-proxy' });
    if (url.pathname !== '/api/iv') return json(404, { error: 'not_found' });

    const cacheS = Number((env && env.IV_CACHE_S) || 30);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let data;
    try {
      data = await buildIv();
    } catch (e) {
      return json(502, { error: 'deribit_upstream_error', detail: String((e && e.message) || e) });
    }
    const res = json(200, { payload: data }, cacheS);
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
