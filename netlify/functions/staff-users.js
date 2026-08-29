import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireTwoFactorProof, totpGate } from './lib/two-factor-gate.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// Same staff check every other endpoint performs: a signed-in session token, or a username and
// password verified against this store.
async function isStaffRequester(username, password, token) {
  if (token) {
    const sess = await getStore('hieronymus-staff-sessions').get(String(token), { type: 'json' }).catch(() => null);
    if (sess && sess.username
        && !(sess.expiresAt && Date.parse(sess.expiresAt) < Date.now())
        && !(sess.createdAt && Date.parse(sess.createdAt) < SESSION_EPOCH)) {
      return true;
    }
  }
  if (!username || !password) return false;
  const rec = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' }).catch(() => null);
  if (!rec) return false;
  return verifyPassword(password, rec.passwordHash);
}

// Sessions minted before this cutoff are dead: two-factor became mandatory, and a token issued
// under the old password-only login would otherwise let someone skip enrollment for up to 30 days.
const SESSION_EPOCH = Date.parse('2026-08-28T00:00:00Z');

function stripHash(record) {
  if (!record) return record;
  // `totp` holds the shared secret. Anyone who reads it can generate valid codes forever, so it is
  // stripped alongside the password hash; only the enrolled/not-enrolled fact goes out.
  const { passwordHash, totp, ...rest } = record;
  return { ...rest, twoFactorEnabled: !!(totp && totp.enabledAt) };
}

// Every mutating action here (create/delete/role change) requires the caller to already be an
// admin, proven the same lightweight way the rest of this app proves anything: send that admin's
// own username+password and we verify it server-side. No sessions/tokens exist anywhere in this
// app, so this matches the established pattern rather than introducing a new one.
async function requireAdmin(store, username, password) {
  if (!username || !password) return false;
  const record = await store.get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  if (record.role !== 'admin') return false;
  return verifyPassword(password, record.passwordHash);
}

