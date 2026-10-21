/**
 * coinbase-balance-proxy -- a READ-ONLY view of your real Coinbase cash balance, for display next
 * to the paper-trading tracker. This Worker can never place an order, withdraw, or move funds: it
 * only ever calls Coinbase's GET /portfolios and GET /portfolios/{uuid} endpoints (both read-only
 * by nature), and it only works at all if the API key you give it has the "View" permission -- if
 * you also granted it Trade or Transfer, that's a choice made in Coinbase's own key-creation
 * screen, not something this code can do anything with, since it never calls any endpoint but the
 * two below.
 *
 * Why portfolio breakdown, not the plain GET /accounts wallet list: Coinbase's prediction markets
 * (Kalshi contracts, hosted inside the Coinbase app) don't show up as their own currency "account"
 * -- querying /accounts for a user actively trading them can come back with nothing but unrelated
 * crypto dust and no cash account at all, even though real USD cash is sitting in the app. The
 * portfolio breakdown's `total_cash_equivalent_balance` is the one number that reflects actual
 * spendable cash across the whole portfolio -- crypto, equities, and prediction-market activity
 * included -- which is what "cash available" means here.
 *
 * Auth: Coinbase Developer Platform (CDP) API keys, authenticated with a short-lived JWT (RFC
 * 7519 / JWS) signed with your key's private key -- see
 * https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication. Two secrets:
 *   COINBASE_CDP_KEY_NAME     "organizations/{org_id}/apiKeys/{key_id}"
 *   COINBASE_CDP_PRIVATE_KEY  the private key Coinbase shows you ONCE at creation time, in
 *                             whichever of its two shapes the CDP portal gave you:
 *                               - Ed25519 (the portal's current default): a bare base64 string,
 *                                 no PEM markers -- signed with EdDSA
 *                               - ECDSA/P-256 (legacy): a PEM, either "-----BEGIN EC PRIVATE
 *                                 KEY-----" (SEC1) or "-----BEGIN PRIVATE KEY-----" (PKCS8) --
 *                                 signed with ES256
 *                             importSigningKey() below detects which one it got from the
 *                             secret's own shape and signs with the matching algorithm.
 * Set both with `wrangler secret put` or as encrypted GitHub Actions secrets -- never commit them,
 * and never paste them into a chat with anyone, Claude included.
 *
 * Route:
 *   GET /api/accounts -> { payload: {
 *     ok, cash: { value, currency }, fetched_at
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

/* Fixed 16-byte PKCS8 prefix for an Ed25519 private key (RFC 8410): SEQUENCE { INTEGER 0,
   SEQUENCE { OID 1.3.101.112 (id-Ed25519) }, OCTET STRING { OCTET STRING { <32-byte seed> } } }.
   Appending any 32-byte seed to this constant produces a complete, valid PKCS8 DER blob -- there
   is no per-key structure to compute, unlike the EC case above. */
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
function ed25519SeedToPkcs8(seed32) {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed32, ED25519_PKCS8_PREFIX.length);
  return out;
}

/* The CDP portal's two key formats, detected from the secret's own shape -- never from any
   separate "which kind of key is this" setting, since Coinbase doesn't give you one to read:
   - Ed25519 (the portal's current recommended default): a bare base64 string with no PEM
     markers at all, decoding to 64 raw bytes -- the first 32 are the signing seed, the last 32
     are the (unused here) public key, per Coinbase's own JWT-auth docs.
   - ECDSA/P-256 (legacy): a PEM, either "-----BEGIN EC PRIVATE KEY-----" (SEC1, re-wrapped into
     PKCS8 above) or already "-----BEGIN PRIVATE KEY-----" (PKCS8, used as-is).
   Returns { key, alg } where alg is the JWT header's "alg" value, since the two key types sign
   with different algorithms (EdDSA vs ES256) and that has to match what was actually used. */
async function importSigningKey(secret) {
  if (/-----BEGIN/.test(secret)) {
    const isSec1 = /BEGIN EC PRIVATE KEY/.test(secret);
    const bytes = pemBody(secret);
    const der = isSec1 ? sec1ToPkcs8(bytes) : bytes;
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { key: key, alg: 'ES256' };
  }
  const bin = atob(secret.trim());
  const full = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) full[i] = bin.charCodeAt(i);
  const seed = full.slice(0, 32);
  const der = ed25519SeedToPkcs8(seed);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  return { key: key, alg: 'EdDSA' };
}

