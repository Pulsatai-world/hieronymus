import { getStore } from '@netlify/blobs';
import { patchDirectoryEntry } from './portal-directory.js';

// Reading results without reading every result.
//
// Each row is its own blob, which is what stopped concurrent writers clobbering one another. The
// cost is on the way out: reconstructing a CSV meant listing every blob on the platform and
// fetching each one individually, then filtering by company in memory. Measured at one network
// round trip per row — 3,000 rows cost 3,002 of them, on every customer page view, both dashboards,
// and the portal, which read the entire audit history to work out which dates each customer had run
// on. Every audit ever run made opening the app permanently slower.
//
// So reads come from two derived blobs instead: one CSV per company, and one small index of
// per-company summaries. Both are caches. The per-row blobs remain the only source of truth, and
// anything here can be thrown away and rebuilt from them, which is exactly what happens on a miss.
//
// They are rebuilt rather than maintained. Updating a shared blob on every row write would
// reintroduce the read-modify-write race the per-row keys exist to avoid; instead a write simply
// drops the cache, and the next read pays for one rebuild.

// The CSV shape lives here, with the code that builds it, so the endpoint and the cache cannot
// drift into writing two different files for the same rows.
export const CSV_COLUMNS = [
  'run_id', 'run_type', 'snapshot_date', 'engine', 'prompt_id', 'prompt_text', 'query_intent', 'topic_cluster',
  'brand', 'brand_mentioned', 'brand_cited', 'brand_citation_rank', 'total_brands_cited',
  'brands_cited_list', 'top_cited_brand', 'brand_is_leader', 'linked_to_site', 'sentiment',
  'claims_about_brand', 'incorrect_claims', 'has_incorrect_claim', 'services_correct',
  'location_correct', 'contact_correct', 'ai_sessions', 'ai_conversions', 'ai_pipeline_usd',
  'answer_excerpt', 'written_at'
];
export const CSV_HEADER = CSV_COLUMNS.join(',') + '\n';

