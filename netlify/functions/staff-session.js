// Exchanges a staff username and password for an opaque session token.
//
// The portal used to keep the password itself in sessionStorage and send it on every API call.
// sessionStorage dies with the tab, so a browser restart left someone "logged in" with nothing to
// send, and the app asked for the password again in the middle of whatever they were doing. A
// token fixes both halves: it survives a restart, and the password never has to be stored at all.
//
// Tokens are opaque, server-side, and revocable — deleting the blob ends the session immediately,
// which a stored password could never offer.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { totpGate } from './lib/two-factor-gate.js';

// Twelve hours, not thirty days. A signed-in session is the thing that spares someone the code, so
// its length IS the two-factor policy: a month-long session means a code once a month.
const SESSION_HOURS = 12;

// Sessions minted before two-factor was deployed are dead — see the other endpoints.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request) => {
  const sessions = getStore('hieronymus-staff-sessions');

  if (request.method === 'DELETE') {
    // Sign-out. Best effort: an unknown token is not an error, the session is gone either way.
    const token = new URL(request.url).searchParams.get('staffToken');
    if (token) await sessions.delete(String(token)).catch(() => {});
    return json({ status: 'ok' }, 200);
  }

  // Is this session still real? The internal pages ask on every load. They used to decide it
  // themselves from a localStorage flag that never expired and was never checked against anything,
  // so one sign-in let someone into the Portal forever without a password or a code.
  if (request.method === 'GET') {
    const token = new URL(request.url).searchParams.get('staffToken');
    if (!token) return json({ error: 'No session' }, 401);
    const sess = await sessions.get(String(token), { type: 'json' }).catch(() => null);
    if (!sess || !sess.username) return json({ error: 'No session' }, 401);
    if (sess.expiresAt && Date.parse(sess.expiresAt) < Date.now()) return json({ error: 'Session expired' }, 401);
    if (sess.createdAt && Date.parse(sess.createdAt) < SESSION_EPOCH) return json({ error: 'Session expired' }, 401);
    const rec = await getStore('hieronymus-staff-users').get(sess.username, { type: 'json' }).catch(() => null);
    if (!rec) return json({ error: 'No session' }, 401);
    // An account whose authenticator was reset must go through setup again, not ride an old session.
    if (!(rec.totp && rec.totp.enabledAt)) return json({ error: 'Two-factor setup required', needsEnrollment: true }, 401);
    return json({ username: sess.username, role: rec.role || 'user', expiresAt: sess.expiresAt }, 200);
  }

  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));
  const username = String((body && body.username) || '').toLowerCase();
  const password = (body && body.password) || '';
  if (!username || !password) return json({ error: 'Missing username or password' }, 400);

  const staffStore = getStore('hieronymus-staff-users');
  const record = await staffStore.get(username, { type: 'json' }).catch(() => null);
  if (!record || !verifyPassword(password, record.passwordHash)) {
    return json({ error: 'Invalid credentials' }, 403);
  }

  // Password alone is no longer enough for an enrolled account. No token is minted until the code
  // checks out, so a stolen password cannot produce a session.
  const gateOpts = { username: username, token: (body && body.tfToken) || '' };
  const gate = await totpGate(record, body && body.code, () => staffStore.setJSON(username, record), json, gateOpts);
  if (gate) return gate;

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await sessions.setJSON(token, { username, createdAt: new Date().toISOString(), expiresAt });

  return json({ token, username, expiresAt }, 200);
};
