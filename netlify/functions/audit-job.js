import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireTwoFactorProof } from './lib/two-factor-gate.js';

// a customer's audit run status is customer-identifying, and every caller of this endpoint is an internal page — so it is
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


function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

export default async (request) => {
  const url = new URL(request.url);

  // Every credential this endpoint accepts must now be backed by two-factor: a customer password
  // needs the ticket issued when their code was accepted, and a staff password needs the same. A
  // staff session token is proof on its own. Without this, two-factor guarded the login pages while
  // this endpoint still answered anyone holding a password.
  const proofDenied = await requireTwoFactorProof(url, null, json);
  if (proofDenied) return proofDenied;
  const company = url.searchParams.get('company');
  if (!company) return json({ error: 'Missing company param' }, 400);
  const store = getStore('hieronymus-audit-jobs');
  const key = slugify(company);

  if (request.method === 'GET') {
    if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
      return json({ error: 'Staff credentials required' }, 403);
    }
    const data = await store.get(key, { type: 'json' });
    if (!data) return json({ status: 'none' }, 200);
    return json(data, 200);
  }

  if (request.method === 'DELETE') {
    // This clears the displayed status only — it cannot actually kill an in-flight
    // background function invocation (Netlify has no API for that). Safe to use once a
    // run has genuinely stalled (no progress for a long stretch); if a run were still
    // truly active this would just make the UI lose track of it, not stop it.
    await store.delete(key);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
