// The extracted question schema, checked against the form it came from.
//
// This is the file the whole per-customer-intake idea rests on: if a question is missing from the
// template, it is a question nobody gets asked, and the only sign is a quieter intake. So the check
// that matters is not "the template parses" — it is "the template still matches intake.html, right
// now". It regenerates in memory and compares, so the two cannot drift apart silently.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

(async () => {
  const { extract } = await import(pathToFileURL(path.join(ROOT, 'scripts/extract-intake-schema.mjs')).href);
  const html = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');
  const fresh = extract(html);
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'intake-template.default.json'), 'utf8'));

  console.log('The question template still matches the form:\n');

  check('the committed template is up to date with intake.html',
    JSON.stringify(fresh) === JSON.stringify(onDisk),
    'run: node scripts/extract-intake-schema.mjs');

  // Every answer the form stores must have a question behind it.
  const collect = html.slice(html.indexOf('function collectData()'));
  const src = collect.slice(0, collect.indexOf('\n}'));
  const read = [...new Set([...src.matchAll(/g\('([^']+)'\)/g)].map(m => m[1]))];
  const have = new Set(fresh.fields.map(f => f.id));
  const missing = read.filter(id => !have.has(id));
  check('every field collectData reads exists in the template', missing.length === 0, missing.join(', '));

  // A question with no Spanish is a question half the customers cannot read.
  const noEn = fresh.fields.filter(f => !f.label || !f.label.en);
  const noEs = fresh.fields.filter(f => !f.label || !f.label.es);
  check('every question has an English label', noEn.length === 0, noEn.map(f => f.id).join(', '));
  check('every question has a Spanish label', noEs.length === 0, noEs.map(f => f.id).join(', '));

  const badOpt = fresh.fields.filter(f => f.type === 'select' && (f.options || []).some(o => !o.label.en || !o.label.es));
  check('every dropdown option is written in both languages', badOpt.length === 0, badOpt.map(f => f.id).join(', '));

  // The sections, in the order the tabs present them.
  const panels = (html.match(/id="panel-[^"]*"/g) || []).length;
  check('every panel became a section', fresh.sections.length === panels,
    fresh.sections.length + ' sections vs ' + panels + ' panels');
  check('sections keep the order the form shows them in',
    fresh.sections.every((s, i) => s.order === i), 'order is not sequential');

  // The pieces that are NOT plain fields, named so they cannot be forgotten in a rebuild.
  const kinds = fresh.widgets.reduce((a, w) => (a[w.kind] = (a[w.kind] || 0) + 1, a), {});
  check('both tag widgets are recorded', kinds.tags === 2, JSON.stringify(kinds));
  check('both repeaters are recorded', kinds.repeater === 2, JSON.stringify(kinds));
  check('nothing in collectData was left unrecognised', !kinds.unknown,
    JSON.stringify(fresh.widgets.filter(w => w.kind === 'unknown')));

  // Fields the audit grader and the storage key depend on. Losing one is silent, so name them here.
  for (const p of ['general.company', 'general.industry', 'general.website', 'websites.primarySite']) {
    check('load-bearing field still present: ' + p,
      fresh.fields.some(f => f.paths.includes(p)), 'no question stores ' + p);
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
