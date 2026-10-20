const VERSION = '1.1.0';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXBTC15M';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 20000;
const UPSTREAM_TIMEOUT_MS = 4000;

const TOOLS = [
  {
    name: 'get_btc15_market',
    description:
      "Kalshi's currently open 15-minute Bitcoin Up/Down market (series KXBTC15M). Returns the target price (the strike the market settles against), " +
      'the Up and Down prices in dollars (0 to 1), the best bid and ask, volume, and seconds until it closes. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Kalshi BTC 15-minute market', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_btc15_orderbook',
    description:
      "Orderbook for Kalshi's open 15-minute Bitcoin market: the best bids, the ask ladders derived from them, and, if `contracts` is given, " +
      'the average price and total cost to buy that many Yes or No contracts by walking the asks (and whether the book is deep enough). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 20, description: 'How many price levels to return per side (default 5).' },
        contracts: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Optional. Estimate the cost of buying this many contracts.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Kalshi BTC 15-minute orderbook', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/* ------------------------------------------------------------------ helpers ------------------------------------------------------------------ */

class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status || null; }
}

function num(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : null; }
function round4(v) { return Math.round(v * 10000) / 10000; }
function iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }

/** Prices arrive as dollar strings (yes_bid_dollars) or, on older replies, whole cents (yes_bid). Returns dollars. */
function dollars(m, base) {
  const d = m[base + '_dollars'];
  if (d !== undefined && d !== null && d !== '') { const v = parseFloat(d); if (Number.isFinite(v)) return v; }
  if (typeof m[base] === 'number') return m[base] / 100;
  return null;
}

function targetFromText(m) {
  const t = [m.yes_sub_title, m.subtitle, m.title].join(' ');
  const r = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/.exec(t);
  return r ? parseFloat(r[1].replace(/,/g, '')) : null;
}

function normalizeMarket(m) {
  const yb = dollars(m, 'yes_bid'), ya = dollars(m, 'yes_ask'), last = dollars(m, 'last_price');
  let nb = dollars(m, 'no_bid'), na = dollars(m, 'no_ask');
  const quoted = yb != null && ya != null && yb > 0 && ya > 0;
  if (quoted && nb == null) nb = round4(1 - ya);
  if (quoted && na == null) na = round4(1 - yb);
  const up = quoted ? round4((yb + ya) / 2) : (last != null ? last : null);
  const warnings = [];
  let target = num(m.floor_strike);
  if (target == null) target = num(m.cap_strike);
  if (target == null) target = num(m.strike);
  if (target == null) {
    target = targetFromText(m);
    warnings.push(target == null ? 'No target price (floor_strike) was found in the reply.' : 'The target was read from the market title, not from a strike field; check it.');
  }
  if (!quoted) warnings.push(up == null ? 'There is no quote and no last trade, so no price is available.' : 'No two-sided quote right now; up/down are the last trade, not a live price.');
  return {
    ticker: m.ticker, event_ticker: m.event_ticker || null, title: m.title || m.subtitle || '', status: m.status || null,
    target, up, down: up == null ? null : round4(1 - up), quoted,
    yes_bid: yb, yes_ask: ya, no_bid: nb, no_ask: na, last_price: last, spread: quoted ? round4(ya - yb) : null,
    volume: num(m.volume_fp) != null ? num(m.volume_fp) : num(m.volume),
    open_interest: num(m.open_interest_fp) != null ? num(m.open_interest_fp) : num(m.open_interest),
    openMs: Date.parse(m.open_time), closeMs: Date.parse(m.close_time), warnings,
  };
}

/** The market that is open right now: has not closed, has opened, and is the soonest to close. */
function pickMarket(list, now) {
  const ms = (list || []).map(normalizeMarket).filter((m) => Number.isFinite(m.closeMs) && m.closeMs > now);
  if (!ms.length) return null;
  const live = ms.filter((m) => !Number.isFinite(m.openMs) || m.openMs <= now);
  const pool = live.length ? live : ms;
  pool.sort((a, b) => a.closeMs - b.closeMs);
  return pool[0];
}

