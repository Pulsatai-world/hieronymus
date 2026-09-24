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

// Two answers grading reads as ground truth: general.industry, and the website (general.website or
// websites.primarySite). They used to be refused here if a template dropped them, on the assumption
// that losing them broke an audit. They do not. Grading is written to handle their absence — it
// returns null for the checks that need them rather than failing — generation passes the whole
// intake to Claude rather than indexing paths, and the intake's storage key comes from the session's
// company, not from the form. So dropping one costs some grading precision for that customer, and
// that is a judgement for whoever is building the form, not a rule this endpoint should impose.
// Reported back as a warning, so the cost is visible without being enforced.
const GROUND_TRUTH_PATHS = ['general.industry', 'general.website', 'websites.primarySite'];

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

/** Everything wrong with a template, rather than the first thing wrong with it. */
/** What a template costs without being wrong: reported, never enforced. */
function warningsFor(tpl) {
  const live = new Set();
  for (const f of (tpl && tpl.fields) || []) {
    if (!f || f.enabled === false || !Array.isArray(f.paths)) continue;
    for (const p of f.paths) live.add(p);
  }
  const out = [];
  if (!live.has('general.industry')) out.push('grading cannot check whether an answer named the right industry');
  if (!live.has('general.website') && !live.has('websites.primarySite')) {
    out.push('grading cannot check whether an answer named the right site');
  }
  return out;
}

// Ids are written into the editor's markup, including into inline handlers, where an id carrying a
// quote would break out of the JavaScript string it sits in — the browser decodes &#39; back to a
// quote before compiling the handler, so escaping on the way out does not save it. They are also
// the keys the form is addressed by. Nothing legitimate needs anything outside this set, and
// refusing here removes the whole class rather than escaping it in each of the places it is used.
const ID_OK = /^[A-Za-z0-9_-]+$/;

function problemsWith(tpl) {
  const bad = [];
  if (!tpl || typeof tpl !== 'object') return ['Template must be an object'];
  if (!Array.isArray(tpl.fields)) return ['Template must have a fields array'];
  if (!Array.isArray(tpl.sections)) bad.push('Template must have a sections array');
  for (const sec of tpl.sections || []) {
    if (!sec || typeof sec.id !== 'string' || !ID_OK.test(sec.id)) {
      bad.push(`Section id "${sec && sec.id}" may only use letters, numbers, dashes and underscores`);
    }
  }
  const sectionIds = new Set((tpl.sections || []).map(x => x && x.id));
  for (const f of tpl.fields || []) {
    // A question pointing at a section that is not there is drawn nowhere and answered by nobody.
    if (f && f.section && !sectionIds.has(f.section)) {
      bad.push(`Question "${f.id}" is in a section that does not exist ("${f.section}")`);
    }
  }

  const seen = new Set();
  for (const f of tpl.fields) {
    if (!f || typeof f.id !== 'string' || !f.id.trim()) { bad.push('Every field needs an id'); continue; }
    if (!ID_OK.test(f.id)) { bad.push(`Field id "${f.id}" may only use letters, numbers, dashes and underscores`); continue; }
    if (seen.has(f.id)) bad.push(`Two fields share the id "${f.id}"`);
    seen.add(f.id);
    // Not every question is an answer. The two chip inputs are stored through their widget rather
    // than through a path of their own, and `site-count` drives the repeater instead of being
    // recorded — so a field with no path is normal, and rejecting it refused the default template
    // that every customer starts from. It IS a mistake on a question staff added, because the
    // editor always gives one an `extra.` path, so an added question without one is a broken write.
    if (f.custom && (!Array.isArray(f.paths) || !f.paths.length)) {
      bad.push(`Added question "${f.id}" has nowhere to store its answer`);
    }
    if (f.paths !== undefined && !Array.isArray(f.paths)) bad.push(`Field "${f.id}" has an invalid paths list`);
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
    return json({ status: 'ok', savedAt: rec.savedAt, warnings: warningsFor(body.template) }, 200);
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
    return json({ status: 'ok', releasedAt: rec.releasedAt, releasedBy: rec.releasedBy, warnings: warningsFor(rec.draft) }, 200);
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
