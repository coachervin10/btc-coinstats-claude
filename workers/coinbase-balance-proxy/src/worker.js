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

/* PEM -> raw DER bytes. Coinbase's CDP portal hands out a PEM headed "-----BEGIN EC PRIVATE
   KEY-----" (SEC1, OpenSSL's "EC private key" format), not "-----BEGIN PRIVATE KEY-----"
   (PKCS8) -- but Web Crypto's importKey only accepts PKCS8 for ECDSA, so the SEC1 body is
   re-wrapped into a PKCS8 PrivateKeyInfo below before import. A PKCS8 PEM, if you ever have one,
   is detected by its header and passed through unwrapped. */
function pemBody(pem) {
  const body = pem.replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function derLen(n) {
  if (n < 128) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = v >>> 8; }
  return [0x80 | bytes.length].concat(bytes);
}

/* Wraps a SEC1 ECPrivateKey DER blob (RFC 5915) in the fixed PKCS8 PrivateKeyInfo structure
   (RFC 5958) Web Crypto requires: version 0, the P-256 (prime256v1, OID 1.2.840.10045.3.1.7)
   AlgorithmIdentifier for id-ecPublicKey (OID 1.2.840.10045.2.1), then the SEC1 bytes verbatim
   inside an OCTET STRING. Verified against a locally generated test key before shipping: the
   resulting key imports, and signs/verifies correctly end to end, even though its raw DER bytes
   don't byte-for-byte match a reference PKCS8 export (optional fields can differ; the signature
   math is what was checked). */
function sec1ToPkcs8(sec1) {
  const algId = [0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  const version = [0x02, 0x01, 0x00];
  const octetHeader = [0x04].concat(derLen(sec1.length));
  const body = version.concat(algId, octetHeader, Array.from(sec1));
  const outer = [0x30].concat(derLen(body.length), body);
  return new Uint8Array(outer);
}

async function importSigningKey(pem) {
  const isSec1 = /BEGIN EC PRIVATE KEY/.test(pem);
  const bytes = pemBody(pem);
  const der = isSec1 ? sec1ToPkcs8(bytes) : bytes;
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
