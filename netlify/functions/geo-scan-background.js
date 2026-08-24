// Runs a GEO technical scan for one customer and stores the result.
//
// A Background Function because a scan of a sitemap-driven site legitimately takes 20-100
// seconds — well past a regular function's ceiling — and the sites that take longest are exactly
// the slow, modest hosts this check exists to report on honestly rather than time out against.
//
// The engine is vendored under lib/geo-* rather than called across origins: the standalone
// scanner's endpoints set no CORS headers for this domain, and depending on another deployment
// staying up would make a customer's scan history hostage to a separate site.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { runScan } from './lib/geo-scan-engine.js';

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
function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

// Snapshots are trimmed before storage. A full payload carries raw HTML excerpts and runs to
// megabytes; what the panel and any future comparison need is the score, the layer breakdown and
// each check's verdict. rubricVersion travels with every snapshot because a scoring change would
// otherwise read as client progress when two runs are compared.
function snapshot(result) {
  const checks = {};
  (result.layers || []).forEach(l => l.checks.forEach(c => {
    checks[c.page ? `${c.page}::${c.id}` : c.id] = c.status;
  }));
  return {
    url: result.input.url,
    scannedAt: result.scannedAt,
    rubricVersion: result.score.rubricVersion,
    reachable: result.reachable,
    overall: result.score.overall,
    layers: (result.layers || []).map(l => ({ id: l.id, title: l.title, score: l.score, scored: l.scored, counts: l.counts })),
    pagesAnalyzed: result.scanQuality.pagesAnalyzed,
    blockers: result.score.blockers.count,
    unverified: result.score.unverified.count,
    checks
  };
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const { company, url, staffUsername, staffPassword, maxPages } = body || {};
  if (!company || !url) return new Response('Missing company or url', { status: 400 });
  if (!await isStaff(staffUsername, staffPassword)) return new Response('Staff credentials required', { status: 403 });

  const key = slugify(company);
  const jobs = getStore('hieronymus-geo-jobs');
  const history = getStore('hieronymus-geo-scans');

  // The job record is written before the scan starts so the panel can show "running" immediately
  // rather than appearing to do nothing for a minute and a half.
  await jobs.setJSON(key, { status: 'running', url, startedAt: new Date().toISOString() });

  try {
    const result = await runScan({ url, maxPages: Number(maxPages) || 20 });
    const snap = snapshot(result);

    // Every run is kept under its own timestamped key so a re-audit can be compared against the
    // previous one rather than overwriting it.
    const stamp = snap.scannedAt.replace(/[:.]/g, '-');
    await history.setJSON(`${key}/${stamp}`, snap);
    await jobs.setJSON(key, { status: 'done', url, finishedAt: new Date().toISOString(), latest: snap });
  } catch (err) {
    await jobs.setJSON(key, { status: 'error', url, finishedAt: new Date().toISOString(), error: err.message });
  }

  return new Response('', { status: 202 });
};
