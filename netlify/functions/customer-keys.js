import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireTwoFactorProof } from './lib/two-factor-gate.js';

// which engines a customer has keys configured for is customer-identifying, and every caller of this endpoint is an internal page — so it is
// staff-only rather than open. Same check the other scoped endpoints use.
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
// Sessions minted before this cutoff are dead. It is the moment two-factor was deployed, not a
// round date: a staff token lasts 30 days and the code running before this deploy minted them with
// no second factor, so anyone holding one would have skipped enrollment for up to a month. Set to
// the deploy itself so every session that predates two-factor ends with it.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');

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
    if (!company) return json({ error: 'Missing company name' }, 400);

    // This endpoint takes its staff credentials in the BODY, which the top-of-handler check cannot
    // see — it runs before there is a body to read. Without this line a stolen staff password could
    // still swap in an attacker's engine key, which is exactly what the suite caught.
    const bodyDenied = await requireTwoFactorProof(url, body, json);
    if (bodyDenied) return bodyDenied;

    // Staff only. This POST sets the engine API keys a customer's audit runs are billed against, and
    // it answered anyone who named a company — so a stranger could swap in their own key, point a
    // customer's runs at it, or blank an engine out. Same rule POST /api/results already follows:
    // every caller here is an internal page, so there is nobody legitimate to lock out.
    if (!await isStaff(body.staffUsername || url.searchParams.get('staffUsername'),
                       body.staffPassword || url.searchParams.get('staffPassword'),
                       body.staffToken || url.searchParams.get('staffToken'))) {
      return json({ error: 'Staff credentials required' }, 403);
    }

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
    if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
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
