import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
async function requireAdmin(username, password) {
  if (!username || !password) return false;
  const usersStore = getStore('hieronymus-staff-users');
  const record = await usersStore.get(String(username).toLowerCase(), { type: 'json' });
  if (!record || record.role !== 'admin') return false;
  return verifyPassword(password, record.passwordHash);
}

// Each result row is stored as its own blob, keyed by run_id. This avoids the read-modify-write
// race that a single shared "append to one big CSV" blob has under concurrent writers (audits
// now run multiple prompts/engines in parallel server-side) — every write goes to a distinct
// key, so concurrent POSTs can never clobber each other. GET reconstructs the CSV by listing
// and reading back every row.
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

export default async (request, context) => {
  const store = getStore('hieronymus-results-rows');

  if (request.method === 'POST') {
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
    const { blobs } = await store.list();
    const rows = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
    const csv = CSV_HEADER + rows.filter(Boolean).map(rowToCsvLine).join('');
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
    const url = new URL(request.url);
    const company = (url.searchParams.get('company') || '').trim();
    if (!company) {
      return new Response(JSON.stringify({ error: 'Missing company param' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const ok = await requireAdmin(url.searchParams.get('requestingUsername'), url.searchParams.get('requestingPassword'));
    if (!ok) {
      return new Response(JSON.stringify({ error: 'Only an admin can clear results' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const { blobs } = await store.list();
    const rows = await Promise.all(blobs.map(async b => ({ key: b.key, data: await store.get(b.key, { type: 'json' }) })));
    const toDelete = rows.filter(r => r.data && r.data.brand === company);
    await Promise.all(toDelete.map(r => store.delete(r.key)));
    return new Response(JSON.stringify({ status: 'ok', deleted: toDelete.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
};
