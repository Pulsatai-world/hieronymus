// The demo customer is defined once, and both things that build it read that definition.
//
// There are two callers — the button in the staff console and scripts/seed-demo-customer.mjs —
// and the failure this guards against is the ordinary one: the demo described twice, edited in
// one place, and quietly telling two different stories depending on who built it.
//
// It also checks the data says what the demo is for. A trend that dips is not "steady
// improvement", and the first draft dipped in September and flattened in November because each
// answer rolled its own dice; with 36 answers in a snapshot a probability lands anywhere.
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const demo = require(path.join(ROOT, 'js', 'demo-seed.js'));

test('both callers read the one definition', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'seed-demo-customer.mjs'), 'utf8');
  assert.match(cli, /demo-seed\.js/, 'the CLI defines its own demo instead of reading the module');
  assert.doesNotMatch(cli, /const TIMELINE\s*=|const PROMPTS\s*=/,
    'the CLI carries its own copy of the demo data');

  const portal = fs.readFileSync(path.join(ROOT, 'portal.html'), 'utf8');
  assert.match(portal, /<script src="\/js\/demo-seed\.js">/, 'the console cannot reach the module');
  const app = fs.readFileSync(path.join(ROOT, 'js', 'portal-app.js'), 'utf8');
  assert.match(app, /AkoreDemoSeed/, 'the console builds the demo without the shared module');
  assert.doesNotMatch(app, /const TIMELINE\s*=|'2026-05-04'/,
    'the console carries its own copy of the demo data');
});

test('the demo is the size a real customer is', () => {
  // 300 questions, asked once per engine, across six months of monitoring behind a baseline.
  // A demo built from a dozen prompts does not show what the product looks like in use, and it
  // hides the things that only appear at size — a 2 MB result set, a 300-row prompt list.
  assert.strictEqual(demo.PROMPTS.length, 300, 'the prompt set is not 300 questions');
  assert.strictEqual(demo.ENGINES.length, 3, 'one answer per engine means three engines');
  const monitoring = demo.TIMELINE.filter(s => s.type === 'monitoring');
  assert.strictEqual(monitoring.length, 6, 'six months of monitoring');
  const rows = demo.buildRows();
  assert.strictEqual(rows.length, 300 * 3 * demo.TIMELINE.length);
  // Every question asked of every engine, every month — no gaps.
  for (const snap of demo.TIMELINE) {
    const of = rows.filter(r => r.snapshot_date === snap.date);
    assert.strictEqual(of.length, 900, `${snap.date} has ${of.length} rows, expected 900`);
    assert.strictEqual(new Set(of.map(r => r.prompt_id)).size, 300);
    assert.strictEqual(new Set(of.map(r => r.engine)).size, 3);
  }
});

test('no question is asked twice', () => {
  const texts = demo.PROMPTS.map(p => p[2]);
  assert.strictEqual(new Set(texts).size, texts.length,
    'the set repeats itself — cycling each list by its own modulo collides');
});

test('one diagnostic snapshot, the rest monitoring', () => {
  const diag = demo.TIMELINE.filter(s => s.type === 'diagnostic');
  assert.strictEqual(diag.length, 1, 'the diagnostic dashboard pins to one baseline');
  assert.strictEqual(demo.TIMELINE[0].type, 'diagnostic', 'the baseline must be the earliest date');
  assert.ok(demo.TIMELINE.length >= 4, 'a trend needs more than a couple of points to be a trend');
});

test('the story is steady improvement, with no dip', () => {
  const rows = demo.buildRows();
  const rates = demo.TIMELINE.map(s => {
    const of = rows.filter(r => r.snapshot_date === s.date);
    return of.filter(r => r.brand_cited === 1).length / of.length;
  });
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] > rates[i - 1],
      `citation rate fell between ${demo.TIMELINE[i - 1].date} and ${demo.TIMELINE[i].date} `
      + `(${(rates[i - 1] * 100).toFixed(0)}% → ${(rates[i] * 100).toFixed(0)}%)`);
  }
  assert.ok(rates[rates.length - 1] - rates[0] > 0.3, 'the improvement is too small to read as one');
});

test('the same demo every time', () => {
  const a = demo.buildRows(), b = demo.buildRows();
  assert.deepStrictEqual(a, b, 'two builds differ — a screenshot of this would stop being true');
});

test('every row is keyed per customer, as a real row is', () => {
  const rows = demo.buildRows();
  const keys = new Set(rows.map(r => r.run_id));
  assert.strictEqual(keys.size, rows.length, 'two rows share a blob key and one would overwrite the other');
  const sample = rows[0];
  assert.strictEqual(sample.run_id,
    demo.hashId(`${demo.COMPANY}|${sample.snapshot_date}|${sample.prompt_id}|${sample.engine}`),
    'the key does not name the customer, which is how one customer overwrites another');
});

test('nothing in it claims to be a real company', () => {
  const rows = demo.buildRows();
  const brands = new Set();
  rows.forEach(r => String(r.brands_cited_list).split(';').filter(Boolean).forEach(x => brands.add(x)));
  assert.ok(brands.has(demo.COMPANY));
  for (const b of brands) {
    assert.ok(demo.COMPETITORS.includes(b) || b === demo.COMPANY,
      `"${b}" is in the leaderboard but is not one of the invented names`);
  }
});

test('the rows carry every column the CSV writes', () => {
  const cache = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'lib', 'results-cache.js'), 'utf8');
  const cols = [...cache.slice(cache.indexOf('export const CSV_COLUMNS'))
    .slice(0, cache.slice(cache.indexOf('export const CSV_COLUMNS')).indexOf('];'))
    .matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.ok(cols.length > 20, 'could not read the column list');
  const row = demo.buildRows()[0];
  const missing = cols.filter(c => !(c in row));
  assert.deepStrictEqual(missing, [], 'demo rows are missing columns the dashboards read');
});
