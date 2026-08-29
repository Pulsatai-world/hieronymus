import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// "Viewer" members of a company group can look at the intake form but not submit/edit it — an
// internal staff request has no member credentials to check, so it's allowed through unchanged.
async function isBlockedViewer(requestingUsername, requestingPassword) {
  if (!requestingUsername) return false;
  const codesStore = getStore('hieronymus-intake-codes');
  const { blobs } = await codesStore.list();
  const groups = await Promise.all(blobs.map(b => codesStore.get(b.key, { type: 'json' })));
  for (const g of groups) {
    const member = (g.members || []).find(m => m.username === requestingUsername);
    if (member) {
      if (!verifyPassword(requestingPassword || '', member.passwordHash)) return true;
      return member.role === 'viewer';
    }
  }
  return false;
}

// The intake questionnaire is the most sensitive record in the system — competitors, personas, client
// names, pricing context, the lot. GET was unauthenticated, so any caller could read any customer's
// answers by naming their company. These mirror the checks results.js uses.
async function memberOfCompany(company, username, password) {
  if (!company || !username || !password) return false;
  const group = await getStore('hieronymus-intake-codes').get(slugify(company), { type: 'json' });
  if (!group) return false;
  const member = (group.members || []).find(m => m.username === String(username).toLowerCase());
  if (!member) return false;
  return verifyPassword(password, member.passwordHash);
}

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

async function isStaff(username, password, token) {
  if (await staffFromToken(token)) return true;
  if (!username || !password) return false;
  const record = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
}

// Two events settle the answers: the customer approving the prompt set generated from them, and an
// audit having actually run against those prompts. After either, editing the intake would leave the
// prompts — and any results already collected — describing a business the form no longer matches.
async function intakeLock(company) {
  const key = slugify(company);
  const prompts = await getStore('hieronymus-prompts').get(key, { type: 'json' });
  if (prompts && prompts.approvedAt) return { locked: true, reason: 'prompts-approved', at: prompts.approvedAt };

  // Results are the ground truth for "an audit has run" — a job record can be cleared, rows cannot.
  const rowsStore = getStore('hieronymus-results-rows');
  const { blobs } = await rowsStore.list();
  const want = String(company || '').trim().toLowerCase();
  for (const b of blobs) {
    const row = await rowsStore.get(b.key, { type: 'json' });
    if (row && String(row.brand || '').toLowerCase() === want) {
      return { locked: true, reason: 'audit-run', at: row.snapshot_date || null };
    }
  }
  return { locked: false, reason: null, at: null };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request, context) => {
  const store = getStore('hieronymus-intake');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const intake = body.intake ?? body;
    const company = (body.company || intake?.general?.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    if (body.requestingUsername && await isBlockedViewer(body.requestingUsername, body.requestingPassword)) {
      return json({ error: 'Viewer accounts cannot submit or edit the intake form' }, 403);
    }

    const key = slugify(company);

    // Once the customer has approved their prompt set, the intake behind it is frozen for them.
    // The prompts were derived from these answers, so editing them afterwards leaves an approved
    // prompt set describing a business the form no longer matches — and the audit then runs against
    // a premise nobody actually approved. Staff requests carry no member credentials (the same
    // convention isBlockedViewer relies on) and are still allowed through, so corrections remain
    // possible on our side.
    if (body.requestingUsername) {
      const lock = await intakeLock(company);
      if (lock.locked) {
        return json({
          error: lock.reason === 'audit-run'
            ? 'These answers are locked because an audit has already run against them. Contact us if something needs to change.'
            : 'These answers are locked because the prompts generated from them have already been approved. Contact us if something needs to change.',
          lockedBy: lock.reason,
          lockedAt: lock.at
        }, 409);
      }
    }
    await store.setJSON(key, { company, intake, savedAt: new Date().toISOString() });
    return json({ status: 'ok', key }, 200);
  }

  if (request.method === 'GET') {
    const companyParam = url.searchParams.get('company');
    const staff = await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'));

    if (companyParam) {
      // A customer may read only their own answers, proven against the company they asked for, so
      // renaming the parameter yields 403 rather than someone else's questionnaire.
      const member = await memberOfCompany(companyParam, url.searchParams.get('username'), url.searchParams.get('password'));
      if (!staff && !member) return json({ error: 'Not authorised to read this intake' }, 403);
      const data = await store.get(slugify(companyParam), { type: 'json' });
      if (!data) return json({ error: 'Not found' }, 404);
      // Reported here so the form and the save guard can never disagree about whether it is editable.
      const lock = await intakeLock(companyParam);
      return json({ ...data, locked: lock.locked, lockedBy: lock.reason, lockedAt: lock.at }, 200);
    }

    // The full list names every customer, so it is staff-only.
    if (!staff) return json({ error: 'Listing intakes requires staff credentials' }, 403);

    const { blobs } = await store.list();
    const items = await Promise.all(blobs.map(async b => {
      const data = await store.get(b.key, { type: 'json' });
      return { key: b.key, company: data?.company || b.key, savedAt: data?.savedAt || null };
    }));
    items.sort((a, b) => a.company.localeCompare(b.company));
    return json({ items }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
