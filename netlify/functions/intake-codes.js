import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { callerOf, requireCompany, requireStaff, requireStaffAdmin } from './lib/authorize.js';
import { publicRecord } from './lib/accounts.js';


function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

// Monitoring cadence → next-run date. Anchored on the start date and advanced one cadence step
// at a time (like a recurring calendar event) until the next occurrence is in the future.
function addCadence(d, cadence) {
  const x = new Date(d);
  if (cadence === 'weekly') x.setUTCDate(x.getUTCDate() + 7);
  else if (cadence === 'semimonthly') x.setUTCDate(x.getUTCDate() + 15);
  else if (cadence === 'quarterly') x.setUTCMonth(x.getUTCMonth() + 3);
  else x.setUTCMonth(x.getUTCMonth() + 1); // monthly (default)
  return x;
}
function computeNextRun(startDate, cadence, nowMs) {
  let d = new Date(String(startDate || '').length === 10 ? startDate + 'T00:00:00Z' : startDate);
  if (isNaN(d.getTime())) d = new Date(nowMs);
  let guard = 0;
  while (d.getTime() <= nowMs && guard++ < 5000) d = addCadence(d, cadence);
  return d.toISOString();
}

function genPassword() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

// Every company is a "group" that can hold multiple member logins (role: 'full' or 'viewer'),
// rather than the single username+plaintext-password a company used to get. Records created
// before this migrate the very first time they're read: the old top-level username/password
// become members[0] (role 'full', password now hashed), so every link already handed out to a
// customer keeps working with no manual migration step.
async function loadGroup(store, key) {
  const record = await store.get(key, { type: 'json' });
  if (!record) return null;
  if (Array.isArray(record.members)) return record;
  if (!record.username || !record.password) return record; // malformed/unexpected shape — leave as-is
  const { username, password, defaultLanguage, ...rest } = record;
  const migrated = {
    ...rest,
    members: [{ username, passwordHash: hashPassword(password), role: 'full', defaultLanguage: defaultLanguage || null, createdAt: record.createdAt || new Date().toISOString() }]
  };
  await store.setJSON(key, migrated);
  return migrated;
}

function stripHashes(record) {
  if (!record) return record;
  const { members, ...rest } = record;
  // The authenticator holds a shared secret — anyone who reads it can mint valid codes for that
  // account forever. It is removed alongside the password hash, and replaced by the only thing a
  // caller legitimately needs: whether that person has finished setting one up.
  //
  // Through publicRecord rather than naming the field here. A local copy of that name is exactly
  // what leaked: the field was renamed to reset every authenticator, this copy was not, and from
  // then on every listing carried the live secret and reported nobody as enrolled.
  return { ...rest, members: (members || []).map(publicRecord) };
}

function findMember(record, username) {
  // record can be null here — store.list() occasionally returns a key whose store.get() hasn't
  // caught up yet (Netlify Blobs eventual consistency) — treat that the same as "no match".
  return record && (record.members || []).find(m => m.username === username);
}






