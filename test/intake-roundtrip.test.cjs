// A tailored form must give back exactly what was put into it.
//
// Save, close the tab, come back next week, finish it. That is the intake's whole promise, and the
// half that breaks silently is the return: a form that accepts an answer and then cannot show it
// again looks fine on the day and loses the answer for ever. Nothing errors, nothing is logged —
// the customer simply sees an empty box where they typed something, and fills it in differently.
//
// So this takes the real default template, tailors it the way a staff member would (switch some
// off, reword, retype one to multiple choice, add a question, add a section, reorder, pin the
// language), fills every control that is actually on screen, collects, and then restores it all
// into a brand new page and collects again. The two must be identical.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'intake-template.default.json'), 'utf8'));
const pageSrc = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'js', 'intake-template.js'), 'utf8');

function freshPage() {
  const dom = new JSDOM(pageSrc, { url: 'https://t.local/intake.html', runScripts: 'outside-only',
    virtualConsole: new VirtualConsole() });
  dom.window.eval(moduleSrc);
  return dom.window;
}

// What a staff member would actually do to a form, all at once.
function tailor() {
  const t = JSON.parse(JSON.stringify(base));
  t.language = 'es';

  // Switched off.
  t.fields.find(f => f.id === 'awards').enabled = false;
  t.fields.find(f => f.id === 'reviews').enabled = false;

  // Reworded.
  t.fields.find(f => f.id === 'competitors').label = { en: 'Who else?', es: '¿Quién más?' };

  // Retyped: long text becomes multiple choice.
  const pain = t.fields.find(f => f.id === 'pain-type');
  pain.type = 'multi';
  pain.options = [
    { value: 'cost', label: { en: 'Cost', es: 'Costo' } },
    { value: 'downtime', label: { en: 'Downtime', es: 'Paro' } },
    { value: 'quality', label: { en: 'Quality', es: 'Calidad' } }
  ];

  // Retyped: text becomes a number.
  t.fields.find(f => f.id === 'years-business').type = 'number';

  // A new section with a new question in it.
  t.sections.push({ id: 'extra-section', order: 99, title: { en: 'Operations', es: 'Operaciones' }, custom: true });
  t.fields.push({ id: 'extra-shifts', section: 'extra-section', custom: true, type: 'textarea',
    paths: ['extra.shifts'], label: { en: 'Shifts?', es: '¿Turnos?' } });
  t.fields.push({ id: 'extra-fleet', section: 'extra-section', custom: true, type: 'select',
    paths: ['extra.fleet'], label: { en: 'Fleet size', es: 'Tamaño de flota' },
    options: [{ value: 'small', label: { en: 'Small', es: 'Chica' } }, { value: 'big', label: { en: 'Big', es: 'Grande' } }] });

  // Reordered: move the last question of panel-0 to the front of it.
  const inFirst = t.fields.filter(f => f.section === 'panel-0' && !f.custom);
  const last = inFirst[inFirst.length - 1];
  t.fields.splice(t.fields.indexOf(last), 1);
  t.fields.splice(t.fields.indexOf(inFirst[0]), 0, last);

  return t;
}

// The four sub-forms the page owns. Held here so both halves of the trip use the same ones.
const SUB = {
  social: ['linkedin', 'facebook'],
  brands: ['Bosch', 'Siemens'],
  sites: [{ url: 'https://b.example', status: 'broken' }],
  personas: [{ name: 'Planta', role: 'Jefe' }]
};
const sources = (w) => ({
  socialTags: () => SUB.social.slice(),
  brandTags: () => SUB.brands.slice(),
  getSites: () => JSON.parse(JSON.stringify(SUB.sites)),
  getPersonas: () => JSON.parse(JSON.stringify(SUB.personas))
});
// On the way back in, the page would repopulate its own widgets; record what it was handed.
function sinks(store) {
  return {
    socialTags: v => { store.social = v; },
    brandTags: v => { store.brands = v; },
    getSites: v => { store.sites = v; },
    getPersonas: v => { store.personas = v; }
  };
}

const tpl = tailor();

// ── Fill everything the tailored form actually shows ──
const w1 = freshPage();
w1.akoreIntakeForm.apply(tpl, 'es');

let filled = 0, skippedOff = 0;
for (const f of tpl.fields) {
  const el = w1.document.getElementById(f.id);
  if (!el) continue;
  if (f.enabled === false) { skippedOff++; continue; }
  if (f.type === 'multi') {
    const boxes = el.querySelectorAll('input[type=checkbox]');
    boxes[0].checked = true; boxes[2].checked = true; filled++;
  } else if (el.tagName === 'SELECT') {
    const opt = [...el.options].find(o => o.value);
    if (opt) { el.value = opt.value; filled++; }
  } else if (f.type === 'tags') {
    // owned by the page, carried by the widgets above
  } else {
    el.value = f.type === 'number' ? '38' : 'v-' + f.id;
    filled++;
  }
}
check('the tailored form has controls to fill', filled > 40, filled + ' filled');
check('and the switched-off questions were skipped', skippedOff === 2, String(skippedOff));

