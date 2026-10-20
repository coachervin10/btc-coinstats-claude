/**
 * paper-store — minimal D1-backed persistence for the standalone page's paper-trading state
 * (balance, bet history, and its own settings), replacing the Claude-artifact version's sync
 * through ArtifactData (which is tied to a Claude account and only reachable from inside a
 * published Claude artifact).
 *
 * There is no real user-account system here: a "token" is just a random, unguessable string
 * (the page generates one with crypto.randomUUID() on first run and keeps it in localStorage).
 * Anyone who can read this exact worker's response and knows a token can read or overwrite that
 * token's state, same trust model as a long unguessable share link -- fine for one person's own
 * paper-trading history, not meant for anything sensitive. To use the same history on another
 * device/browser, copy the token shown in the page's settings into that browser too.
 *
 * Routes:
 *   GET /api/state?token=<uuid>              -> { payload: { data: <your stored JSON>, updated_at } } or 404
 *   PUT /api/state   body: { token, data }    -> upserts; data is stored and returned as-is (opaque to this worker)
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS) });
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, name: 'paper-store' });
    if (url.pathname !== '/api/state') return json(404, { error: 'not_found' });
    if (!env.DB) return json(500, { error: 'not_configured', detail: 'D1 binding DB is missing. See README.md.' });

    if (request.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (!TOKEN_RE.test(token)) return json(400, { error: 'bad_token' });
      const row = await env.DB.prepare('SELECT data, updated_at FROM state WHERE token = ?').bind(token).first();
      if (!row) return json(404, { error: 'not_found' });
      let data;
      try { data = JSON.parse(row.data); } catch (e) { return json(500, { error: 'corrupt_stored_data' }); }
      return json(200, { payload: { data, updated_at: row.updated_at } });
    }

    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_json_body' }); }
      const token = body && body.token;
      if (!TOKEN_RE.test(token || '')) return json(400, { error: 'bad_token' });
      if (body.data === undefined) return json(400, { error: 'missing_data' });
      let serialized;
      try { serialized = JSON.stringify(body.data); } catch (e) { return json(400, { error: 'data_not_serializable' }); }
      const maxChars = Number(env.MAX_STATE_CHARS || 1000000);
      if (serialized.length > maxChars) return json(413, { error: 'state_too_large', max_chars: maxChars, got_chars: serialized.length });
      const now = Date.now();
      await env.DB.prepare(
        'INSERT INTO state (token, data, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(token) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).bind(token, serialized, now).run();
      return json(200, { payload: { ok: true, updated_at: now } });
    }

    return json(405, { error: 'method_not_allowed' });
  },
};
