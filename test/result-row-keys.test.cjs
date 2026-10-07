// A result row's storage key must name the customer it belongs to.
//
// Every customer's rows live in one store, `hieronymus-results-rows`, keyed by the row's run_id.
// The key used to be hash(snapshot_date | prompt_id | engine) — no company in it. prompt_id is
// POSITIONAL (every customer has Q01…Qnn), so two customers audited on the same date with the
// same engine produced byte-identical keys and the second run's setJSON overwrote the first
// customer's rows, one for one. Nothing failed: the rows were still there, carrying the other
// customer's brand, so the overwritten customer's dashboard reported "no audit data yet" while
// their audit had plainly run, and the runs list on their page was empty.
//
// This asserts the property, not the current hash: any keying that distinguishes customers
// passes, and the exact function may change.
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'functions', 'run-audit-background.js'), 'utf8');

// Pull the two pieces out of the real source rather than restating them here — a copy would go on
// passing after the original changed, which is the whole failure mode being guarded.
function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const keyExpr = (SRC.match(/run_id:\s*hashId\(`([^`]+)`\)/) || [])[1];

test('the row key template is found in the source', () => {
  assert.ok(keyExpr, 'could not find the run_id hashId(...) template — has it been renamed?');
});

test('the row key names the customer', () => {
  assert.match(keyExpr, /\$\{r\.company\}/,
    `run_id is built from \`${keyExpr}\` — without the company, two customers audited on the same `
    + 'date share a key and the later run destroys the earlier one\'s rows');
});

test('two customers on the same date, prompt and engine get different keys', () => {
  const render = company => keyExpr
    .replace('${r.company}', company)
    .replace('${r.snapshotDate}', '2026-10-06')
    .replace('${r.promptId}', 'Q01')
    .replace('${r.engine}', 'claude');
  const a = hashId(render('Jeeves Solutions'));
  const b = hashId(render('FIACSA'));
  assert.notStrictEqual(a, b,
    'both customers write to the same blob key; the second audit of the day wipes the first');
});

test('the same customer, date, prompt and engine is stable — a re-run replaces its own row', () => {
  const render = () => keyExpr
    .replace('${r.company}', 'Jeeves Solutions')
    .replace('${r.snapshotDate}', '2026-10-06')
    .replace('${r.promptId}', 'Q01')
    .replace('${r.engine}', 'claude');
  assert.strictEqual(hashId(render()), hashId(render()),
    'a re-run must land on the same key, or every run leaves duplicate rows behind');
});

// Replacing a diagnosis must not cost a scan of every row on the platform, and must not leave
// half of the old set behind.
//
// The clear used to list the whole results store and get() every blob — for every customer, not
// just this one — before a single prompt was processed. `completed` is still 0 throughout, so
// the progress bar sat at 0% for exactly as long as that took, and it got slower for everybody
// each time anybody was audited. It is also the one scan the results cache was written to remove.
//
// A later attempt to make the clear failure-safe spared rows dated today. That spared the wrong
// thing: rows written before the key format changed live on different keys, so the run did not
// overwrite them either and the customer ended up with two rows per prompt per engine — every
// count doubled. An obviously empty dashboard is recoverable with a re-run; silently doubled
// numbers in front of a client are not.
test('the clear finds its rows from the index, not by reading every blob', () => {
  const clear = (SRC.match(/if \(runType === 'diagnostic' && startIndex === 0\) \{([\s\S]*?)\n    \}/) || [])[1] || '';
  assert.ok(clear, 'could not find the clear block');
  assert.doesNotMatch(clear, /rowsStore\.list\(\)/,
    'the clear still lists every blob on the platform before the run can start');
  assert.doesNotMatch(clear, /rowsStore\.get\(/,
    'the clear still reads every blob individually');
  assert.match(clear, /resultsIndex\(\)/, 'the clear does not use the index');
  assert.match(clear, /diagnosticKeys/, 'the clear does not use the stored row keys');
});

test('the clear drops the derived cache, or the page keeps being served the pre-run rows', () => {
  const clear = (SRC.match(/if \(runType === 'diagnostic' && startIndex === 0\) \{([\s\S]*?)\n    \}/) || [])[1] || '';
  assert.match(clear, /invalidateResultsCache\(\)/,
    'rows were deleted but the CSV built from them was left in place');
});

test('the index exposes only diagnostic row keys, never monitoring ones', () => {
  const CACHE = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'results-cache.js'), 'utf8');
  const line = (CACHE.match(/diagnosticKeys:[^\n]*/) || [''])[0];
  assert.ok(line, 'the index does not carry diagnostic row keys');
  assert.match(line, /r\.run_type !== 'monitoring'/,
    'monitoring rows are in the delete list — that is months of trend history');
});
