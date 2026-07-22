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
      return json(data, 200);
    }
    const { blobs } = await store.list();
    const items = await Promise.all(blobs.map(async b => {
      const data = await store.get(b.key, { type: 'json' });
      return { key: b.key, company: data?.company, generatedAt: data?.generatedAt || null, approvedAt: data?.approvedAt || null };
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

    if (body.requestingUsername && await isBlockedViewer(body.requestingUsername, body.requestingPassword)) {
      return json({ error: 'Viewer accounts cannot approve or edit prompts' }, 403);
    }

    const key = slugify(company);
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ error: 'No generated prompts found for this customer' }, 404);

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
