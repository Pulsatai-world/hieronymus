/* The shared dashboard utilities, and the invariant that they stay shared.
 *
 * These functions were duplicated across the two dashboard pages — one pair differing only in a
 * parameter name — and every per-customer refinement would have had to be made twice. The last
 * test here is the one that matters most over time: it fails if a copy creeps back into a page.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const u = require(path.join(ROOT, 'js', 'dash', 'util.js'));
const PAGES = ['dashboard-diagnostic.html', 'dashboard-monitoring.html'];

test('parseCSV survives commas, quotes and newlines inside a field', () => {
  const csv = 'a,b,c\n1,"has, comma",x\n2,"say ""hi""",y\n3,"two\nlines",z\n';
  const rows = u.parseCSV(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].b, 'has, comma');
  assert.equal(rows[1].b, 'say "hi"');
  assert.equal(rows[2].b, 'two\nlines');
  assert.equal(rows[2].c, 'z');
});

test('parseCSV drops a malformed row rather than shifting every column after it', () => {
  const rows = u.parseCSV('a,b,c\n1,2,3\n1,2\n4,5,6\n');
  assert.equal(rows.length, 2, 'the short row is dropped, not padded');
  assert.deepEqual(rows.map(r => r.a), ['1', '4']);
});

test('normalizeRow keeps "not assessed" distinct from "assessed as wrong"', () => {
  const r = u.normalizeRow({ brand_cited: '1', services_correct: '', location_correct: '0', brand_citation_rank: '' });
  assert.equal(r.brand_cited, 1);
  assert.equal(r.services_correct, null, 'blank means ungraded, not failed');
  assert.equal(r.location_correct, 0, 'an explicit 0 really is a failure');
  assert.equal(r.brand_citation_rank, null);
  assert.equal(r.brand_mentioned, 0, 'absent counters default to zero');
});

test('mdLite escapes before converting emphasis', () => {
  assert.equal(u.mdLite('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(u.mdLite('**b** and *i*'), '<strong>b</strong> and <em>i</em>');
  // The escape has to happen first, or an answer could inject real markup.
  assert.ok(!u.mdLite('<b>raw</b> **x**').includes('<b>raw</b>'));
});

test('pct reports the fraction it came from, and never divides by zero', () => {
  assert.deepEqual(u.pct(2, 5), { value: 40, basis: '2 / 5' });
  assert.deepEqual(u.pct(0, 0), { value: 0, basis: '0 / 0' });
});

test('fmt renders each unit the way its card expects', () => {
  // 40.05 is not exactly representable and lands just under, so toFixed rounds down. Pinned
  // here deliberately: it is the behaviour every percentage on every dashboard already has.
  assert.equal(u.fmt(40.05, '%'), '40.0%');
  assert.equal(u.fmt(40.25, '%'), '40.3%');
  assert.equal(u.fmt(2.5, 'rank'), '#2.5');
  assert.equal(u.fmt(0, 'rank'), '—', 'rank 0 means no data, not first place');
  assert.equal(u.fmt(1500, 'USD'), '$2K');
  assert.equal(u.fmt(12, 'USD'), '$12');
});

test('detectLanguage uses inverted punctuation decisively and weights accents', () => {
  assert.equal(u.detectLanguage('¿cuál es el mejor proveedor?'), 'es');
  assert.equal(u.detectLanguage('what is the best provider for the company'), 'en');
  assert.equal(u.detectLanguage('ubicación y precio'), 'es');
  assert.equal(u.detectLanguage(''), 'en', 'empty text falls back rather than throwing');
});

test('intentLabel falls back rather than rendering undefined', () => {
  const t = k => 'T:' + k;
  assert.equal(u.intentLabel('pricing', t), 'T:intentPricing');
  assert.equal(u.intentLabel('a-brand-new-intent', t), 'a-brand-new-intent');
});

// ── i18n runtime ──────────────────────────────────────────────────────────────────────────────
function i18nEnv(dict, stored) {
  const dom = new JSDOM(
    '<!doctype html><body><button id="lang-btn-en"></button><button id="lang-btn-es"></button>' +
    '<span data-t="hello"></span></body>',
    { runScripts: 'outside-only', url: 'https://t.local/' });
  if (stored) dom.window.localStorage.setItem('hieronymus_lang', stored);
  const warns = [];
  dom.window.console.warn = (...a) => warns.push(a.join(' '));
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'js', 'dash', 'i18n.js'), 'utf8'));
  return { w: dom.window, d: dom.window.document, warns, I: dom.window.AkoreI18n };
}

const DICT = {
  hello: { en: 'Hello', es: 'Hola' },
  count: { en: n => n + ' items', es: n => n + ' artículos' }
};

test('i18n opens in Spanish by default and honours a stored choice', () => {
  const a = i18nEnv(DICT);
  assert.equal(a.I.create({ dict: DICT }).lang, 'es', 'Mexico-first default');
  const b = i18nEnv(DICT, 'en');
  assert.equal(b.I.create({ dict: DICT }).lang, 'en');
});

test('i18n resolves plain strings and functions', () => {
  const { I } = i18nEnv(DICT, 'en');
  const i = I.create({ dict: DICT });
  assert.equal(i.t('hello'), 'Hello');
  assert.equal(i.t('count', 3), '3 items');
});

test('a missing key degrades to the key instead of throwing', () => {
  // One untranslated label is a blemish; a throw mid-render is a blank dashboard.
  const { I, warns } = i18nEnv(DICT, 'en');
  const i = I.create({ dict: DICT });
  assert.equal(i.t('nope'), 'nope');
  assert.ok(warns.some(w => /missing translation key: nope/.test(w)));
});

test('setLang persists, repaints static labels, and notifies the page', () => {
  const { w, d, I } = i18nEnv(DICT, 'en');
  let notified = 0;
  const i = I.create({ dict: DICT, onChange: () => notified++ });
  i.applyStaticLang();
  assert.equal(d.querySelector('[data-t="hello"]').innerHTML, 'Hello');
  assert.ok(d.getElementById('lang-btn-en').classList.contains('active'));

  i.setLang('es');
  assert.equal(i.lang, 'es');
  assert.equal(d.querySelector('[data-t="hello"]').innerHTML, 'Hola');
  assert.ok(d.getElementById('lang-btn-es').classList.contains('active'));
  assert.ok(!d.getElementById('lang-btn-en').classList.contains('active'));
  assert.equal(w.localStorage.getItem('hieronymus_lang'), 'es');
  assert.equal(notified, 1);
});

// ── the invariant ─────────────────────────────────────────────────────────────────────────────
test('the two dashboards share their helpers instead of each keeping a copy', () => {
  const shared = [
    'esc', 'mdLite', 'clamp', 'sum', 'avg', 'pct', 'val', 'basisOf', 'fmt', 'statusChip',
    'parseCSV', 'normalizeRow', 'detectLanguage', 'makeMulti', 'canonicalBrand', 'properCase'
  ];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const fn of shared) {
      // A real reimplementation is what we are guarding against, not the one-line wrappers the
      // pages keep so inline markup can still call these as bare globals. So: no `function f(`
      // declaration at all, and any `const f =` must delegate to a shared module on that line.
      assert.ok(!new RegExp('^function ' + fn + '\\s*\\(', 'm').test(html),
        `${page} declares its own ${fn}() — it belongs in js/dash/`);
      const assigned = html.match(new RegExp('^const ' + fn + '\\s*=.*$', 'm'));
      if (assigned) {
        assert.ok(/window\.Akore/.test(assigned[0]),
          `${page} defines ${fn} itself instead of delegating: ${assigned[0].trim().slice(0, 90)}`);
      }
    }
    assert.ok(html.includes('/js/dash/util.js'), page + ' loads the shared utilities');
    assert.ok(html.includes('/js/dash/i18n.js'), page + ' loads the shared i18n runtime');
    assert.ok(html.includes('/js/dash/controls.js'), page + ' loads the shared controls');
  }
});

test('no top-level function is defined identically in both pages', () => {
  // The general form of the rule above: if the same body appears in both, it should be shared.
  const bodies = PAGES.map(p => {
    const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const out = new Map();
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^function ([A-Za-z_$][\w$]*)\s*\(/);
      if (!m) continue;
      let j = i; while (j < lines.length && lines[j] !== '}') j++;
      out.set(m[1], lines.slice(i, j + 1).join('\n'));
    }
    return out;
  });
  const dupes = [...bodies[0].keys()].filter(k => bodies[1].has(k) && bodies[0].get(k) === bodies[1].get(k));
  assert.deepEqual(dupes, [], 'identical in both pages, so it should live in js/dash/: ' + dupes.join(', '));
});