async function buildJwt(keyName, privateKeySecret, method, host, path) {
  const signing = await importSigningKey(privateKeySecret);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: signing.alg, typ: 'JWT', kid: keyName, nonce: randomNonce() };
  const claims = { sub: keyName, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uri: method + ' ' + host + path };
  const signingInput = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claims));
  const signAlg = signing.alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
  const sigBuf = await crypto.subtle.sign(
    signAlg,
    signing.key,
    new TextEncoder().encode(signingInput)
  ); // Both Ed25519 and Web Crypto's ECDSA already produce the raw signature format JWS expects -- no DER conversion needed either way.
  return signingInput + '.' + b64url(sigBuf);
}

async function cbGet(env, path) {
  const host = 'api.coinbase.com';
  const jwt = await buildJwt(env.COINBASE_CDP_KEY_NAME, env.COINBASE_CDP_PRIVATE_KEY, 'GET', host, path);
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 6000);
  try {
    const res = await fetch('https://' + host + path, {
      headers: { authorization: 'Bearer ' + jwt, accept: 'application/json' },
      signal: ctl.signal,
    });
    const body = await res.json().catch(function () { return null; });
    if (!res.ok || !body) {
      throw new Error('Coinbase answered HTTP ' + res.status + (body && body.error ? ': ' + JSON.stringify(body.error) : ''));
    }
    return body;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Coinbase did not answer within 6 seconds.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* Sums total_cash_equivalent_balance across every non-deleted portfolio. Almost everyone has
   exactly one (a single "DEFAULT" portfolio holds crypto, equities, and prediction-market
   activity together, per Coinbase's own description of how the feature works), but summing
   handles the rare case of more than one without having to guess which one is "the" portfolio. */
async function fetchCash(env) {
  const list = await cbGet(env, '/api/v3/brokerage/portfolios');
  const portfolios = Array.isArray(list.portfolios) ? list.portfolios.filter(function (p) { return !p.deleted; }) : [];
  if (!portfolios.length) throw new Error('Coinbase returned no portfolios for this account.');
  let total = 0, currency = 'USD';
  for (const p of portfolios) {
    const detail = await cbGet(env, '/api/v3/brokerage/portfolios/' + encodeURIComponent(p.uuid));
    const bal = detail.breakdown && detail.breakdown.portfolio_balances && detail.breakdown.portfolio_balances.total_cash_equivalent_balance;
    if (bal) { total += Number(bal.value) || 0; currency = bal.currency || currency; }
  }
  return { value: Math.round(total * 100) / 100, currency: currency };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'coinbase-balance-proxy' });
    if (url.pathname === '/api/debugbreakdown') {
      // Temporary, read-only diagnostic: dumps every portfolio_balances field and position count,
      // to find which figure matches what the Coinbase app itself shows as "balance." No secret
      // material, only the account's own balance numbers. Remove once the right field is settled.
      if (!env.COINBASE_CDP_KEY_NAME || !env.COINBASE_CDP_PRIVATE_KEY) return json(200, { payload: { ok: false, reason: 'not_configured' } });
      try {
        const list = await cbGet(env, '/api/v3/brokerage/portfolios');
        const portfolios = Array.isArray(list.portfolios) ? list.portfolios.filter(function (p) { return !p.deleted; }) : [];
        const out = [];
        for (const p of portfolios) {
          const detail = await cbGet(env, '/api/v3/brokerage/portfolios/' + encodeURIComponent(p.uuid));
          const bd = detail.breakdown || {};
          out.push({
            portfolio: { name: p.name, type: p.type },
            portfolio_balances: bd.portfolio_balances,
            spot_positions_count: (bd.spot_positions || []).length,
            perp_positions_count: (bd.perp_positions || []).length,
            prediction_markets_positions: (bd.prediction_markets_positions || []).map(function (x) { return { product_type: x.product_type, side: x.side, notional_value: x.notional_value, cost_basis: x.cost_basis, unrealized_pnl: x.unrealized_pnl, current_price: x.current_price }; }),
          });
        }
        return json(200, { payload: { ok: true, portfolios: out } });
      } catch (e) {
        return json(502, { payload: { ok: false, detail: String((e && e.message) || e) } });
      }
    }
    if (url.pathname !== '/api/accounts') return json(404, { error: 'not_found' });

    if (!env.COINBASE_CDP_KEY_NAME || !env.COINBASE_CDP_PRIVATE_KEY) {
      return json(200, { payload: { ok: false, reason: 'not_configured' } });
    }

    try {
      const cash = await fetchCash(env);
      return json(200, { payload: { ok: true, cash: cash, fetched_at: new Date().toISOString() } }, 20);
    } catch (e) {
      return json(502, { payload: { ok: false, reason: 'upstream_error', detail: String((e && e.message) || e) } });
    }
  },
};
