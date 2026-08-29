import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireStaff } from './lib/authorize.js';

// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
// Sessions minted before this cutoff are dead. It is the moment two-factor was deployed, not a
// round date: a staff token lasts 30 days and the code running before this deploy minted them with
// no second factor, so anyone holding one would have skipped enrollment for up to a month. Set to
// the deploy itself so every session that predates two-factor ends with it.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');




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

    // Staff only. This POST sets the engine API keys a customer's audit runs are billed against, and
    // it answered anyone who named a company — so a stranger could swap in their own key, point a
    // customer's runs at it, or blank an engine out. Same rule POST /api/results already follows:
    // every caller here is an internal page, so there is nobody legitimate to lock out.
    const denied = await requireStaff(url, null, json);
    if (denied) return denied;

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
    const denied2 = await requireStaff(url, null, json);
    if (denied2) return denied2;
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
