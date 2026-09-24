import { getStore } from '@netlify/blobs';
import { slugify } from './lib/accounts.js';
import { callerOf, requireCompany, requireStaff } from './lib/authorize.js';

// Per-customer intake templates: which questions this customer is asked, in what words.
//
// Two copies per customer, for the same reason prompts have two: a form half-edited on a Tuesday
// must not be what the client opens on Tuesday afternoon. Staff write `draft` as often as they
// like; `released` is the only thing a customer is ever served, and it only changes when someone
// deliberately releases it. A customer with no released template gets the default set, which is
// also what every customer gets before anyone edits anything.
//
// The gate is enforced here and not in the editor, for the reason it is enforced in prompts.js: the
// customer holds a working intake link, so they can call this endpoint themselves, and a rule that
// lives only in a staff page is not a rule.

// Four answers the rest of the platform reads by name. `general.website` is where the storage key
// for a customer's intake comes from, and `websites.primarySite` is what audit grading reads to
// know whose site it is looking at; company and industry are what the prompt brief is built on.
// A template that drops one of them does not fail here — it produces an audit about nobody, weeks
// later. So they cannot be removed, renamed, or switched off, whatever the editor allows.
const REQUIRED_PATHS = ['general.company', 'general.industry', 'general.website', 'websites.primarySite'];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

/** Everything wrong with a template, rather than the first thing wrong with it. */
function problemsWith(tpl) {
  const bad = [];
  if (!tpl || typeof tpl !== 'object') return ['Template must be an object'];
  if (!Array.isArray(tpl.fields)) return ['Template must have a fields array'];
  if (!Array.isArray(tpl.sections)) bad.push('Template must have a sections array');

  const seen = new Set();
  for (const f of tpl.fields) {
    if (!f || typeof f.id !== 'string' || !f.id.trim()) { bad.push('Every field needs an id'); continue; }
    if (seen.has(f.id)) bad.push(`Two fields share the id "${f.id}"`);
    seen.add(f.id);
    if (!Array.isArray(f.paths) || !f.paths.length) bad.push(`Field "${f.id}" has nowhere to store its answer`);
  }

  // Asked of the fields that are actually switched on: a required question left in the template but
  // disabled is exactly as absent, for anything reading the answers.
  const live = new Set();
  for (const f of tpl.fields) {
    if (!f || f.enabled === false || !Array.isArray(f.paths)) continue;
    for (const p of f.paths) live.add(p);
  }
  for (const p of REQUIRED_PATHS) {
    if (!live.has(p)) bad.push(`"${p}" is required and cannot be removed or switched off`);
  }
  return bad;
}

export default async (request, context) => {
  const store = getStore('hieronymus-intake-templates');
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const companyParam = url.searchParams.get('company');

    if (companyParam) {
      // Authorize before touching the store: answering 404 first would tell an unauthenticated
      // caller which companies exist.
      const denied = await requireCompany(url, null, json, companyParam);
      if (denied) return denied;

      const rec = await store.get(slugify(companyParam), { type: 'json' });
      const caller = await callerOf(url, null);

      if (caller && caller.kind === 'staff') {
        return json({
          company: companyParam,
          draft: (rec && rec.draft) || null,
          released: (rec && rec.released) || null,
          releasedAt: (rec && rec.releasedAt) || null,
          releasedBy: (rec && rec.releasedBy) || null,
          savedAt: (rec && rec.savedAt) || null,
          // True when there are edits the customer is not seeing yet.
          unreleasedChanges: !!(rec && rec.savedAt && (!rec.releasedAt || rec.savedAt > rec.releasedAt))
        }, 200);
      }

      // The customer. Only ever the released copy, and never a hint that a draft exists — the
      // form falls back to the default set when this is null, which is the normal case.
      return json({ company: companyParam, template: (rec && rec.released) || null }, 200);
    }

    // Listing names every customer, so it is staff-only.
    const deniedList = await requireStaff(url, null, json);
    if (deniedList) return deniedList;
    const { blobs } = await store.list();
    const items = await Promise.all(blobs.map(async b => {
      const rec = await store.get(b.key, { type: 'json' });
      return {
        key: b.key,
        company: rec?.company || b.key,
        savedAt: rec?.savedAt || null,
        releasedAt: rec?.releasedAt || null,
        unreleasedChanges: !!(rec?.savedAt && (!rec?.releasedAt || rec.savedAt > rec.releasedAt))
      };
    }));
    return json({ items }, 200);
  }

  // ── Saving a draft ── staff only, and never touches what the customer is being served.
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    const denied = await requireStaff(url, body, json);
    if (denied) return denied;

    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    const problems = problemsWith(body.template);
    if (problems.length) return json({ error: problems[0], problems }, 400);

    const key = slugify(company);
    const rec = (await store.get(key, { type: 'json' })) || { company };
    rec.company = company;
    rec.draft = body.template;
    rec.savedAt = new Date().toISOString();
    await store.setJSON(key, rec);
    return json({ status: 'ok', savedAt: rec.savedAt }, 200);
  }

  // ── Releasing ── promotes the draft to the copy customers are served.
  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    const denied = await requireStaff(url, body, json);
    if (denied) return denied;

    const company = (body.company || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);

    const key = slugify(company);
    const rec = await store.get(key, { type: 'json' });
    if (!rec) return json({ error: 'No template saved for this customer' }, 404);

    // Withdrawing puts the customer back on the default set. Kept as an explicit action rather
    // than something achieved by deleting the record, so it reads the same way in the editor.
    if (body.withdraw) {
      rec.released = null;
      rec.releasedAt = null;
      rec.releasedBy = null;
      await store.setJSON(key, rec);
      return json({ status: 'ok', released: false }, 200);
    }

    if (!rec.draft) return json({ error: 'There is no draft to release' }, 400);

    // Re-checked at release, not only at save: the required fields are the promise this endpoint
    // makes to prompt generation and grading, and a record could have been written before a rule
    // existed. Refusing here is cheap; discovering it in a month's audit is not.
    const problems = problemsWith(rec.draft);
    if (problems.length) return json({ error: problems[0], problems }, 400);

    const caller = await callerOf(url, body);
    rec.released = rec.draft;
    rec.releasedAt = new Date().toISOString();
    rec.releasedBy = caller ? caller.username : null;
    await store.setJSON(key, rec);
    return json({ status: 'ok', releasedAt: rec.releasedAt, releasedBy: rec.releasedBy }, 200);
  }

  if (request.method === 'DELETE') {
    const denied = await requireStaff(url, null, json);
    if (denied) return denied;
    const company = (url.searchParams.get('company') || '').trim();
    if (!company) return json({ error: 'Missing company name' }, 400);
    await store.delete(slugify(company));
    return json({ status: 'ok' }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};