const saved = JSON.parse(JSON.stringify(w1.akoreIntakeForm.collect(tpl, sources(w1))));

console.log('\nWhat the form saves:\n');
{
  check('a switched-off question is absent, not blank',
    !(saved.proof && 'awards' in saved.proof), JSON.stringify(saved.proof));
  check('a multiple-choice answer is a list',
    Array.isArray(saved.problem.painType) && saved.problem.painType.length === 2,
    JSON.stringify(saved.problem.painType));
  check('an added question is saved under extra.', saved.extra && saved.extra.shifts === 'v-extra-shifts',
    JSON.stringify(saved.extra));
  check('the four sub-forms are carried',
    JSON.stringify(saved.general.socialPlatforms) === JSON.stringify(SUB.social)
    && JSON.stringify(saved.proof.brands) === JSON.stringify(SUB.brands)
    && saved.websites.additionalSites.length === 1 && saved.customer.personas.length === 1,
    JSON.stringify({ s: saved.general.socialPlatforms, b: saved.proof.brands }));
  check('a number is stored as what was typed', saved.proof.yearsBusiness === '38', saved.proof.yearsBusiness);
}

// ── Come back to a brand new page, restore, and collect again ──
console.log('\nComing back to it:\n');
const w2 = freshPage();
w2.akoreIntakeForm.apply(tpl, 'es');
const widgetStore = {};
w2.akoreIntakeForm.populate(tpl, saved, sinks(widgetStore));
const again = JSON.parse(JSON.stringify(w2.akoreIntakeForm.collect(tpl, sources(w2))));

function flatten(obj, prefix, out) {
  out = out || {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = JSON.stringify(v);
  }
  return out;
}
const a = flatten(saved), b = flatten(again);
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const differing = keys.filter(k => a[k] !== b[k]);

check('every answer comes back exactly as it went in', differing.length === 0,
  differing.slice(0, 6).map(k => `${k}: ${a[k]} -> ${b[k]}`).join(' | '));
check('the round trip covered the whole form', keys.length >= 45, keys.length + ' paths');

// The ones that fail in their own particular way, named so a regression says which.
check('multiple-choice ticks are restored',
  JSON.stringify(again.problem.painType) === JSON.stringify(saved.problem.painType),
  JSON.stringify(again.problem.painType));
check('a retyped number comes back', again.proof.yearsBusiness === '38', again.proof.yearsBusiness);
check('an added question comes back', again.extra.shifts === 'v-extra-shifts', JSON.stringify(again.extra));
check('an added dropdown comes back', again.extra.fleet === saved.extra.fleet, again.extra.fleet);
check('the page was handed its widgets back to repopulate',
  JSON.stringify(widgetStore.social) === JSON.stringify(SUB.social)
  && JSON.stringify(widgetStore.brands) === JSON.stringify(SUB.brands)
  && Array.isArray(widgetStore.sites) && Array.isArray(widgetStore.personas),
  JSON.stringify(widgetStore));

// ── And the customer who was never tailored is unaffected ──
console.log('\nA customer on the standard form is untouched by any of it:\n');
{
  const w3 = freshPage();
  w3.akoreIntakeForm.apply(JSON.parse(JSON.stringify(base)), 'es');
  for (const f of base.fields) {
    const el = w3.document.getElementById(f.id);
    if (!el || f.type === 'tags') continue;
    if (el.tagName === 'SELECT') { const o = [...el.options].find(x => x.value); if (o) el.value = o.value; }
    else if (el.tagName !== 'DIV') el.value = 'd-' + f.id;
  }
  const plain = w3.akoreIntakeForm.collect(base, sources(w3));
  const w4 = freshPage();
  w4.akoreIntakeForm.apply(JSON.parse(JSON.stringify(base)), 'es');
  w4.akoreIntakeForm.populate(base, plain, sinks({}));
  const plainAgain = w4.akoreIntakeForm.collect(base, sources(w4));
  const pa = flatten(plain), pb = flatten(plainAgain);
  const diff = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter(k => pa[k] !== pb[k]);
  check('the standard form round-trips too', diff.length === 0,
    diff.slice(0, 5).map(k => `${k}: ${pa[k]} -> ${pb[k]}`).join(' | '));
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