async function kalshiGet(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(KALSHI + path, { headers: { accept: 'application/json', 'user-agent': 'kalshi-btc15-mcp/' + VERSION + ' (read-only market data)' }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError('Kalshi answered HTTP ' + res.status + '.', res.status);
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* handled below */ }
    if (body == null || typeof body !== 'object') throw new UpstreamError('Kalshi returned something that was not JSON.', res.status);
    return body;
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e && e.name === 'AbortError') throw new UpstreamError('Kalshi did not answer within ' + UPSTREAM_TIMEOUT_MS / 1000 + ' seconds.', null);
    throw new UpstreamError('Could not reach Kalshi: ' + String((e && e.message) || e) + '.', null);
  } finally {
    clearTimeout(timer);
  }
}

/* One Kalshi reply is reused for a moment, and simultaneous callers share a single in-flight request. Best effort:
   Workers may run several isolates, each with its own copy of this. */
const marketCache = { at: 0, body: null, pending: null };
async function loadMarkets(env) {
  const ttl = env && env.CACHE_MS != null && env.CACHE_MS !== '' && Number.isFinite(Number(env.CACHE_MS)) ? Number(env.CACHE_MS) : 1000;
  if (marketCache.body && Date.now() - marketCache.at < ttl) return { body: marketCache.body, at: marketCache.at };
  if (!marketCache.pending) {
    marketCache.pending = kalshiGet('/markets?series_ticker=' + SERIES + '&status=open&limit=10')
      .then((body) => { marketCache.body = body; marketCache.at = Date.now(); return { body, at: marketCache.at }; })
      .finally(() => { marketCache.pending = null; });
  }
  return marketCache.pending;
}

/* ------------------------------------------------------------------ orderbook ------------------------------------------------------------------ */

/** cents (integer) or dollars (decimal number, or a string with a decimal point) -> dollars */
function bookPrice(p) {
  if (p == null) return null;
  const v = parseFloat(p);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (typeof p === 'string') return p.indexOf('.') >= 0 ? v : v / 100;
  return Number.isInteger(v) ? v / 100 : v;
}

function bookLevels(arr) {
  return (Array.isArray(arr) ? arr : []).map((l) => {
    let p, q;
    if (Array.isArray(l)) { p = l[0]; q = l[1]; } else if (l && typeof l === 'object') { p = l.price != null ? l.price : l.price_dollars; q = l.quantity != null ? l.quantity : (l.count != null ? l.count : l.qty); }
    const price = bookPrice(p), qty = parseFloat(q);
    return price != null && qty > 0 ? { price: round4(price), qty } : null;
  }).filter(Boolean);
}

function parseBook(raw) {
  const ob = (raw && (raw.orderbook_fp || raw.orderbook)) || raw || {};
  const yesBids = bookLevels(ob.yes_dollars || ob.yes).sort((a, b) => b.price - a.price);
  const noBids = bookLevels(ob.no_dollars || ob.no).sort((a, b) => b.price - a.price);
  // A bid for No at p is an offer to sell Yes at 1 - p, and the reverse
  const yesAsks = noBids.map((l) => ({ price: round4(1 - l.price), qty: l.qty })).sort((a, b) => a.price - b.price);
  const noAsks = yesBids.map((l) => ({ price: round4(1 - l.price), qty: l.qty })).sort((a, b) => a.price - b.price);
  return { yesBids, noBids, yesAsks, noAsks };
}

function walk(asks, want) {
  let left = want, cost = 0, filled = 0;
  for (const l of asks) {
    if (left <= 0) break;
    const take = Math.min(left, l.qty);
    cost += take * l.price; filled += take; left -= take;
  }
  return { contracts_requested: want, contracts_filled: filled, avg_price: filled > 0 ? round4(cost / filled) : null, total_cost: Math.round(cost * 100) / 100, complete: filled >= want };
}

/* ------------------------------------------------------------------ tools ------------------------------------------------------------------ */

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
const fail = (message, extra) => { const data = Object.assign({ ok: false, error: message }, extra || {}); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true }; };

