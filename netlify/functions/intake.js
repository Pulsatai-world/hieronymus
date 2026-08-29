import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { callerOf, requireCompany, requireStaff } from './lib/authorize.js';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}




// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
// Sessions minted before this cutoff are dead. It is the moment two-factor was deployed, not a
// round date: a staff token lasts 30 days and the code running before this deploy minted them with
// no second factor, so anyone holding one would have skipped enrollment for up to a month. Set to
// the deploy itself so every session that predates two-factor ends with it.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');



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

    // Staff, or the customer this company belongs to. The session says which. There is no request
    // shape that means "trust me" — an empty-handed request used to mean exactly that, which made it
    // the most privileged kind and let anyone overwrite any customer's answers.
    const denied = await requireCompany(url, body, json, company);
    if (denied) return denied;
    const caller = await callerOf(url, body);
    const asMember = caller.kind === 'customer';

    // A viewer may look but not edit. The role travels on the session, so this is a comparison
    // rather than another password check against a record.
    if (asMember && caller.role === 'viewer') {
      return json({ error: 'Viewer accounts cannot submit or edit the intake form' }, 403);
    }

    const key = slugify(company);

    // Once the customer has approved their prompt set, the intake behind it is frozen for them.
    // The prompts were derived from these answers, so editing them afterwards leaves an approved
    // prompt set describing a business the form no longer matches — and the audit then runs against
    // a premise nobody actually approved. Staff are still allowed through so corrections remain
    // possible on our side — keyed on who the session says is acting, not on which credentials
    // happen to be absent.
    if (asMember) {
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

    if (companyParam) {
      // A customer may read only their own answers: the company comes from their session, so
      // renaming the parameter yields a refusal rather than someone else's questionnaire.
      const denied = await requireCompany(url, null, json, companyParam);
      if (denied) return denied;
      const data = await store.get(slugify(companyParam), { type: 'json' });
      if (!data) return json({ error: 'Not found' }, 404);
      // Reported here so the form and the save guard can never disagree about whether it is editable.
      const lock = await intakeLock(companyParam);
      return json({ ...data, locked: lock.locked, lockedBy: lock.reason, lockedAt: lock.at }, 200);
    }

    // The full list names every customer, so it is staff-only.
    const deniedList = await requireStaff(url, null, json);
    if (deniedList) return deniedList;

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
