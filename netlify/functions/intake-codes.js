import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
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
  return { ...rest, members: (members || []).map(({ passwordHash, ...m }) => m) };
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
      return json({
        username: member.username, role: member.role, defaultLanguage: member.defaultLanguage || null,
        company: group.company, submittedAt: group.submittedAt, monitoringEnabled: group.monitoringEnabled
      }, 200);
    }
    const companyParam = url.searchParams.get('company');
    if (companyParam) {
      const record = await loadGroup(store, slugify(companyParam));
      if (!record) return json({ error: 'Unknown company' }, 404);
      return json(stripHashes(record), 200);
    }
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
    if (body.company && Number.isInteger(body.monitoringIntervalDays)) {
      const ok = await requireStaffAdmin(body.requestingStaffUsername, body.requestingStaffPassword);
      if (!ok) return json({ error: 'Only a staff admin can schedule monitoring' }, 403);
      const groupKey = slugify(body.company);
      const record = await loadGroup(store, groupKey);
      if (!record) return json({ error: 'Unknown company' }, 404);
      const days = body.monitoringIntervalDays;
      record.monitoringEnabled = true;
      record.monitoringIntervalDays = days;
      record.nextRunAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await store.setJSON(groupKey, record);
      return json({ status: 'ok', nextRunAt: record.nextRunAt }, 200);
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
