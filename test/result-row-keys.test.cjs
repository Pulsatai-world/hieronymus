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

// The other way a customer ended up with nothing: the pre-run clear deleted every diagnostic row
// they had BEFORE the run wrote any. A run that then failed — and background runs do get cut off
// around 15 minutes — left the old snapshot gone and no new one in its place.
test('the pre-run clear spares the rows this run is about to write', () => {
  const clear = (SRC.match(/const stale = existing\.filter\(([\s\S]*?)\);/) || [])[1] || '';
  assert.ok(clear, 'could not find the stale-row filter');
  assert.match(clear, /snapshot_date\s*!==\s*snapshotDate/,
    'the clear deletes this run\'s own date too, so a run that fails after clearing leaves the '
    + 'customer with no data at all');
  assert.match(clear, /run_type\s*!==\s*'monitoring'/,
    'the clear must never touch monitoring rows — they are the trend history');
});
