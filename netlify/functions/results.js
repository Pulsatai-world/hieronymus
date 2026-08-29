import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { requireStaff, requireStaffAdmin, requireCompany } from './lib/authorize.js';


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

const CSV_COLUMNS = [
  'run_id', 'run_type', 'snapshot_date', 'engine', 'prompt_id', 'prompt_text', 'query_intent', 'topic_cluster',
  'brand', 'brand_mentioned', 'brand_cited', 'brand_citation_rank', 'total_brands_cited',
  'brands_cited_list', 'top_cited_brand', 'brand_is_leader', 'linked_to_site', 'sentiment',
  'claims_about_brand', 'incorrect_claims', 'has_incorrect_claim', 'services_correct',
  'location_correct', 'contact_correct', 'ai_sessions', 'ai_conversions', 'ai_pipeline_usd',
  'answer_excerpt'
];
const CSV_HEADER = CSV_COLUMNS.join(',') + '\n';

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsvLine(row) {
  return CSV_COLUMNS.map(col => csvEscape(row[col])).join(',') + '\n';
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
    const denied = await requireStaff(url, null, json);
    if (denied) return denied;
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (!body.run_id) {
      return new Response(JSON.stringify({ error: 'Missing run_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await store.setJSON(body.run_id, body);
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

    const { blobs } = await store.list();
    let rows = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);
    if (company) {
      const want = company.toLowerCase();
      rows = rows.filter(r => String(r.brand || '').toLowerCase() === want);
    }
    const csv = CSV_HEADER + rows.map(rowToCsvLine).join('');
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
    return new Response(JSON.stringify({ status: 'ok', deleted: toDelete.length, snapshot_date: snapshot || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
};
