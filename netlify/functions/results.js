import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireStaff, requireStaffAdmin, requireCompany } from './lib/authorize.js';
import { cachedCompanyCsv, resultsIndex, invalidateResultsCache,
         CSV_COLUMNS, CSV_HEADER, rowToCsvLine } from './lib/results-cache.js';


// Each result row is stored as its own blob, keyed by run_id. This avoids the read-modify-write
// race that a single shared "append to one big CSV" blob has under concurrent writers (audits
// now run multiple prompts/engines in parallel server-side) — every write goes to a distinct
// key, so concurrent POSTs can never clobber each other. GET reconstructs the CSV by listing
// and reading back every row.
// Reading results is scoped from here on. Previously GET returned every customer's rows to anyone
// who asked, and the dashboards filtered in the browser — so one customer's dashboard downloaded
// every other customer's data, and swapping ?company= in the URL showed a competitor's audit. A
// client-side filter is not an access control.
//

// A signed-in staff session presents an opaque token instead of the password. Checked first so a
// restored session never has to ask for the password again; the password path below is unchanged
// and still answers for anything that has not adopted tokens.
// Sessions minted before this cutoff are dead. It is the moment two-factor was deployed, not a
// round date: a staff token lasts 30 days and the code running before this deploy minted them with
// no second factor, so anyone holding one would have skipped enrollment for up to a month. Set to
// the deploy itself so every session that predates two-factor ends with it.
const SESSION_EPOCH = Date.parse('2026-08-29T14:11:51Z');



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
  const store = getStore('hieronymus-results-rows');
  const url = new URL(request.url);

  if (request.method === 'POST') {
    // The audit no longer calls this — run-audit-background.js writes rows straight to the store —
    // so the only remaining callers would be manual imports, which are a staff action. Leaving it
    // open let anyone fabricate rows in any customer's dataset.
    // Parsed before the guard so the session can be read from the body, the way every other write
    // in this app sends it. Checking the URL alone refused a caller that had authenticated
    // perfectly well. Parsing first is safe: nothing is written until the guard has passed.
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const denied = await requireStaff(url, body, json);
    if (denied) return denied;
    if (!body.run_id) {
      return new Response(JSON.stringify({ error: 'Missing run_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await store.setJSON(body.run_id, body);
    // The rows changed, so everything derived from them is stale.
    await invalidateResultsCache();
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (request.method === 'GET') {
    const company = (url.searchParams.get('company') || '').trim();

    // Staff may read one customer or everything. A customer may read only their own: the company is
    // taken from their session, not from the query, so editing ?company= gets a refusal rather than
    // somebody else's audit.
    const denied = await requireCompany(url, null, json, company);
    if (denied) return denied;

    // The portal needs to know which dates each customer has runs on, and nothing else. It used to
    // learn that by downloading every row on the platform — ten thousand rows cost ten thousand
    // round trips to render a list of four customers.
    if (url.searchParams.get('summary') === '1') {
      const index = await resultsIndex();
      if (company) {
        const one = index.companies[company.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')];
        return json({ companies: one ? { [company]: one } : {} }, 200);
      }
      return json(index, 200);
    }

    const csv = company
      ? await cachedCompanyCsv(company)
      // Staff asking for everything: still the whole set, but assembled from the per-company CSVs
      // that already exist rather than from every row individually.
      : await (async () => {
          const index = await resultsIndex();
          const parts = await Promise.all(Object.keys(index.companies).map(async k =>
            (await cachedCompanyCsv(index.companies[k].company)).slice(CSV_HEADER.length)));
          return CSV_HEADER + parts.join('');
        })();
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="hieronymus_all_results.csv"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }

  // Permanently deletes every stored result row for one company (used by the "Clear Results"
  // button on that customer's Hieronymus page) — scoped to a single company on purpose, never
  // a blanket wipe, and the frontend gates this behind an explicit confirm dialog.
  if (request.method === 'DELETE') {
    const company = (url.searchParams.get('company') || '').trim();
    if (!company) {
      return new Response(JSON.stringify({ error: 'Missing company param' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const denied = await requireStaffAdmin(url, null, json);
    if (denied) return denied;
    // Optional snapshot_date narrows the delete to one run. Without it the behaviour is unchanged
    // (every row for that customer) — but a single bad run should not force wiping a monitoring
    // history that took months to build.
    const snapshot = (url.searchParams.get('snapshot_date') || '').trim();
    const { blobs } = await store.list();
    const rows = await Promise.all(blobs.map(async b => ({ key: b.key, data: await store.get(b.key, { type: 'json' }) })));
    const toDelete = rows.filter(r => r.data && r.data.brand === company
      && (!snapshot || r.data.snapshot_date === snapshot));
    await Promise.all(toDelete.map(r => store.delete(r.key)));
    await invalidateResultsCache();
    return new Response(JSON.stringify({ status: 'ok', deleted: toDelete.length, snapshot_date: snapshot || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
};
