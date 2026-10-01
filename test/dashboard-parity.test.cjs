/* The dashboards must keep rendering exactly what they render today.
 *
 * Both dashboards are being taken apart into an engine plus a library of blocks so that a single
 * customer's dashboard can be customised without forking a 1,400-line file. Every step of that is
 * a structural change with no intended visual effect, and these customers are live. So the rule is
 * simple: render against a fixed dataset, compare to a committed snapshot, fail on any difference.
 *
 * A failure here is not automatically a bug — it is an unreviewed change to what a customer sees.
 * If the change is intended, look at the diff, then re-record:
 *
 *     UPDATE_DASHBOARD_GOLDEN=1 npm test
 *
 * and commit the updated snapshot alongside the change, so the diff is in the review.
 *
 * Limit worth knowing: jsdom compares DOM, not pixels, and it does not resolve the CSS cascade or
 * custom properties reliably. Theming changes need a real browser; this catches structure, content
 * and inline style only.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderDashboard, serialize } = require('./support/dashboard-harness.cjs');

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'dashboard-golden');
const UPDATE = process.env.UPDATE_DASHBOARD_GOLDEN === '1';
const PAGES = ['dashboard-diagnostic.html', 'dashboard-monitoring.html'];

fs.mkdirSync(GOLDEN_DIR, { recursive: true });

for (const page of PAGES) {
  for (const lang of ['en', 'es']) {
    test(`${page} (${lang}) renders exactly what the committed snapshot records`, async () => {
      const result = await renderDashboard(page, { lang });

      assert.deepEqual(result.errors, [], 'the page must render without console errors');

      const actual = serialize(result);
      const file = path.join(GOLDEN_DIR, `${page.replace(/\.html$/, '')}.${lang}.html`);

      if (UPDATE || !fs.existsSync(file)) {
        fs.writeFileSync(file, actual);
        if (!UPDATE) console.log('  recorded new snapshot: ' + path.relative(process.cwd(), file));
        return;
      }

      const expected = fs.readFileSync(file, 'utf8');
      if (actual === expected) return;

      // A 100kB unified diff helps nobody. Point at the first divergence instead.
      let i = 0;
      while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
      const ctx = 160;
      const where = expected.slice(0, i).split('\n').length;
      assert.fail(
        `${page} (${lang}) renders differently than the snapshot.\n` +
        `  first difference at character ${i}, around line ${where}\n` +
        `  snapshot: …${JSON.stringify(expected.slice(Math.max(0, i - ctx), i + ctx))}\n` +
        `  rendered: …${JSON.stringify(actual.slice(Math.max(0, i - ctx), i + ctx))}\n` +
        `  if this change is intended: UPDATE_DASHBOARD_GOLDEN=1 npm test, then commit the snapshot`
      );
    });
  }
}

test('the snapshots are substantial enough to be worth trusting', async () => {
  // A harness that quietly renders an empty page would pass every comparison above forever.
  for (const page of PAGES) {
    const file = path.join(GOLDEN_DIR, `${page.replace(/\.html$/, '')}.en.html`);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.length > 20000, `${page} snapshot is only ${body.length} chars — did it render?`);
    assert.ok(/region:wrap/.test(body), `${page} snapshot has no main panel`);
    assert.ok(/region:cwrap/.test(body), `${page} snapshot has no competitor panel`);
    assert.ok(/region:pwrap/.test(body), `${page} snapshot has no prompts panel`);
  }
});

test('the dataset exercises the cases that have broken before', async () => {
  const { buildCsv } = require('./support/dashboard-harness.cjs');
  const csv = buildCsv('monitoring');
  assert.ok(/Parker Hannifin México/.test(csv), 'spelling variants that must canonicalise');
  assert.ok(/Bosch Rexroth S\.A\. de C\.V\./.test(csv), 'legal-entity tails');
  assert.ok(/is Northwind Hydraulics better than Parker/.test(csv), 'prompts naming the company, excluded from the leaderboard');
  assert.ok(/ERROR \(answer\)/.test(csv), 'error rows');
  assert.equal(new Set(csv.trim().split('\n').slice(1).map(l => l.split(',')[2])).size, 3, 'three snapshots for trends');
});
