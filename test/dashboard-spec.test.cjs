/* Per-customer dashboard specs: the capability, end to end.
 *
 * The point of the whole modularisation is that one customer's dashboard can be changed — its
 * layout, its logic, its wording, its colours, its tabs, even a visual that exists nowhere else —
 * without forking a page and without touching anybody else's dashboard. These tests drive that
 * through a real page render against a fixture spec served from test/fixtures/specs.
 *
 * The fixture lives here rather than in specs/customers/ on purpose: no live customer is
 * customised yet, and shipping a fixture to production to test it would be exactly backwards.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderDashboard } = require('./support/dashboard-harness.cjs');

const SPEC_ROOT = path.join(__dirname, 'fixtures', 'specs');
const PAGE = 'dashboard-diagnostic.html';

// `fiacsa` has a fixture spec; `Someone Else` has none and must be untouched by it.
const withSpec = (opts = {}) => renderDashboard(PAGE, Object.assign({ lang: 'en', specRoot: SPEC_ROOT, company: 'Fiacsa' }, opts));
const noSpec = (opts = {}) => renderDashboard(PAGE, Object.assign({ lang: 'en', specRoot: SPEC_ROOT, company: 'Someone Else' }, opts));

test('a customer with no spec is completely unaffected by another customer having one', async () => {
  // The safety property the whole design rests on.
  const plain = await noSpec();
  assert.deepEqual(plain.errors, []);
  assert.ok(!/FIXTURE BANNER/.test(plain.regions.wrap), 'no fixture block leaked in');
  assert.ok(!/fixture-replaced-engines/.test(plain.regions.wrap), 'core block not replaced');
  assert.ok(/Most recommended brand/.test(plain.regions.cwrap), 'base copy intact');
  assert.ok(plain.tabs.includes('prompts:'), 'base tabs intact');
});

test('layouts: a spec reorders, drops and inserts blocks', async () => {
  const r = await withSpec();
  assert.deepEqual(r.errors, []);
  const w = r.regions.wrap;

  assert.ok(/FIXTURE BANNER for Fiacsa/.test(w), 'a customer-only block rendered');
  assert.ok(!/donut-wrap/.test(w), 'sentimentDonut was dropped by omitting it from the layout');
  assert.ok(!/class="dual"/.test(w), 'the dual group went with it');

  // Order follows the spec's array, not the base layout.
  const order = ['fixture-banner', 'fixture-replaced-engines', 'geo-hero', 'invlist']
    .map(c => w.indexOf(c));
  assert.ok(order.every(i => i >= 0), 'every block in the spec layout rendered: ' + JSON.stringify(order));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'rendered in the spec order');
});

test('blocks: a customer can replace a core block outright', async () => {
  const r = await withSpec();
  assert.ok(/REPLACED perEngine/.test(r.regions.wrap));
  assert.ok(!/perEngineTitle|etbl/.test(r.regions.wrap), 'the original per-engine table is gone');
});

test('blockOptions: a spec tunes a block it did not write', async () => {
  const r = await withSpec();
  const rows = (r.regions.cwrap.match(/class="crow"/g) || []).length;
  // rowLimit 3 plus the header, plus the client's own guaranteed row if it placed below the cut.
  assert.ok(rows <= 4, 'leaderboard honoured rowLimit 3, got ' + rows + ' rows');
  assert.ok(/class="crow others"/.test(r.regions.cwrap), 'the rest folded into Others');

  const plain = await noSpec();
  const plainRows = (plain.regions.cwrap.match(/class="crow"/g) || []).length;
  assert.ok(plainRows > rows, 'the uncustomised customer still gets the full top-25 (' + plainRows + ')');
});

test('copy: a spec overrides a label in both languages', async () => {
  const en = await withSpec({ lang: 'en' });
  assert.ok(/Fixture rank label/.test(en.regions.cwrap), 'English override applied');
  assert.ok(!/Your rank/.test(en.regions.cwrap), 'built-in label replaced');

  const es = await withSpec({ lang: 'es' });
  assert.ok(/Etiqueta de prueba/.test(es.regions.cwrap), 'Spanish override applied');

  const plain = await noSpec({ lang: 'en' });
  assert.ok(!/Fixture rank label/.test(plain.regions.cwrap), 'the override is scoped to one customer');
});

test('theme: valid custom properties are applied and unsafe ones refused', async () => {
  const r = await withSpec({ keepWindow: true });
  const style = r.window.document.getElementById('akore-spec-theme');
  assert.ok(style, 'a theme style element was injected');
  assert.ok(style.textContent.includes('--navy:#0a7d55'), 'the valid token was written');
  assert.ok(!style.textContent.includes('bogus'), 'a malformed property name was refused');
  // The injection attempt must not be able to close the rule and add another.
  assert.ok(!/body\s*\{/.test(style.textContent), 'a value containing ; and } was refused');
  assert.ok(r.warnings.some(w => /theme value ignored/.test(w)), 'and it said why');
  assert.equal((style.textContent.match(/\{/g) || []).length, 1, 'exactly one rule');
  r.window.close();
});

test('tabs: a spec renames, reorders and hides tabs', async () => {
  const r = await withSpec({ keepWindow: true });
  const d = r.window.document;
  const labels = [...d.querySelectorAll('.tabs .tab')].map(b => b.dataset.panel + ':' + b.textContent.trim());

  assert.ok(!labels.some(l => l.startsWith('prompts:')), 'the hidden tab is gone: ' + labels);
  assert.equal(d.getElementById('panel-prompts'), null, 'and so is its panel');
  assert.ok(labels[0].startsWith('competitors:'), 'the reordered tab moved first: ' + labels);
  assert.ok(labels[0].endsWith(':Rivals'), 'and was renamed: ' + labels[0]);
  r.window.close();
});

test('a renamed tab survives a language switch', async () => {
  // applyStaticLang repaints every [data-t]; a renamed tab must not be reverted by it.
  const r = await withSpec({ keepWindow: true });
  const d = r.window.document, W = r.window;
  const tab = () => d.querySelector('.tabs .tab[data-panel="competitors"]').textContent.trim();
  assert.equal(tab(), 'Rivals');
  W.setLang('es');
  await new Promise(x => setTimeout(x, 500));
  assert.equal(tab(), 'Rivales', 'the override followed the language, not the built-in label');
  W.setLang('en');
  await new Promise(x => setTimeout(x, 500));
  assert.equal(tab(), 'Rivals');
  r.window.close();
});

test('a manifest entry with no module degrades to the base design', async () => {
  // `ghostco` is listed in the fixture manifest but has no file: a misconfiguration, which must
  // cost that customer their customisation and nothing else. The failed fetch is expected and
  // deliberately left visible — a manifest entry pointing at nothing is worth seeing in devtools.
  const r = await renderDashboard(PAGE, { lang: 'en', specRoot: SPEC_ROOT, company: 'Ghostco' });
  const unexpected = r.errors.filter(e => !/specs\/customers\/ghostco\.js/.test(e));
  assert.deepEqual(unexpected, [], 'nothing failed except the absent spec itself');
  assert.ok(r.regions.wrap.length > 2000, 'the real base dashboard rendered anyway');
  assert.ok(/geo-hero/.test(r.regions.wrap) && /donut-wrap/.test(r.regions.wrap), 'with all its base blocks');
  assert.ok(!/FIXTURE BANNER/.test(r.regions.wrap));
});

// ── the spec module's own rules ───────────────────────────────────────────────────────────────
const S = require(path.join(__dirname, '..', 'js', 'dash', 'spec.js'));

test('slugify matches the server rule that names the file', () => {
  // intake-codes.js derives the username from the company name this way; the spec file is named
  // for the same slug, so a mismatch here means a spec silently never loads.
  assert.equal(S.slugify('Fiacsa'), 'fiacsa');
  assert.equal(S.slugify('  Acme Widgets, S.A. de C.V. '), 'acme-widgets-s-a-de-c-v');
  assert.equal(S.slugify('Añejo & Co'), 'a-ejo-co');
});

test('a crafted company name cannot walk out of the specs directory', () => {
  assert.equal(S.slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(S.slugify('..'), '');
});

test('merge replaces arrays rather than concatenating them', () => {
  // Half-merging a layout is never what anyone means by "my dashboard shows these blocks".
  assert.deepEqual(S.merge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  assert.deepEqual(S.merge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  assert.deepEqual(S.merge({ a: 1, b: 2 }, { b: null }), { a: 1 });
});

test('layout() falls through to the base when the spec names no override', () => {
  const base = ['one', 'two'];
  assert.equal(S.layout({ layouts: {} }, 'summary', base), base);
  assert.deepEqual(S.layout({ layouts: { summary: ['x'] } }, 'summary', base), ['x']);
  assert.equal(S.layout(null, 'summary', base), base);
});

test('a copy override must give both languages a chance', () => {
  const dict = { k: { en: 'A', es: 'B' } };
  const warns = [];
  const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    assert.equal(S.applyCopy({ copy: { k: 'just a string' } }, dict), 0, 'a bare string is refused');
    assert.deepEqual(dict.k, { en: 'A', es: 'B' }, 'and the dictionary is untouched');
    assert.equal(S.applyCopy({ copy: { k: { en: 'New' } } }, dict), 1);
    assert.deepEqual(dict.k, { en: 'New', es: 'B' }, 'a partial override keeps the other language');
  } finally { console.warn = realWarn; }
  assert.ok(warns.some(w => /expected \{ en, es \}/.test(w)));
});

test('the shipped manifest is empty — no live customer is customised yet', () => {
  const fs = require('node:fs');
  const real = fs.readFileSync(path.join(__dirname, '..', 'specs', 'customers', 'index.js'), 'utf8');
  const listed = [...real.matchAll(/^\s*'([^']+)',?\s*$/gm)].map(m => m[1]);
  assert.deepEqual(listed, [], 'manifest lists: ' + listed.join(', ') +
    ' — if that is intentional, this test should record it');
});
