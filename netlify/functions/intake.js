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

async function isStaff(username, password) {
  if (!username || !password) return false;
  const record = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
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
      const promptsRecord = await getStore('hieronymus-prompts').get(key, { type: 'json' });
      if (promptsRecord && promptsRecord.approvedAt) {
        return json({
          error: 'These answers are locked because the prompts generated from them have already been approved. Contact us if something needs to change.',
          lockedBy: 'prompts-approved',
          approvedAt: promptsRecord.approvedAt
        }, 409);
      }
    }
    await store.setJSON(key, { company, intake, savedAt: new Date().toISOString() });
    return json({ status: 'ok', key }, 200);
  }

  if (request.method === 'GET') {
    const companyParam = url.searchParams.get('company');
    const staff = await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'));

    if (companyParam) {
      // A customer may read only their own answers, proven against the company they asked for, so
      // renaming the parameter yields 403 rather than someone else's questionnaire.
      const member = await memberOfCompany(companyParam, url.searchParams.get('username'), url.searchParams.get('password'));
      if (!staff && !member) return json({ error: 'Not authorised to read this intake' }, 403);
      const data = await store.get(slugify(companyParam), { type: 'json' });
      if (!data) return json({ error: 'Not found' }, 404);
      return json(data, 200);
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
