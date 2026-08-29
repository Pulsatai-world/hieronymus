import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireTwoFactorProof } from './lib/two-factor-gate.js';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// "Viewer" members of a company group can look at prompts but not approve/edit them — this
// is the one server-enforced boundary for that role (an internal staff request has no
// member credentials to check, so it's allowed through unchanged).
async function isBlockedViewer(requestingUsername, requestingPassword) {
  if (!requestingUsername) return false;
  const codesStore = getStore('hieronymus-intake-codes');
  const { blobs } = await codesStore.list();
  const groups = await Promise.all(blobs.map(b => codesStore.get(b.key, { type: 'json' })));
  for (const g of groups) {
    const member = (g.members || []).find(m => m.username === requestingUsername);
    if (member) {
      if (!verifyPassword(requestingPassword || '', member.passwordHash)) return true; // bad creds — block
      return member.role === 'viewer';
    }
  }
  return false;
}

// Generated prompts are held back from the customer until someone on the internal Akore team has
// reviewed and released them. This has to be enforced here rather than in the browser: the
// customer holds a working review link, so they can call this endpoint directly, and a gate that
// only exists in prompt-review.html would be no gate at all. Staff prove who they are the same
// way every other staff action in this app does — by sending their own username+password for
// server-side verification against the staff registry.
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
  const staffStore = getStore('hieronymus-staff-users');
  const record = await staffStore.get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
}

// A customer may read their own prompt set. Previously any caller could read any customer's
// released prompts by naming their company, and the parameterless list named every customer.
async function memberOfCompany(company, username, password) {
  if (!company || !username || !password) return false;
  const group = await getStore('hieronymus-intake-codes').get(slugify(company), { type: 'json' });
  if (!group) return false;
  const member = (group.members || []).find(m => m.username === String(username).toLowerCase());
  if (!member) return false;
  return verifyPassword(password, member.passwordHash);
}

// The brief is internal working material from the generator (competitor lists, the
// "facts a searcher could not know" exclusion list) — it is never part of a client response.
function withoutInternals(data) {
  const { brief, ...rest } = data;
  return rest;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request, context) => {
  const store = getStore('hieronymus-prompts');
  const url = new URL(request.url);

  // Every credential this endpoint accepts must now be backed by two-factor: a customer password
  // needs the ticket issued when their code was accepted, and a staff password needs the same. A
  // staff session token is proof on its own. Without this, two-factor guarded the login pages while
  // this endpoint still answered anyone holding a password.
  const proofDenied = await requireTwoFactorProof(url, null, json);
  if (proofDenied) return proofDenied;

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const company = (body.company || '').trim();
    const promptsText = body.promptsText || '';
    if (!company) return json({ error: 'Missing company name' }, 400);
    if (!promptsText.trim()) return json({ error: 'Missing prompts text' }, 400);

    const key = slugify(company);
    await store.setJSON(key, { company, promptsText, generatedAt: new Date().toISOString() });
    return json({ status: 'ok' }, 200);
  }

  if (request.method === 'GET') {
    const companyParam = url.searchParams.get('company');
    if (companyParam) {
      const data = await store.get(slugify(companyParam), { type: 'json' });
      if (!data) return json({ error: 'Not found' }, 404);

      const staff = await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'));
      const member = await memberOfCompany(companyParam, url.searchParams.get('username'), url.searchParams.get('password'));
      if (!staff && !member) return json({ error: 'Not authorised to read prompts for this customer' }, 403);
      // Records the customer already approved predate this gate — they have demonstrably seen the
      // prompts, so treating them as unreleased would lock a live customer out of their own
      // review page for no benefit. Grandfather them in.
      const released = !!data.internalApprovedAt || !!data.approvedAt;
      if (staff) return json({ ...data, internalReviewPending: !released }, 200);

      // Not a verified staff request: withhold the prompts themselves until they're released, but
      // still report that they exist so the client page can say "not ready yet" rather than
      // showing a bare error. Note run-audit-background.js reads this store directly via
      // getStore(), so gating here never blocks an audit run.
      if (!released) {
        const { promptsText, ...rest } = withoutInternals(data);
        return json({ ...rest, internalReviewPending: true, promptCount: String(promptsText || '').split('\n').filter(l => l.trim()).length }, 200);
      }
      return json({ ...withoutInternals(data), internalReviewPending: false }, 200);
    }
    if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
      return json({ error: 'Listing prompt sets requires staff credentials' }, 403);
    }
    const { blobs } = await store.list();
    const items = await Promise.all(blobs.map(async b => {
      const data = await store.get(b.key, { type: 'json' });
      return {
        key: b.key,
        company: data?.company,
        generatedAt: data?.generatedAt || null,
        approvedAt: data?.approvedAt || null,
        internalApprovedAt: data?.internalApprovedAt || null,
        internalApprovedBy: data?.internalApprovedBy || null
      };
    }));
    return json({ items }, 200);
  }

  if (request.method === 'PATCH') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Credentials in the body need the same two-factor proof as those in the query string —
    // otherwise a stolen password could still overwrite an intake or approve a prompt set.
    const bodyDenied = await requireTwoFactorProof(url, body, json);
    if (bodyDenied) return bodyDenied;
    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    if (body.requestingUsername && await isBlockedViewer(body.requestingUsername, body.requestingPassword)) {
      return json({ error: 'Viewer accounts cannot approve or edit prompts' }, 403);
    }

    const key = slugify(company);
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ error: 'No generated prompts found for this customer' }, 404);

    // ── Internal release ──
    // An Akore reviewer releasing the prompts to the customer. Separate from the customer's own
    // approval below and never reachable with customer credentials.
    if (body.internalApprove) {
      const staffUsername = (body.requestingStaffUsername || '').trim().toLowerCase();
      if (!await isStaff(staffUsername, body.requestingStaffPassword, body.staffToken || url.searchParams.get('staffToken'))) {
        return json({ error: 'Only a signed-in Akore staff user can release prompts to a customer' }, 403);
      }
      if (typeof body.promptsText === 'string' && body.promptsText.trim()) {
        data.promptsText = body.promptsText.trim();
        data.editedAt = new Date().toISOString();
      }
      data.internalApprovedAt = new Date().toISOString();
      data.internalApprovedBy = staffUsername;
      await store.setJSON(key, data);
      return json({ status: 'ok', internalApprovedAt: data.internalApprovedAt, internalApprovedBy: staffUsername }, 200);
    }

    // ── Customer approval ──
    // Refused until the prompts have been released internally, so a customer holding a stale tab
    // (or calling the endpoint directly) can't approve a set they were never meant to see yet.
    // `approvedAt` grandfathers pre-gate records, matching the GET above.
    if (!data.internalApprovedAt && !data.approvedAt) {
      return json({ error: 'These prompts are still in internal review and cannot be approved yet' }, 409);
    }

    // Approval is one-way for the customer. Staff requests carry no member credentials (the same
    // convention isBlockedViewer relies on) and are still allowed through, so staff can revise and
    // re-approve on a customer's behalf.
    if (data.approvedAt && body.requestingUsername) {
      return json({ error: 'These prompts have already been approved and cannot be approved again' }, 409);
    }

    if (typeof body.promptsText === 'string' && body.promptsText.trim()) {
      data.promptsText = body.promptsText.trim();
      data.editedAt = new Date().toISOString();
    }
    data.approvedAt = new Date().toISOString();
    data.comments = typeof body.comments === 'string' ? body.comments.trim() : '';
    await store.setJSON(key, data);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
