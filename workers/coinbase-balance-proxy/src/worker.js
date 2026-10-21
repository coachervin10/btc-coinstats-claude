/**
 * coinbase-balance-proxy -- a READ-ONLY view of your real Coinbase account balances, for display
 * next to the paper-trading tracker. This Worker can never place an order, withdraw, or move
 * funds: it only ever calls Coinbase's GET /accounts endpoint, and it only works at all if the API
 * key you give it has the "View" permission -- if you also granted it Trade or Transfer, that's a
 * choice made in Coinbase's own key-creation screen, not something this code can do anything with,
 * since it never calls any endpoint but the one below.
 *
 * Auth: Coinbase Developer Platform (CDP) API keys, authenticated with a short-lived ES256 JWT
 * (RFC 7519 / JWS) signed with your key's EC (P-256) private key -- see
 * https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication. Two secrets:
 *   COINBASE_CDP_KEY_NAME     "organizations/{org_id}/apiKeys/{key_id}"
 *   COINBASE_CDP_PRIVATE_KEY  the PEM-formatted EC private key Coinbase shows you ONCE at
 *                             creation time (begins "-----BEGIN EC PRIVATE KEY-----" or
 *                             "-----BEGIN PRIVATE KEY-----")
 * Set both with `wrangler secret put` or as encrypted GitHub Actions secrets -- never commit them,
 * and never paste them into a chat with anyone, Claude included.
 *
 * Route:
 *   GET /api/accounts -> { payload: {
 *     ok, accounts: [{ currency, name, available, hold, uuid }], fetched_at
 *   } }
 *   or, if the two secrets above aren't set yet: { payload: { ok:false, reason:'not_configured' } }
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, cacheS) {
  const headers = Object.assign({ 'content-type': 'application/json' }, CORS);
  headers['cache-control'] = cacheS ? 'private, max-age=' + cacheS : 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s) { return b64url(new TextEncoder().encode(s)); }

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/* PEM -> the raw DER bytes PKCS8 import needs. Coinbase hands out either a PKCS8
   "-----BEGIN PRIVATE KEY-----" block (importable directly) or a SEC1 EC
   "-----BEGIN EC PRIVATE KEY-----" block (Web Crypto can't import SEC1 directly). This repo only
   supports the PKCS8 form, which is what the CDP portal issues for new keys as of this writing --
   if Coinbase ever hands you a SEC1 key instead, it needs converting to PKCS8 first
   (e.g. `openssl pkcs8 -topk8 -nocrypt`) before it'll work here. */
function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importSigningKey(pem) {
  const der = pemToDer(pem);
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function buildJwt(keyName, privateKeyPem, method, host, path) {
  const key = await importSigningKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: keyName, nonce: randomNonce() };
  const claims = { sub: keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: method + ' ' + host + path };
  const signingInput = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claims));
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  ); // Web Crypto's ECDSA signature is already the raw (r||s) format JWS/ES256 expects -- no DER conversion needed.
  return signingInput + '.' + b64url(sigBuf);
}

async function fetchAccounts(env) {
  const host = 'api.coinbase.com', path = '/api/v3/brokerage/accounts';
  const jwt = await buildJwt(env.COINBASE_CDP_KEY_NAME, env.COINBASE_CDP_PRIVATE_KEY, 'GET', host, path);
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 6000);
  try {
    const res = await fetch('https://' + host + path, {
      headers: { authorization: 'Bearer ' + jwt, accept: 'application/json' },
      signal: ctl.signal,
    });
    const body = await res.json().catch(function () { return null; });
    if (!res.ok || !body || !Array.isArray(body.accounts)) {
      throw new Error('Coinbase answered HTTP ' + res.status + (body && body.error ? ': ' + JSON.stringify(body.error) : ''));
    }
    return body.accounts
      .map(function (a) {
        const avail = a.available_balance ? Number(a.available_balance.value) : null;
        const hold = a.hold ? Number(a.hold.value) : null;
        return { currency: a.currency, name: a.name || a.currency, available: avail, hold: hold, uuid: a.uuid };
      })
      .filter(function (a) { return (a.available || 0) > 0 || (a.hold || 0) > 0; });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Coinbase did not answer within 6 seconds.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'coinbase-balance-proxy' });
    if (url.pathname !== '/api/accounts') return json(404, { error: 'not_found' });

    if (!env.COINBASE_CDP_KEY_NAME || !env.COINBASE_CDP_PRIVATE_KEY) {
      return json(200, { payload: { ok: false, reason: 'not_configured' } });
    }

    try {
      const accounts = await fetchAccounts(env);
      return json(200, { payload: { ok: true, accounts: accounts, fetched_at: new Date().toISOString() } }, 20);
    } catch (e) {
      return json(502, { payload: { ok: false, reason: 'upstream_error', detail: String((e && e.message) || e) } });
    }
  },
};
