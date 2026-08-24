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
async function isStaff(username, password) {
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

  if (!await isStaff(url.searchParams.get('staffUsername'), url.searchParams.get('staffPassword'))) {
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
  if (!result) return page(`<p>${lang === 'en' ? 'That scan could not be found.' : 'No se ha encontrado ese análisis.'}</p>`, 404);

  return page(buildReportHtml(result, lang), 200);
};