export default async (request, context) => {
  const store = getStore('hieronymus-intake-codes');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Creating customers and adding users to them are staff actions. Neither branch below checked
    // anything at all. `addMember` was the worst hole in the app: anyone could add a user with a
    // password of their choosing to any existing customer, log in as it, and be walked through
    // enrolling their own authenticator — arriving as a fully legitimate user of that customer, with
    // two-factor, having started with nothing.
    const createDenied = await requireStaffAdmin(url, body, json);
    if (createDenied) return createDenied;

    // Adding a member to an EXISTING company group.
    if (body.addMember) {
      const groupKey = slugify(body.company || '');
      const record = await loadGroup(store, groupKey);
      if (!record) return json({ error: 'Unknown company' }, 404);
      const username = (body.username || '').trim().toLowerCase();
      const password = (body.password || '').trim();
      const role = body.role === 'viewer' ? 'viewer' : 'full';
      if (!username || !password) return json({ error: 'Missing username or password' }, 400);
      if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
      const { blobs } = await store.list();
      const allGroups = await Promise.all(blobs.map(b => loadGroup(store, b.key)));
      if (allGroups.some(g => findMember(g, username))) return json({ error: 'That username is already taken' }, 409);
      record.members = record.members || [];
      record.members.push({ username, passwordHash: hashPassword(password), role, defaultLanguage: null, createdAt: new Date().toISOString() });
      await store.setJSON(groupKey, record);
      return json({ username, password }, 200);
    }

    // Creating a brand-new company group, with its first ("owner") member.
    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    const groupKey = slugify(company);
    if (await store.get(groupKey)) {
      return json({ error: 'A customer with this name already exists.' }, 409);
    }
    const username = groupKey;
    const password = genPassword();
    await store.setJSON(groupKey, {
      company, createdAt: new Date().toISOString(), submittedAt: null, monitoringEnabled: false,
      members: [{ username, passwordHash: hashPassword(password), role: 'full', defaultLanguage: null, createdAt: new Date().toISOString() }]
    });
    return json({ username, password }, 200);
  }

  if (request.method === 'GET') {
    // Order matters: a scoped read carries username+password as well as company, so the company
    // form has to be recognised before the login form or it would be answered as a login.
    const companyParam = url.searchParams.get('company');

    if (companyParam) {
      // Staff, or the customer this record belongs to. The company comes from the session, so
      // editing ?company= yields a refusal rather than a competitor's record.
      const denied = await requireCompany(url, null, json, companyParam);
      if (denied) return denied;
      const record = await loadGroup(store, slugify(companyParam));
      if (!record) return json({ error: 'Unknown company' }, 404);
      return json(stripHashes(record), 200);
    }

    // Signing in lives in /api/login now — one login for staff and customers, which is where the
    // code is checked and the session is issued. This endpoint manages customer records.
    //
    // The full list names every customer, so it is staff-only.
    const deniedList = await requireStaff(url, null, json);
    if (deniedList) return deniedList;

    const { blobs } = await store.list();
    // store.list() can momentarily include a key whose store.get() hasn't caught up yet
    // (Netlify Blobs eventual consistency, most visible right after creating a new customer) —
    // drop any not-yet-readable entries rather than crashing the whole listing on them.
    const items = (await Promise.all(blobs.map(async b => stripHashes(await loadGroup(store, b.key))))).filter(Boolean);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json({ items }, 200);
  }

  if (request.method === 'PATCH') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Releasing a dashboard, toggling monitoring, resetting a customer's password — all reachable
    // with a staff password, so all need the ticket that proves a code was entered.
    // Who is calling, once. The branches below are a mix of staff-admin actions (monitoring,
    // releasing a dashboard, resetting a member's password) and a customer's own account settings,
    // so each says which it needs rather than the shape of the request implying it.
    const caller = await callerOf(url, body);
    if (!caller) return json({ error: 'Sign in to continue.', needsSignIn: true }, 401);
    const isAdmin = caller.kind === 'staff' && caller.role === 'admin';

    // Scheduling monitoring is a company-wide setting, not tied to any one member's login —
    // staff-only, verified the same way an admin password reset is.
    if (body.company && (typeof body.monitoringCadence === 'string' || Number.isInteger(body.monitoringIntervalDays))) {
      const ok = isAdmin;
      if (!ok) return json({ error: 'Only a staff admin can configure monitoring' }, 403);
      const groupKey = slugify(body.company);
      const record = await loadGroup(store, groupKey);
      if (!record) return json({ error: 'Unknown company' }, 404);
      // Configuring implies monitoring is on unless the caller explicitly turns it off.
      const enabled = body.monitoringEnabled !== false;
      record.monitoringEnabled = enabled;
      if (typeof body.monitoringCadence === 'string') {
        const cadence = ['weekly', 'semimonthly', 'monthly', 'quarterly'].includes(body.monitoringCadence) ? body.monitoringCadence : 'monthly';
        const startDate = body.monitoringStartDate || new Date().toISOString().slice(0, 10);
        record.monitoringCadence = cadence;
        record.monitoringStartDate = startDate;
        delete record.monitoringIntervalDays; // cadence supersedes the legacy fixed-day interval
        record.nextRunAt = enabled ? computeNextRun(startDate, cadence, Date.now()) : null;
      } else {
        const days = body.monitoringIntervalDays;
        record.monitoringIntervalDays = days;
        record.nextRunAt = enabled ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
      }
      await store.setJSON(groupKey, record);
      return json({ status: 'ok', nextRunAt: record.nextRunAt, monitoringEnabled: enabled }, 200);
    }

    // Releasing a dashboard to the customer is a staff decision, gated exactly like the monitoring
    // schedule above. Two independent switches on purpose: a customer usually gets their diagnosis
    // well before monitoring is set up, and having a run in the database is not the same thing as
    // being ready to show it to them.
    if (body.company && (typeof body.diagnosisReleased === 'boolean' || typeof body.monitoringReleased === 'boolean')) {
      const ok = isAdmin;
      if (!ok) return json({ error: 'Only a staff admin can release a dashboard' }, 403);
      const groupKey = slugify(body.company);
      const record = await loadGroup(store, groupKey);
      if (!record) return json({ error: 'Unknown company' }, 404);
      const who = caller.username;
      const now = new Date().toISOString();
      if (typeof body.diagnosisReleased === 'boolean') {
        record.diagnosisReleased = body.diagnosisReleased;
        record.diagnosisReleasedAt = body.diagnosisReleased ? now : null;
        record.diagnosisReleasedBy = body.diagnosisReleased ? who : null;
      }
      if (typeof body.monitoringReleased === 'boolean') {
        record.monitoringReleased = body.monitoringReleased;
        record.monitoringReleasedAt = body.monitoringReleased ? now : null;
        record.monitoringReleasedBy = body.monitoringReleased ? who : null;
      }
      await store.setJSON(groupKey, record);
      return json({
        status: 'ok',
        diagnosisReleased: !!record.diagnosisReleased,
        monitoringReleased: !!record.monitoringReleased
      }, 200);
    }

    const username = (body.username || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);
    const { blobs } = await store.list();
    const groups = await Promise.all(blobs.map(async b => ({ key: b.key, data: await loadGroup(store, b.key) })));
    const entry = groups.find(g => findMember(g.data, username));
    if (!entry) return json({ error: 'Invalid username' }, 404);
    const member = findMember(entry.data, username);

    // Admin-driven reset: no knowledge of the old password required, but the requester must
    // prove they're an existing staff admin.
    if (body.adminReset) {
      const ok = isAdmin;
      if (!ok) return json({ error: 'Only a staff admin can reset a member\'s password' }, 403);
      const np = (body.newPassword || '').trim();
      if (np.length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
      member.passwordHash = hashPassword(np);
      await store.setJSON(entry.key, entry.data);
      return json({ status: 'ok' }, 200);
    }

    // A customer changing their own password or language. Two things are required: the session must
    // belong to that member (so one customer cannot change another's), and the current password must
    // be right (so a borrowed session cannot lock the owner out of their own account).
    if (typeof body.newPassword === 'string' || typeof body.defaultLanguage === 'string') {
      if (!(caller.kind === 'customer' && caller.username === member.username)) {
        return json({ error: 'Not authorised to change this account' }, 403);
      }
      // Changing the password needs the current one as well as the session, so a borrowed session
      // cannot lock the owner out of their own account. A language preference is not worth a
      // password prompt, and nothing is stored in the browser for one to be read from any more.
      if (typeof body.newPassword === 'string'
          && !verifyPassword(body.currentPassword || '', member.passwordHash)) {
        return json({ error: 'Current password is incorrect' }, 401);
      }
      if (typeof body.newPassword === 'string') {
        const np = body.newPassword.trim();
        if (np.length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
        member.passwordHash = hashPassword(np);
      }
      if (typeof body.defaultLanguage === 'string' && ['en', 'es'].includes(body.defaultLanguage)) {
        member.defaultLanguage = body.defaultLanguage;
      }
    }

    // These two fell off the end of the branch chain with nothing checking them. Marking an intake
    // submitted is the customer's own action; turning monthly monitoring on is a staff one that
    // spends API credit every month, and the real caller in index.html sends a cadence and so lands
    // in the guarded branch above — but a bare request could reach here and flip it for anyone.
    if (body.markSubmitted || typeof body.monitoringEnabled === 'boolean') {
      const asMember = caller.kind === 'customer' && caller.username === member.username;
      const asStaffAdmin = isAdmin;
      if (typeof body.monitoringEnabled === 'boolean' && !asStaffAdmin) {
        return json({ error: 'Only a staff admin can change monthly monitoring' }, 403);
      }
      if (body.markSubmitted && !asMember && !asStaffAdmin) {
        return json({ error: 'Not authorised to mark this intake submitted' }, 403);
      }
    }

    if (body.markSubmitted) entry.data.submittedAt = new Date().toISOString();
    if (typeof body.monitoringEnabled === 'boolean') entry.data.monitoringEnabled = body.monitoringEnabled;
    await store.setJSON(entry.key, entry.data);
    return json({ status: 'ok' }, 200);
  }

  if (request.method === 'DELETE') {
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);

    // This branch had NO authorisation of any kind: anyone who named a username could delete an
    // entire customer — their intake, their prompt set, their whole record — or quietly remove one
    // member. Found while auditing the login path. Staff admin, with the two-factor ticket, like
    // every other destructive action.
    const delDenied = await requireStaffAdmin(url, null, json);
    if (delDenied) return delDenied;

    // Removing a single member from their group (leaves the group and other members intact).
    if (url.searchParams.get('memberOnly') === 'true') {
      const { blobs } = await store.list();
      const groups = await Promise.all(blobs.map(async b => ({ key: b.key, data: await loadGroup(store, b.key) })));
      const entry = groups.find(g => findMember(g.data, username));
      if (!entry) return json({ error: 'Unknown username' }, 404);
      entry.data.members = entry.data.members.filter(m => m.username !== username);
      await store.setJSON(entry.key, entry.data);
      return json({ status: 'ok' }, 200);
    }

    // Otherwise, delete the whole company group (matches the old behavior — DELETE by the
    // owner/original username removed the entire customer record).
    await store.delete(username);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