function shapeMarket(m, now, fetchedAt) {
  return {
    ok: true, ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, status: m.status,
    target: m.target, up: m.up, down: m.down, quoted: m.quoted,
    yes_bid: m.yes_bid, yes_ask: m.yes_ask, no_bid: m.no_bid, no_ask: m.no_ask, last_price: m.last_price, spread: m.spread,
    volume: m.volume, open_interest: m.open_interest,
    open_time: iso(m.openMs), close_time: iso(m.closeMs), seconds_left: Math.max(0, Math.round((m.closeMs - now) / 1000)),
    fetched_at: iso(fetchedAt), data_age_ms: Math.max(0, now - fetchedAt),
    prices_note: 'Prices are in dollars per contract (0 to 1). A winning contract pays $1. up = midpoint of the best Yes bid and ask, or the last trade if there is no two-sided quote.',
    warnings: m.warnings,
  };
}

async function toolMarket(args, env) {
  const { body, at } = await loadMarkets(env);
  const now = Date.now();
  const m = pickMarket(body && body.markets, now);
  if (!m) return fail('No open KXBTC15M market was found in Kalshi\'s reply. It may be between windows; try again in a few seconds.');
  return ok(shapeMarket(m, now, at));
}

async function toolBook(args, env) {
  args = args || {};
  let depth = 5;
  if (args.depth !== undefined) {
    depth = Number(args.depth);
    if (!Number.isInteger(depth) || depth < 1 || depth > 20) return fail('depth must be a whole number from 1 to 20.');
  }
  let want = null;
  if (args.contracts !== undefined) {
    want = Number(args.contracts);
    if (!Number.isInteger(want) || want < 1 || want > 1000000) return fail('contracts must be a whole number from 1 to 1,000,000.');
  }
  const { body, at } = await loadMarkets(env);
  const now = Date.now();
  const m = pickMarket(body && body.markets, now);
  if (!m) return fail('No open KXBTC15M market was found in Kalshi\'s reply. It may be between windows; try again in a few seconds.');
  const raw = await kalshiGet('/markets/' + encodeURIComponent(m.ticker) + '/orderbook?depth=' + depth);
  const b = parseBook(raw);
  const top = (a) => a.slice(0, depth);
  const data = {
    ok: true, ticker: m.ticker, target: m.target, seconds_left: Math.max(0, Math.round((m.closeMs - now) / 1000)),
    best: { yes_bid: b.yesBids.length ? b.yesBids[0].price : null, yes_ask: b.yesAsks.length ? b.yesAsks[0].price : null, no_bid: b.noBids.length ? b.noBids[0].price : null, no_ask: b.noAsks.length ? b.noAsks[0].price : null },
    yes_bids: top(b.yesBids), no_bids: top(b.noBids), yes_asks: top(b.yesAsks), no_asks: top(b.noAsks),
    market_fetched_at: iso(at), fetched_at: iso(Date.now()),
    note: 'Prices are dollars per contract. Ask ladders are derived from the opposite side\'s bids (a No bid at p is a Yes ask at 1 - p). Quantities are contracts.',
    warnings: [],
  };
  if (!b.yesBids.length && !b.noBids.length) data.warnings.push('The orderbook is empty.');
  if (want != null) { data.buy_yes = walk(b.yesAsks, want); data.buy_no = walk(b.noAsks, want); }
  return ok(data);
}

const HANDLERS = { get_btc15_market: toolMarket, get_btc15_orderbook: toolBook };

