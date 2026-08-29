import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { totpGate, verifyTotp, newSecret, otpauthUri, mintTfaToken } from './lib/two-factor-gate.js';

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
  // `totp` holds the authenticator's shared secret — anyone who reads it can mint valid codes for
  // that account forever. It is removed here alongside the password hash, and replaced by the only
  // thing a caller legitimately needs: whether the person has finished setting one up.
  return {
    ...rest,
    members: (members || []).map(({ passwordHash, totp, ...m }) => ({
      ...m, twoFactorEnabled: !!(totp && totp.enabledAt)
    }))
  };
}

function findMember(record, username) {
  // record can be null here — store.list() occasionally returns a key whose store.get() hasn't
  // caught up yet (Netlify Blobs eventual consistency) — treat that the same as "no match".
  return record && (record.members || []).find(m => m.username === username);
}

// Lets an admin reset a customer member's password without knowing the old one — the member's
// own self-service change (below) still requires their current password; this is the separate,
// staff-only path for when a customer forgets/loses theirs.
async function requireStaffAdmin(requestingUsername, requestingPassword) {
  if (!requestingUsername || !requestingPassword) return false;
  const usersStore = getStore('hieronymus-staff-users');
  const record = await usersStore.get(String(requestingUsername).toLowerCase(), { type: 'json' });
  if (!record || record.role !== 'admin') return false;
  return verifyPassword(requestingPassword, record.passwordHash);
}

// Reads of the registry are scoped. The ?username=&password= form is the LOGIN for all three
// client-facing pages and stays open by necessity — it is itself a credential check. The other two
// forms were not: ?company= returned a customer's whole record (member usernames, roles, monitoring
// configuration, release flags) and the parameterless form listed every customer, both to anyone.
// Note this is any-staff, not admin-only: looking is not a mutation.
// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
// Sessions minted before this cutoff are dead: two-factor became mandatory, and a token issued
// under the old password-only login would otherwise let someone skip enrollment for up to 30 days.
const SESSION_EPOCH = Date.parse('2026-08-28T00:00:00Z');

async function staffFromToken(token) {
  if (!token) return null;
  const s = await getStore('hieronymus-staff-sessions').get(String(token), { type: 'json' }).catch(() => null);
  if (!s || !s.username) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) return null;
  if (s.createdAt && Date.parse(s.createdAt) < SESSION_EPOCH) return null;
  return s.username;
}

async function isStaffReader(username, password, token) {
  if (await staffFromToken(token)) return true;
  if (!username || !password) return false;
  const record = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
}

async function isMemberOf(record, username, password) {
  if (!record || !username || !password) return false;
  const member = findMember(record, String(username).toLowerCase());
  if (!member) return false;
  return verifyPassword(password, member.passwordHash);
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
    const staffReader = await isStaffReader(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'));

    if (companyParam) {
      const record = await loadGroup(store, slugify(companyParam));
      if (!record) return json({ error: 'Unknown company' }, 404);
      // A customer may read their own company's record; anyone else needs staff credentials.
      const member = await isMemberOf(record, url.searchParams.get('username'), url.searchParams.get('password'));
      if (!staffReader && !member) return json({ error: 'Not authorised to read this customer record' }, 403);
      return json(stripHashes(record), 200);
    }

    const username = url.searchParams.get('username');
    if (username) {
      const password = url.searchParams.get('password');
      const { blobs } = await store.list();
      const groups = await Promise.all(blobs.map(b => loadGroup(store, b.key)));
      const group = groups.find(g => findMember(g, username.toLowerCase()));
      const member = group && findMember(group, username.toLowerCase());
      if (!group || !member || !password || !verifyPassword(password, member.passwordHash)) {
        return json({ error: 'Invalid username or password' }, 401);
      }

      // Same gate as staff. This endpoint is the login for all three client-facing pages, so putting
      // it here covers every customer entry point at once.
      const groupKey = slugify(group.company);
      const gateOpts = { username: member.username, token: url.searchParams.get('tfToken') };
      const gate = await totpGate(member, url.searchParams.get('code'), () => store.setJSON(groupKey, group), json, gateOpts);
      if (gate) return gate;
      // This trimmed payload is the ONLY thing client-portal.html sees on a real customer login, so
      // anything that page renders from must be here. The dashboard release flags were missing, which
      // meant a released dashboard stayed hidden for the customer while looking fine through the staff
      // bypass (that path reads the full record instead).
      return json({
        username: member.username, role: member.role, defaultLanguage: member.defaultLanguage || null,
        company: group.company, submittedAt: group.submittedAt,
        monitoringEnabled: !!group.monitoringEnabled,
        diagnosisReleased: !!group.diagnosisReleased,
        monitoringReleased: !!group.monitoringReleased,
        // Lets client-portal.html show the customer whether two-factor is on for their account.
        twoFactorEnabled: !!(member.totp && member.totp.enabledAt),
        // Present only on the request that actually verified a code; the pages keep it for the rest
        // of the session so page-to-page navigation doesn't ask again.
        ...(gateOpts.issued ? { tfToken: gateOpts.issued } : {})
      }, 200);
    }

    // Only the full list remains, and it names every customer — staff only. This guard must sit
    // AFTER the login form above: a customer signing in has no staff credentials, so guarding
    // earlier would refuse every client login.
    if (!staffReader) return json({ error: 'Listing customers requires staff credentials' }, 403);

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

    // Scheduling monitoring is a company-wide setting, not tied to any one member's login —
    // staff-only, verified the same way an admin password reset is.
    if (body.company && (typeof body.monitoringCadence === 'string' || Number.isInteger(body.monitoringIntervalDays))) {
      const ok = await requireStaffAdmin(body.requestingStaffUsername, body.requestingStaffPassword);
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
      const ok = await requireStaffAdmin(body.requestingStaffUsername, body.requestingStaffPassword);
      if (!ok) return json({ error: 'Only a staff admin can release a dashboard' }, 403);
      const groupKey = slugify(body.company);
      const record = await loadGroup(store, groupKey);
      if (!record) return json({ error: 'Unknown company' }, 404);
      const who = String(body.requestingStaffUsername || '').trim().toLowerCase();
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
      const ok = await requireStaffAdmin(body.requestingStaffUsername, body.requestingStaffPassword);
      if (!ok) return json({ error: 'Only a staff admin can reset a member\'s password' }, 403);
      const np = (body.newPassword || '').trim();
      if (np.length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);
      member.passwordHash = hashPassword(np);
      await store.setJSON(entry.key, entry.data);
      return json({ status: 'ok' }, 200);
    }

    // Customer-initiated self-service changes (password/language) require the current
    // password, since this endpoint has no other auth — staff-only fields below (markSubmitted,
    // monitoringEnabled) are called from the internal Portal and stay password-free as before.
    if (typeof body.newPassword === 'string' || typeof body.defaultLanguage === 'string') {
      if (!verifyPassword(body.currentPassword || '', member.passwordHash)) {
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

    if (body.markSubmitted) entry.data.submittedAt = new Date().toISOString();
    if (typeof body.monitoringEnabled === 'boolean') entry.data.monitoringEnabled = body.monitoringEnabled;
    await store.setJSON(entry.key, entry.data);
    return json({ status: 'ok' }, 200);
  }

  if (request.method === 'DELETE') {
    const username = (url.searchParams.get('username') || '').trim().toLowerCase();
    if (!username) return json({ error: 'Missing username' }, 400);

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