export default async (request, context) => {
  const store = getStore('hieronymus-staff-users');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // An admin password alone must not be able to mint a new account or reset another one: the
    // attacker would simply enroll their own authenticator on it. Ticket required.
    const adminDenied = await requireTwoFactorProof(url, body, json);
    if (adminDenied) return adminDenied;
    const username = (body.username || '').trim().toLowerCase();
    const password = (body.password || '').trim();
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!username || !password) return json({ error: 'Missing username or password' }, 400);
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
    if (await store.get(username)) return json({ error: 'A staff user with this username already exists' }, 409);

    // First-ever account bootstraps the system as an admin with no other checks — every
    // account after that requires an existing admin's credentials to create.
    const { blobs } = await store.list();
    if (blobs.length > 0) {
      const ok = await requireAdmin(store, body.requestingUsername, body.requestingPassword);
      if (!ok) return json({ error: 'Only an existing admin can create staff accounts' }, 403);
    }

    const record = { username, passwordHash: hashPassword(password), role: blobs.length === 0 ? 'admin' : role, createdAt: new Date().toISOString() };
    await store.setJSON(username, record);
    return json(stripHash(record), 200);
  }

  if (request.method === 'GET') {
    const username = url.searchParams.get('username');
    if (username) {
      const password = url.searchParams.get('password');
      const record = await store.get(username.toLowerCase(), { type: 'json' });
      if (!record || !password || !verifyPassword(password, record.passwordHash)) {
        return json({ error: 'Invalid username or password' }, 401);
      }
      const uname = username.toLowerCase();

      // Confirming a password is not logging in. The in-app gates (run audit, release a dashboard,
      // delete a customer, clear results) re-check the password of someone who is ALREADY signed in,
      // so they stop here: two-factor belongs at the door, not on every step behind it. This answers
      // with nothing but a yes — no account record, no session token, nothing that grants access —
      // and the login path below still requires a code, so this cannot be used to get in.
      if (url.searchParams.get('verifyOnly')) return json({ ok: true }, 200);

      const gateOpts = { username: uname, token: url.searchParams.get('tfToken') };
      const gate = await totpGate(record, url.searchParams.get('code'), () => store.setJSON(uname, record), json, gateOpts);
      if (gate) return gate;
      // Carries the two-factor token onward so signing in does not ask for a second code when the
      // page trades this login for a longer-lived session token.
      return json({ ...stripHash(record), ...(gateOpts.issued ? { tfToken: gateOpts.issued } : {}) }, 200);
    }
    // The only thing a not-yet-signed-in visitor may learn: whether this install has any staff
    // account at all. Without it the first-run bootstrap cannot tell a fresh install from a wrong
    // password, and it discloses a single boolean rather than the directory.
    if (url.searchParams.get('bootstrap')) {
      const { blobs } = await store.list();
      return json({ empty: blobs.length === 0 }, 200);
    }

    // Listing every internal account is staff-only. It answered anyone, and it names each staff
    // member, their role, and now whether they have a second factor configured.
    // Two-factor proof for the listing as well. Not at the top of the handler: the login branch and
    // the verifyOnly password check above both arrive without a ticket by design.
    const proofDenied = await requireTwoFactorProof(url, null, json);
    if (proofDenied) return proofDenied;

    if (!await isStaffRequester(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
      return json({ error: 'Listing staff accounts requires staff credentials' }, 403);
    }

    const { blobs } = await store.list();
    // store.list() can momentarily include a key whose store.get() hasn't caught up yet
    // (Netlify Blobs eventual consistency, most visible right after creating a new account) —
    // drop any not-yet-readable entries rather than crashing the whole listing on them.
    const items = (await Promise.all(blobs.map(async b => stripHash(await store.get(b.key, { type: 'json' }))))).filter(Boolean);
    items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return json({ items }, 200);
  }

  if (request.method === 'PATCH') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // An admin password alone must not be able to mint a new account or reset another one: the
    // attacker would simply enroll their own authenticator on it. Ticket required.
    const adminDenied = await requireTwoFactorProof(url, body, json);
    if (adminDenied) return adminDenied;
    const username = (body.username || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);
    const record = await store.get(username, { type: 'json' });
    if (!record) return json({ error: 'Invalid username' }, 404);

    // Self-service password change requires the account's own current password.
    if (typeof body.newPassword === 'string' && !body.requestingUsername) {
      if (!verifyPassword(body.currentPassword || '', record.passwordHash)) {
        return json({ error: 'Current password is incorrect' }, 401);
      }
      if (body.newPassword.trim().length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
      record.passwordHash = hashPassword(body.newPassword.trim());
    }

    // Admin-driven changes (role change, resetting someone else's password) require another
    // admin's credentials.
    if (body.requestingUsername) {
      const ok = await requireAdmin(store, body.requestingUsername, body.requestingPassword);
      if (!ok) return json({ error: 'Only an admin can make this change' }, 403);
      if (body.newRole === 'admin' || body.newRole === 'user') record.role = body.newRole;
      if (typeof body.newPassword === 'string' && body.newPassword.trim().length >= 6) {
        record.passwordHash = hashPassword(body.newPassword.trim());
      }
    }

    await store.setJSON(username, record);
    return json(stripHash(record), 200);
  }

  if (request.method === 'DELETE') {
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);
    // Same for removing an account, whose credentials arrive in the query string.
    const delDenied = await requireTwoFactorProof(url, null, json);
    if (delDenied) return delDenied;

    const requestingUsername = url.searchParams.get('requestingUsername');
    const requestingPassword = url.searchParams.get('requestingPassword');
    const ok = await requireAdmin(store, requestingUsername, requestingPassword);
    if (!ok) return json({ error: 'Only an admin can remove staff accounts' }, 403);
    if (requestingUsername.toLowerCase() === username) return json({ error: "You can't remove your own account" }, 400);
    await store.delete(username);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
