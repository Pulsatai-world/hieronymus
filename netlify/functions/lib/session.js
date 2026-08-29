// A session is the only thing that grants access to anything in this platform.
//
// It exists because the login system had grown five different credential namings
// (username/password, staffUsername/staffPassword, requestingUsername/requestingPassword,
// requestingStaffUsername/requestingStaffPassword, currentPassword) and six overlapping
// session-ish concepts (a staff token, a two-factor "ticket", a localStorage flag, and three
// storage keys). Every new rule had to be taught all of them, and each rule that missed one was a
// hole — that is not an accident of implementation, it is what happens when there is no single
// answer to "is this caller allowed".
//
// The rules here are the whole model:
//
//   1. A password proves who you are. It is used at a login and at an in-app confirmation, and it
//      is never stored in a browser and never sent to fetch data.
//   2. A code from an authenticator app is required at EVERY login. There is no path that trades a
//      password for access without one.
//   3. A session is what grants access afterwards. It is issued only by a login that passed both of
//      the above, or by finishing enrollment (which also proves both). Nothing else mints one.
//
// A session is opaque, stored server-side, and revocable — signing out really ends it. It carries
// its own scope, so an endpoint asks "what may this caller see" instead of re-deriving it from
// whatever credentials happened to be in the query string.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Two stores, because staff sessions already existed under this name and ten endpoints read them
// directly. Keeping the name means those endpoints keep working unchanged while everything moves to
// one shape; the customer store is new because customers had no session at all, which is precisely
// why the two-factor ticket ended up standing in for one and let a fresh login skip its code.
const STAFF_STORE = 'hieronymus-staff-sessions';
const CLIENT_STORE = 'hieronymus-client-sessions';

// Idle timeout and hard ceiling. The length of a session IS the two-factor policy: a session that
// lasts a month means a code once a month, which is not two-factor in any meaningful sense.
const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_MS = 24 * 60 * 60 * 1000;

// Sessions minted before two-factor was deployed are dead. Same instant every endpoint uses.
const EPOCH = Date.parse('2026-08-29T14:11:51Z');

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

// Staff: role travels on the session so a page cannot promote itself by editing localStorage.
export async function createStaffSession(username, role) {
  const token = newToken();
  await getStore(STAFF_STORE).setJSON(token, {
    kind: 'staff',
    username: String(username).toLowerCase(),
    role: role || 'user',
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    // Kept for the ten endpoints that still read this store directly and check expiresAt themselves.
    expiresAt: new Date(Date.now() + IDLE_MS).toISOString()
  });
  return token;
}

// Customers: the company travels on the session, so "may this caller read this company" is a
// comparison rather than a password check against a record.
export async function createClientSession(username, company) {
  const token = newToken();
  await getStore(CLIENT_STORE).setJSON(token, {
    kind: 'customer',
    username: String(username).toLowerCase(),
    company: company || '',
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    expiresAt: new Date(Date.now() + IDLE_MS).toISOString()
  });
  return token;
}

// Reads a session of either kind and renews it. Returns null for anything that is not a live
// session, and says nothing about why: a caller learning "expired" versus "never existed" only helps
// someone probing tokens.
//
// Renewal is written back only once the idle window is more than half spent, so this is not a store
// write on every request while still keeping an active session alive through a working day.
export async function readSession(token) {
  if (!token) return null;
  for (const storeName of [STAFF_STORE, CLIENT_STORE]) {
    const store = getStore(storeName);
    const rec = await store.get(String(token), { type: 'json' }).catch(() => null);
    if (!rec || !rec.username) continue;

    const created = Date.parse(rec.createdAt || 0);
    if (!created || created < EPOCH) return null;                 // predates two-factor
    if (Date.now() - created > MAX_MS) return null;               // hard ceiling
    const lastSeen = Date.parse(rec.lastSeenAt || rec.createdAt || 0);
    if (!lastSeen || Date.now() - lastSeen > IDLE_MS) return null; // idle out

    if (Date.now() - lastSeen > IDLE_MS / 2) {
      rec.lastSeenAt = nowIso();
      rec.expiresAt = new Date(Date.now() + IDLE_MS).toISOString();
      await store.setJSON(String(token), rec).catch(() => {});
    }
    return {
      kind: rec.kind || (storeName === STAFF_STORE ? 'staff' : 'customer'),
      username: rec.username,
      company: rec.company || '',
      role: rec.role || '',
      createdAt: rec.createdAt
    };
  }
  return null;
}

// True when this session may act as the given username. Used where an endpoint previously verified a
// password to answer the same question.
export async function sessionIsUser(token, username) {
  const s = await readSession(token);
  return !!(s && username && s.username === String(username).toLowerCase());
}

// True when this session may read/write the given company: that customer's own session, or any
// staff session.
export async function sessionAllowsCompany(token, company) {
  const s = await readSession(token);
  if (!s) return false;
  if (s.kind === 'staff') return true;
  if (!company) return false;
  return slug(s.company) === slug(company);
}

export async function sessionIsStaff(token) {
  const s = await readSession(token);
  return !!(s && s.kind === 'staff');
}

export async function sessionIsStaffAdmin(token) {
  const s = await readSession(token);
  return !!(s && s.kind === 'staff' && s.role === 'admin');
}

export async function revokeSession(token) {
  if (!token) return;
  await Promise.all([
    getStore(STAFF_STORE).delete(String(token)).catch(() => {}),
    getStore(CLIENT_STORE).delete(String(token)).catch(() => {})
  ]);
}

// Ends every session belonging to an account. Used when an authenticator is reset or a password
// changes: clearing the second factor while leaving live sessions alone would achieve nothing.
export async function revokeAllFor(username) {
  const uname = String(username || '').toLowerCase();
  if (!uname) return;
  for (const storeName of [STAFF_STORE, CLIENT_STORE]) {
    const store = getStore(storeName);
    const { blobs } = await store.list().catch(() => ({ blobs: [] }));
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (rec && rec.username === uname) await store.delete(b.key).catch(() => {});
    }
  }
}

function slug(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}
