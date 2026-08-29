// Re-confirming the password of someone who is ALREADY signed in.
//
//   POST { session, password }  ->  { ok: true }
//
// This is what the in-app gates use before a destructive or outward-facing action: run an audit,
// release a dashboard, clear results, delete a customer, replace a customer's API key. It asks for a
// password and nothing more — a code belongs at the door, not on every step behind it.
//
// It confirms and grants nothing: no session, no token, no account record, no role. And it only
// answers for the account the session already belongs to, so it cannot be used to test passwords
// against other accounts.

import { findAccount } from './lib/accounts.js';
import { readSession } from './lib/session.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));
  const session = await readSession(body.session);
  if (!session) return json({ error: 'Not signed in' }, 401);

  const acct = await findAccount(session.username);
  if (!acct || !acct.checkPassword(body.password)) {
    return json({ error: 'That password is not correct.' }, 403);
  }
  return json({ ok: true }, 200);
};
