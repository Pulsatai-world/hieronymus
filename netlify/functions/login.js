// The one login. Staff and customers, one endpoint, one set of rules.
//
//   POST   { username, password, code }   sign in            -> { session, ...who }
//   GET    ?session=                      restore a session  -> { session, ...who }
//   DELETE ?session=                      sign out
//
// A password alone never gets in. Neither does a session-that-was, a stored flag, or a token minted
// somewhere else — a code from the account's authenticator is checked on every sign-in, and a
// session is the only thing issued.
//
// The previous arrangement let a browser present a "ticket" instead of a code at this step, on the
// understanding that it would only do so when restoring rather than signing in. The server could not
// tell the two apart, so whether a code was required came down to the browser being honest about its
// own intent. Restoring is now a different request (GET with a session), which the server can tell
// apart with certainty.

import { findAccount } from './lib/accounts.js';
import { verifyCode } from './lib/totp.js';
import { readSession, revokeSession } from './lib/session.js';
import { sessionFor, whoPayload } from './lib/identity.js';

const MAX_ATTEMPTS = 5;          // six digits is a million guesses; unthrottled that is brute-forceable
const LOCK_MINUTES = 15;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request) => {
  const url = new URL(request.url);

  // ── Restore ──
  // A page load asking "am I still signed in?". No password, no code: the session either exists and
  // is live, or the caller is not signed in and the page shows its gate.
  if (request.method === 'GET') {
    const session = await readSession(url.searchParams.get('session'));
    if (!session) return json({ error: 'Not signed in' }, 401);

    // ── Staff opening a customer's own page ──
    // Staff need to see what a customer sees: to fill in an intake for them, to review prompts on
    // their behalf, to check a dashboard. `as=` answers with that customer's payload for a staff
    // session, and issues nothing — the staff session stays the credential, so this cannot be used
    // to obtain a customer session. It means a staff sign-in reaches any customer's pages, which is
    // a deliberate trade for being able to help someone who has lost their password.
    const actAs = url.searchParams.get('as');
    if (actAs && session.kind === 'staff') {
      const target = await findAccount(actAs);
      if (!target || target.kind !== 'customer') return json({ error: 'Unknown customer' }, 404);
      return json({ session: url.searchParams.get('session'), staffBypass: true, ...whoPayload(target) }, 200);
    }

    const acct = await findAccount(session.username);
    if (!acct) return json({ error: 'Not signed in' }, 401);
    // An account whose authenticator was reset must set one up again rather than riding a session
    // that predates the reset.
    if (!acct.enrolled) return json({ error: 'Set up your authenticator app to continue.', needsEnrollment: true }, 401);
    return json({ session: url.searchParams.get('session'), ...whoPayload(acct) }, 200);
  }

  // ── Sign out ──
  if (request.method === 'DELETE') {
    await revokeSession(url.searchParams.get('session'));
    return json({ status: 'ok' }, 200);
  }

  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const code = String(body.code || '');

  if (!username || !password) return json({ error: 'Enter your username and password.' }, 400);

  const acct = await findAccount(username);
  // The same answer for an unknown account as for a wrong password, so this cannot be used to find
  // out which usernames exist.
  if (!acct || !acct.checkPassword(password)) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  // No authenticator yet: the only way in is to set one up. This is what the browser turns into the
  // setup dialog with a QR.
  if (!acct.enrolled) {
    return json({ error: 'Set up your authenticator app to continue.', needsEnrollment: true }, 401);
  }

  const auth = acct.auth;

  if (auth.lockedUntil && Date.parse(auth.lockedUntil) > Date.now()) {
    const mins = Math.ceil((Date.parse(auth.lockedUntil) - Date.now()) / 60000);
    return json({ error: 'Too many incorrect codes. Try again in ' + mins + ' minutes.', locked: true }, 429);
  }

  if (!code) {
    return json({ error: 'Enter the 6-digit code from your authenticator app.', needsCode: true }, 401);
  }

  const res = verifyCode(auth.secret, code, { drift: 1 });

  // Codes move forward and are never reused. Refusing only the exact last one was not enough: the
  // accepted window spans three codes at any moment, so a code seen over someone's shoulder stayed
  // usable whenever the previous sign-in had landed on a neighbouring step.
  const replayed = res.ok && typeof auth.lastStep === 'number' && res.step <= auth.lastStep;

  if (!res.ok || replayed) {
    auth.failures = (auth.failures || 0) + 1;
    if (auth.failures >= MAX_ATTEMPTS) {
      auth.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      auth.failures = 0;
    }
    acct.setAuth(auth);
    await acct.save();
    return json({
      error: replayed ? 'That code has already been used. Wait for the next one.' : 'Incorrect code.',
      needsCode: true
    }, 403);
  }

  auth.failures = 0;
  auth.lockedUntil = null;
  auth.lastStep = res.step;
  delete auth.pending;                 // any half-finished setup is done with
  acct.setAuth(auth);
  await acct.save();

  return json({ session: await sessionFor(acct), ...whoPayload(acct) }, 200);
};
