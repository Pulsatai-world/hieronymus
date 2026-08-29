import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { callerOf, requireCompany, requireStaff } from './lib/authorize.js';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
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
// Sessions minted before this cutoff are dead. It is the moment two-factor was deployed, not a
// round date: a staff token lasts 30 days and the code running before this deploy minted them with
// no second factor, so anyone holding one would have skipped enrollment for up to a month. Set to
// the deploy itself so every session that predates two-factor ends with it.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');




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

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const deniedPost = await requireStaff(url, body, json);
    if (deniedPost) return deniedPost;
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

      const denied = await requireCompany(url, null, json, companyParam);
      if (denied) return denied;
      const caller = await callerOf(url, null);
      const staff = caller.kind === 'staff';
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
    const deniedList = await requireStaff(url, null, json);
    if (deniedList) return deniedList;
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

    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    // Staff, or the customer this set belongs to.
    const denied = await requireCompany(url, body, json, company);
    if (denied) return denied;
    const caller = await callerOf(url, body);
    const asMember = caller.kind === 'customer';

    // A viewer may read the prompts but not approve or edit them. The role is on the session.
    if (asMember && caller.role === 'viewer') {
      return json({ error: 'Viewer accounts cannot approve or edit prompts' }, 403);
    }

    const key = slugify(company);
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ error: 'No generated prompts found for this customer' }, 404);

    // ── Internal release ──
    // An Akore reviewer releasing the prompts to the customer. Separate from the customer's own
    // approval below and never reachable with customer credentials.
    if (body.internalApprove) {
      if (asMember) {
        return json({ error: 'Only a signed-in Akore staff user can release prompts to a customer' }, 403);
      }
      const staffUsername = caller.username;
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

    // Approval is one-way for the customer. Staff are still allowed through so they can revise and
    // re-approve on a customer's behalf.
    if (data.approvedAt && asMember) {
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