/* ------------------------------------------------------------------ MCP / JSON-RPC ------------------------------------------------------------------ */

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return rpcError(msg && msg.id, -32600, 'Invalid JSON-RPC message.');
  const hasId = msg.id !== undefined && msg.id !== null;
  if (typeof msg.method !== 'string') return hasId ? rpcError(msg.id, -32600, 'Missing method.') : null;   // a stray response or malformed notification
  if (!hasId) return null;                                                                                  // notifications get no reply
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED.indexOf(asked) >= 0 ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kalshi-btc15', title: 'Kalshi BTC 15-minute market (read-only)', version: VERSION },
        instructions: 'Read-only market data for Kalshi\'s 15-minute Bitcoin Up/Down contract. No trading, no account access.',
      });
    }
    case 'ping': return rpcResult(msg.id, {});
    case 'tools/list': return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params && msg.params.name, fn = HANDLERS[name];
      if (!fn) return rpcError(msg.id, -32602, 'Unknown tool: ' + name);
      try {
        return rpcResult(msg.id, await fn((msg.params && msg.params.arguments) || {}, env));
      } catch (e) {
        return rpcResult(msg.id, fail(String((e && e.message) || e), e instanceof UpstreamError ? { upstream_status: e.status } : {}));
      }
    }
    default: return rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
  }
}

/* ------------------------------------------------------------------ HTTP ------------------------------------------------------------------ */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id',
};
function json(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS, extra || {}) });
}
function empty(status, extra) { return new Response(null, { status, headers: Object.assign({ 'cache-control': 'no-store' }, CORS, extra || {}) }); }

/* ---- REST routes for the standalone site (site/coinstats-btc.html), added alongside the
   original /mcp/<token> JSON-RPC route above. Both call the exact same toolMarket/toolBook
   handlers, so the data and caching behavior are identical either way; only the transport
   differs. These routes need no token: Kalshi's own data is public, and the rate limiting
   is already handled by loadMarkets()'s shared in-flight cache. */
async function handleRest(request, url, env) {
  if (request.method !== 'GET') return empty(405, { allow: 'GET, OPTIONS' });
  if (url.pathname === '/api/market') {
    const r = await toolMarket({}, env);
    return json(r.isError ? 502 : 200, { payload: r.structuredContent });
  }
  if (url.pathname === '/api/orderbook') {
    const args = {};
    if (url.searchParams.has('depth')) args.depth = Number(url.searchParams.get('depth'));
    if (url.searchParams.has('contracts')) args.contracts = Number(url.searchParams.get('contracts'));
    const r = await toolBook(args, env);
    return json(r.isError ? 502 : 200, { payload: r.structuredContent });
  }
  return json(404, { error: 'not_found' });
}

export default {
  async fetch(request, env) {
    env = env || {};
    const url = new URL(request.url);
    const token = env.MCP_PATH_TOKEN ? String(env.MCP_PATH_TOKEN) : '';
    const mcpPath = token ? '/mcp/' + token : '/mcp';

    if (request.method === 'OPTIONS') return empty(204);
    if (url.pathname === '/health' || url.pathname === '/') {
      return json(200, { ok: true, name: 'kalshi-btc15', version: VERSION, protected: !!token, endpoint: token ? '/mcp/<your token>' : '/mcp', rest: ['/api/market', '/api/orderbook'] });
    }
    if (url.pathname === '/api/market' || url.pathname === '/api/orderbook') {
      try { return await handleRest(request, url, env); }
      catch (e) { return json(502, { error: 'kalshi_error', detail: String((e && e.message) || e) }); }
    }
    if (url.pathname !== mcpPath) return json(404, { ok: false, error: 'Not found.' });
    if (request.method === 'GET' || request.method === 'DELETE') return empty(405, { allow: 'POST, OPTIONS' });   // no server-initiated stream and no sessions
    if (request.method !== 'POST') return empty(405, { allow: 'POST, OPTIONS' });

    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, rpcError(null, -32600, 'Request too large.'));
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, rpcError(null, -32600, 'Request too large.'));
    let payload;
    try { payload = JSON.parse(text); } catch (e) { return json(400, rpcError(null, -32700, 'Parse error: the body was not valid JSON.')); }

    if (Array.isArray(payload)) {
      if (!payload.length) return json(400, rpcError(null, -32600, 'Empty batch.'));
      const replies = (await Promise.all(payload.map((m) => handleMessage(m, env)))).filter(Boolean);
      return replies.length ? json(200, replies) : empty(202);
    }
    const reply = await handleMessage(payload, env);
    return reply ? json(200, reply) : empty(202);
  },
};
