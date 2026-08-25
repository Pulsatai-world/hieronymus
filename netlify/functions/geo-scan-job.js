// Status and history for a customer's GEO technical scans.
//
// Staff-only, matching the other customer-scoped endpoints: a scan record names the customer's
// site and its weaknesses, which is exactly the kind of thing the recent scoping work closed off
// from open access.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
async function staffFromToken(token) {
  if (!token) return null;
  const s = await getStore('hieronymus-staff-sessions').get(String(token), { type: 'json' }).catch(() => null);
  if (!s || !s.username) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) return null;
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

const RANK = { FAIL: 0, WARNING: 1, INCONCLUSIVE: 2, INFO: 2, PASS: 3 };

// Compares two snapshots. A comparison across rubric versions is refused rather than shown: the
// two numbers were produced by different rules, so the difference between them says nothing about
// the site and would read as client progress that never happened.
function diff(current, previous) {
  if (!previous) return null;
  if (previous.rubricVersion !== current.rubricVersion) {
    return { comparable: false, previousDate: previous.scannedAt, previousRubric: previous.rubricVersion, currentRubric: current.rubricVersion };
  }
  const improved = [];
  const regressed = [];
  Object.entries(current.checks || {}).forEach(([k, status]) => {
    const before = (previous.checks || {})[k];
    if (before === undefined || before === status) return;
    (RANK[status] > RANK[before] ? improved : regressed).push({ key: k, from: before, to: status });
  });
  return {
    comparable: true,
    previousDate: previous.scannedAt,
    overall: { from: previous.overall, to: current.overall, delta: (current.overall ?? 0) - (previous.overall ?? 0) },
    layers: (current.layers || []).map(l => {
      const b = (previous.layers || []).find(p => p.id === l.id);
      return { id: l.id, from: b ? b.score : null, to: l.score, delta: (b && b.score !== null && l.score !== null) ? l.score - b.score : null };
    }),
    improved,
    regressed
  };
}

export default async (request) => {
  const url = new URL(request.url);
  const company = url.searchParams.get('company');
  if (!company) return json({ error: 'Missing company param' }, 400);
  if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
    return json({ error: 'Staff credentials required' }, 403);
  }

  const key = slugify(company);
  const jobs = getStore('hieronymus-geo-jobs');
  const history = getStore('hieronymus-geo-scans');

  if (request.method === 'GET') {
    const job = await jobs.get(key, { type: 'json' });

    const listed = await history.list({ prefix: `${key}/` }).catch(() => ({ blobs: [] }));
    const keys = (listed.blobs || []).map(b => b.key).sort();

    // The panel shows two fixed slots: the first scan ever taken, and the most recent one. Only
    // the ends of the list are read, so this costs the same whether a customer has two runs or
    // twenty. The stamp travels with each snapshot so each slot links to its own full report.
    const wanted = [...new Set([keys[0], keys[keys.length - 1], keys[keys.length - 2]].filter(Boolean))];

    // Which runs actually have a full report behind them. One listing, so a slot can hide a link
    // that would only lead to an error page.
    const fullListed = await getStore('hieronymus-geo-full').list({ prefix: `${key}/` }).catch(() => ({ blobs: [] }));
    const fullKeys = new Set((fullListed.blobs || []).map(b => b.key));

    const loaded = {};
    await Promise.all(wanted.map(async k => {
      const snap = await history.get(k, { type: 'json' }).catch(() => null);
      if (snap) { snap.stamp = k.split('/').pop(); snap.hasReport = fullKeys.has(k); loaded[k] = snap; }
    }));

    const first = keys.length ? loaded[keys[0]] || null : null;
    const latest = keys.length ? loaded[keys[keys.length - 1]] || null : null;
    const previous = keys.length > 1 ? loaded[keys[keys.length - 2]] || null : null;
    // The second slot stays empty until a genuinely separate run exists. With one run on record
    // the first slot already holds it, and repeating it below would read as two scans agreeing.
    const second = keys.length > 1 ? latest : null;

    return json({
      status: (job && job.status) || 'none',
      job: job || null,
      latest,
      first,
      second,
      delta: latest ? diff(latest, previous) : null,
      runCount: keys.length
    }, 200);
  }

  if (request.method === 'DELETE') {
    // Clears the displayed job status only. It cannot stop an in-flight background invocation —
    // Netlify offers no API for that — so it is for a run that has genuinely stalled. Stored scan
    // history is never touched here.
    await jobs.delete(key);
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
