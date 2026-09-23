import { getStore } from '@netlify/blobs';
import { revokeAllFor } from './lib/session.js';
import { hashPassword, verifyPassword, publicRecord } from './lib/accounts.js';
import { requireStaff, requireStaffAdmin, callerOf } from './lib/authorize.js';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
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

    // Creating an account is an admin action. It is checked against the session, so an admin's
    // password on its own cannot mint a new account and then enroll an authenticator on it.
    const adminDenied = await requireStaffAdmin(url, body, json);
    const username = (body.username || '').trim().toLowerCase();
    const password = (body.password || '').trim();
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!username || !password) return json({ error: 'Missing username or password' }, 400);
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
    // First-ever account bootstraps the system as an admin with no other checks — every
    // account after that requires an existing admin's credentials to create.
    const { blobs } = await store.list();
    // The very first account on a fresh install has nobody to authorise it, so it bootstraps as an
    // admin. Every account after that needs a signed-in admin.
    if (blobs.length > 0 && adminDenied) return adminDenied;

    // Behind the admin guard, deliberately. Answering 409 "already exists" versus 401 "sign in"
    // told anyone who asked which staff usernames are real, without signing in at all.
    if (await store.get(username)) return json({ error: 'A staff user with this username already exists' }, 409);

    const record = { username, passwordHash: hashPassword(password), role: blobs.length === 0 ? 'admin' : role, createdAt: new Date().toISOString() };
    await store.setJSON(username, record);
    return json(publicRecord(record), 200);
  }

  if (request.method === 'GET') {
    // Signing in lives in /api/login now, and confirming a password mid-session in
    // /api/confirm-password. This endpoint manages staff accounts and nothing else.
    if (url.searchParams.get('bootstrap')) {
      const { blobs } = await store.list();
      return json({ empty: blobs.length === 0 }, 200);
    }

    // Listing every internal account is staff-only. It answered anyone, and it names each staff
    // member, their role, and now whether they have a second factor configured.
    // Listing every internal account names each staff member and their role, so it is staff-only.
    const deniedList = await requireStaff(url, null, json);
    if (deniedList) return deniedList;

    const { blobs } = await store.list();
    // store.list() can momentarily include a key whose store.get() hasn't caught up yet
    // (Netlify Blobs eventual consistency, most visible right after creating a new account) —
    // drop any not-yet-readable entries rather than crashing the whole listing on them.
    const items = (await Promise.all(blobs.map(async b => publicRecord(await store.get(b.key, { type: 'json' }))))).filter(Boolean);
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

    const username = (body.username || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);
    const record = await store.get(username, { type: 'json' });
    if (!record) return json({ error: 'Invalid username' }, 404);

    // Who is asking is the session, not a field in the request. It used to be inferred from whether
    // `requestingUsername` was present, which meant the shape of the request decided which rules
    // applied to it.
    const caller = await callerOf(url, body);
    if (!caller || caller.kind !== 'staff') return json({ error: 'Sign in to continue.' }, 401);
    const self = caller.username === username;
    const isAdmin = caller.role === 'admin';

    // Changing your own password needs the current one as well as the session, so a borrowed session
    // cannot lock the owner out of their own account.
    if (self && typeof body.newPassword === 'string') {
      if (!verifyPassword(body.currentPassword || '', record.passwordHash)) {
        return json({ error: 'Current password is incorrect' }, 401);
      }
      if (body.newPassword.trim().length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
      record.passwordHash = hashPassword(body.newPassword.trim());
      await revokeAllFor(username);   // a changed password ends the old sessions
    }

    // Changing someone else's role or password is an admin action.
    if (!self) {
      if (!isAdmin) return json({ error: 'Only an admin can make this change' }, 403);
      if (body.newRole === 'admin' || body.newRole === 'user') record.role = body.newRole;
      if (typeof body.newPassword === 'string' && body.newPassword.trim().length >= 6) {
        record.passwordHash = hashPassword(body.newPassword.trim());
        await revokeAllFor(username);   // a changed password ends the old sessions
      }
    }

    await store.setJSON(username, record);
    return json(publicRecord(record), 200);
  }

  if (request.method === 'DELETE') {
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);
    const delDenied = await requireStaffAdmin(url, null, json);
    if (delDenied) return delDenied;
    const caller = await callerOf(url, null);
    if (caller.username === username) return json({ error: "You can't remove your own account" }, 400);
    // A changed password or a removed account must end that person's live sessions. Without this a
    // fired staff member's token kept passing requireStaff for up to 24 hours — reading every
    // customer's data — and someone who changed their password because they feared compromise
    // left the attacker's session running.
    await store.delete(username);
    await revokeAllFor(username);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
