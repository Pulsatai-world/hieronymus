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
    await store.setJSON(key, { company, intake, savedAt: new Date().toISOString() });
    return json({ status: 'ok', key }, 200);
  }

  if (request.method === 'GET') {
    const companyParam = url.searchParams.get('company');

    if (companyParam) {
      const data = await store.get(slugify(companyParam), { type: 'json' });
      if (!data) return json({ error: 'Not found' }, 404);
      return json(data, 200);
    }

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
