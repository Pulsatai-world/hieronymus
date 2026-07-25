import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// which engines a customer has keys configured for is customer-identifying, and every caller of this endpoint is an internal page — so it is
// staff-only rather than open. Same check the other scoped endpoints use.
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
async function isStaff(username, password) {
  if (!username || !password) return false;
  const record = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' });
  if (!record) return false;
  return verifyPassword(password, record.passwordHash);
}


// Raw key values are never returned by this endpoint under any query, ever — only ever read
// internally (server-to-server, via getStore() directly) by run-audit-background.js. Any GET
// or POST response only ever reports whether a key is configured, never its value. Keys can
// be set at customer creation and updated later (e.g. from the Hieronymus page) — a POST here
// always overwrites, per-engine, whichever key values are provided.

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request, context) => {
  const store = getStore('hieronymus-customer-keys');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    const key = slugify(company);
    const existing = (await store.get(key, { type: 'json' })) || { company };
    // A field left blank means "leave this key unchanged" (undefined) — but an explicit null
    // means "clear this key entirely" (e.g. the customer wants an engine to stop being usable
    // for Run Audit without providing a replacement key, such as after an unexpected bill).
    ['claude', 'chatgpt', 'gemini'].forEach(engine => {
      if (body[engine] === null) {
        delete existing[engine];
      } else if (typeof body[engine] === 'string' && body[engine].trim()) {
        existing[engine] = body[engine].trim();
      }
    });
    existing.company = company;
    existing.updatedAt = new Date().toISOString();
    await store.setJSON(key, existing);

    return json({
      status: 'ok',
      claude: !!existing.claude,
      chatgpt: !!existing.chatgpt,
      gemini: !!existing.gemini
    }, 200);
  }

  if (request.method === 'GET') {
    if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'))) {
      return json({ error: 'Staff credentials required' }, 403);
    }
    const companyParam = url.searchParams.get('company');
    if (!companyParam) return json({ error: 'Missing company param' }, 400);
    const data = await store.get(slugify(companyParam), { type: 'json' });
    return json({
      claude: !!data?.claude,
      chatgpt: !!data?.chatgpt,
      gemini: !!data?.gemini,
      updatedAt: data?.updatedAt || null
    }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
