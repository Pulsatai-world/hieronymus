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
import { totpGate, verifyTotp, newSecret, otpauthUri, mintTfaToken } from './lib/two-factor-gate.js';

const SESSION_DAYS = 30;

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
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await sessions.setJSON(token, { username, createdAt: new Date().toISOString(), expiresAt });

  return json({ token, username, expiresAt }, 200);
};