function csvEscape(val) {
  const s = String(val ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function rowToCsvLine(row) {
  return CSV_COLUMNS.map(col => csvEscape(row[col])).join(',') + '\n';
}

const CACHE_STORE = 'hieronymus-results-cache';
// Bump when an index entry gains or loses a field. A cache outlives a deploy, so without this the
// first run after a shape change reads an entry written by the old code, finds the new field
// missing, and quietly does nothing — which is exactly what happened when diagnosticKeys was
// added: the clear deleted none of the previous diagnosis and left the dashboard pinned to it.
const INDEX_SHAPE = 2;
const INDEX_KEY = '__index';

export function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

/**
 * Reads every row, once, and writes the derived blobs.
 *
 * The one expensive operation left. It happens on a cache miss — after a run, after a clear, after
 * an import — and not on a page view.
 */
export async function rebuildResultsCache() {
  const rows = getStore('hieronymus-results-rows');
  const cache = getStore(CACHE_STORE);

  const { blobs } = await rows.list();
  const all = (await Promise.all(blobs.map(b => rows.get(b.key, { type: 'json' })))).filter(Boolean);

  const byCompany = new Map();
  for (const row of all) {
    const key = slugify(row.brand);
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }

  const index = { builtAt: new Date().toISOString(), shape: INDEX_SHAPE, companies: {} };
  const csvByKey = {};
  const writes = [];
  for (const [key, list] of byCompany) {
    // Oldest first, so a rebuilt CSV reads the same way the appended one did.
    list.sort((a, b) => String(a.snapshot_date || '').localeCompare(String(b.snapshot_date || ''))
      || String(a.prompt_id || '').localeCompare(String(b.prompt_id || '')));

    const dates = [...new Set(list.map(r => r.snapshot_date).filter(Boolean))].sort();
    index.companies[key] = {
      company: list[0].brand,
      rows: list.length,
      dates,
      lastRun: dates[dates.length - 1] || null,
      // What the portal shows without needing a single row: has this customer been audited, and
      // is any of it a monitoring snapshot rather than the first diagnosis.
      hasDiagnostic: list.some(r => r.run_type !== 'monitoring'),
      hasMonitoring: list.some(r => r.run_type === 'monitoring'),
      // The blob keys of this customer's diagnostic rows, so replacing their diagnosis does not
      // have to find them by reading every row on the platform. That scan — list(), then get()
      // on every blob for every customer — ran before a single prompt was processed, with
      // `completed` still at 0, so the progress bar sat at 0% for exactly as long as it took,
      // and it got slower for everyone each time anybody was audited. It is the one place left
      // doing the thing this file exists to stop.
      diagnosticKeys: list.filter(r => r.run_type !== 'monitoring').map(r => r.run_id).filter(Boolean)
    };
    const csv = CSV_HEADER + list.map(rowToCsvLine).join('');
    csvByKey[key] = csv;
    writes.push(cache.setJSON(key, { csv, builtAt: index.builtAt }));
  }
  writes.push(cache.setJSON(INDEX_KEY, index));
  await Promise.all(writes);

  // The portal shows a run count per customer. Patched entry by entry rather than by discarding
  // the directory: dropping it would make the next person to open the front page rebuild it from
  // every customer record on the platform, which is the cost this whole file exists to remove.
  for (const [key, entry] of Object.entries(index.companies)) {
    await patchDirectoryEntry(
      item => item && slugify(item.company) === key,
      existing => existing && Object.assign({}, existing, {
        runCount: (entry.dates || []).length, lastRun: entry.lastRun || null
      })
    );
  }
  // Both the stored form and what was just built. A caller that reads the cache back to find out
  // what this call produced can be beaten to it by any concurrent write — invalidate() drops
  // every cache blob — and would then see nothing at all and report a customer with no rows.
  return { index, csvByKey };
}

/** The CSV for one company, built on a miss. */
export async function cachedCompanyCsv(company) {
  const cache = getStore(CACHE_STORE);
  const key = slugify(company);
  const hit = await cache.get(key, { type: 'json' });
  if (hit && typeof hit.csv === 'string') return hit.csv;

  // Taken from the rebuild itself, not read back out of the cache: a write landing in between
  // would have dropped it again, and an empty answer here is indistinguishable from a customer
  // who has never been audited. A customer with genuinely no rows has no entry, and the bare
  // header is then the right answer rather than a guess.
  const { csvByKey } = await rebuildResultsCache();
  return csvByKey[key] || CSV_HEADER;
}

/** Per-company summaries, built on a miss. This is all the portal needs. */
export async function resultsIndex() {
  const cache = getStore(CACHE_STORE);
  const hit = await cache.get(INDEX_KEY, { type: 'json' });
  if (hit && hit.companies && hit.shape === INDEX_SHAPE) return hit;
  return (await rebuildResultsCache()).index;
}

/** Does this customer have any rows at all? One read, where the answer used to cost thousands. */
export async function companyHasRows(company) {
  const cache = getStore(CACHE_STORE);
  const index = await cache.get(INDEX_KEY, { type: 'json' });
  if (index && index.companies) {
    const entry = index.companies[slugify(company)];
    return entry ? { known: true, rows: entry.rows, lastRun: entry.lastRun } : { known: true, rows: 0, lastRun: null };
  }
  return { known: false, rows: 0, lastRun: null };
}

/**
 * Drops the cache. Called by anything that writes or deletes rows.
 *
 * Dropping rather than updating is the point: a shared blob updated by twelve workers at once is
 * the race the per-row keys were introduced to kill, and it is not worth reintroducing to save a
 * rebuild that happens once per run.
 */
export async function invalidateResultsCache() {
  const cache = getStore(CACHE_STORE);
  try {
    const { blobs } = await cache.list();
    await Promise.all(blobs.map(b => cache.delete(b.key)));
  } catch (e) {
    // A cache that cannot be dropped must not fail the write that triggered it; the next read
    // rebuilds from the rows either way.
    console.error('RESULTS_CACHE_INVALIDATE_FAILED', e && e.message);
  }
}
