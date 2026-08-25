// Renders a stored GEO scan as a full report page.
//
// Returns HTML rather than JSON so the browser can display and print it directly — Ctrl+P gives
// a PDF with no extra tooling, which is what a client report actually needs. The report layout
// carries its own print stylesheet, so the printed copy drops the chrome and keeps the findings.
//
// The report is built from the stored full result, not the trimmed snapshot: the snapshot keeps
// scores and verdicts for comparison, and deliberately omits the finding text, which is the
// entire substance of a report.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { buildReportHtml } from './lib/geo-report-html.js';

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
function page(body, status) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default async (request) => {
  const url = new URL(request.url);
  const company = url.searchParams.get('company');
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
  if (!company) return page('<p>Missing company</p>', 400);

  if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'), url.searchParams.get('staffToken'))) {
    return page('<p>Staff credentials required.</p>', 403);
  }

  const key = slugify(company);
  const full = getStore('hieronymus-geo-full');

  // A specific run can be requested; otherwise the most recent one is shown.
  let stamp = url.searchParams.get('run');
  if (!stamp) {
    const listed = await full.list({ prefix: `${key}/` }).catch(() => ({ blobs: [] }));
    const keys = (listed.blobs || []).map(b => b.key).sort();
    if (!keys.length) return page(`<p>${lang === 'en' ? 'No scan stored for this customer yet.' : 'Todavía no hay ningún análisis guardado para este cliente.'}</p>`, 404);
    stamp = keys[keys.length - 1].split('/').pop();
  }

  const result = await full.get(`${key}/${stamp}`, { type: 'json' }).catch(() => null);
  if (!result) {
    // A requested run with no stored report is a different thing from a customer who has never
    // been scanned, and saying the wrong one sends people looking in the wrong place.
    return page(`<p data-reason="run-missing">${lang === 'en'
      ? 'No full report was stored for that scan. It ran before the tool began keeping them — run a new scan to get one.'
      : 'Ese análisis no tiene informe guardado. Se corrió antes de que la herramienta empezara a guardarlos: corre uno nuevo para tenerlo.'}</p>`, 404);
  }

  // An older stored result can be missing the sections the report is built from. Better to say so
  // than to return a page that renders blank.
  if (!result.section1 || !result.section2 || !result.prioritizedFindings) {
    return page(`<p data-reason="run-stale">${lang === 'en'
      ? 'That scan was stored by an earlier version of the scanner and cannot be rendered. Run a new scan.'
      : 'Ese análisis lo guardó una versión anterior del escáner y no se puede mostrar. Corre uno nuevo.'}</p>`, 409);
  }

  return page(buildReportHtml(result, lang), 200);
};
