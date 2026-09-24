// Tweaking the intake per customer: what a staff edit to the template actually does to the form.
//
// This is the feature itself, so it is tested against the real intake.html markup rather than a
// fixture. Four things have to hold, and each of them is a way the feature could look finished and
// not be: a question switched off must disappear AND stop being saved (hiding it while still
// writing an empty value under its key leaves generation reading a field the customer never saw);
// re-worded copy must land in both languages, because the page swaps them from data-en/data-es and
// a Spanish-only edit would read as English the moment someone toggled; a replaced dropdown must
// not silently drop what the customer already chose; and an added question has to be collected,
// not merely drawn.
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

function freshPage() {
  const dom = new JSDOM(pageSrc, {
    url: 'https://test.local/intake.html',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'js', 'intake-template.js'), 'utf8'));
  return dom.window;
}
const clone = () => JSON.parse(JSON.stringify(base));
const fieldOf = (tpl, id) => tpl.fields.find(f => f.id === id);
const groupOf = el => { while (el && !(el.classList && el.classList.contains('field-group'))) el = el.parentElement; return el; };

console.log('Switching a question off:\n');
{
  const w = freshPage();
  const tpl = clone();
  fieldOf(tpl, 'awards').enabled = false;
  w.akoreIntakeForm.apply(tpl, 'es');

  const el = w.document.getElementById('awards');
  check('the question is hidden', groupOf(el) && groupOf(el).style.display === 'none',
    groupOf(el) ? groupOf(el).style.display : 'no group');

  // The half that is easy to forget: still collecting it writes a key for a question nobody saw.
  el.value = 'should not be saved';
  const data = w.akoreIntakeForm.collect(tpl, {});
  check('and it is not saved either', !(data.proof && 'awards' in data.proof),
    JSON.stringify(data.proof));

  // A question left on must be unaffected by its neighbour going off.
  const kept = w.document.getElementById('reviews');
  check('the questions around it are untouched', groupOf(kept).style.display !== 'none',
    groupOf(kept).style.display);
}

console.log('\nRe-wording a question:\n');
{
  const w = freshPage();
  const tpl = clone();
  fieldOf(tpl, 'competitors').label = { en: 'Who else do they call?', es: '¿A quién más le llaman?' };
  w.akoreIntakeForm.apply(tpl, 'es');

  const label = groupOf(w.document.getElementById('competitors')).querySelector('label');
  check('the new wording is set for Spanish', label.getAttribute('data-es') === '¿A quién más le llaman?',
    label.getAttribute('data-es'));
  check('and for English, so the toggle still works', label.getAttribute('data-en') === 'Who else do they call?',
    label.getAttribute('data-en'));
}

console.log('\nChanging a dropdown:\n');
{
  const w = freshPage();
  const tpl = clone();
  const f = fieldOf(tpl, 'pain-type');
  f.options = [
    { value: 'cost', label: { en: 'Cost', es: 'Costo' } },
    { value: 'downtime', label: { en: 'Downtime', es: 'Paro de línea' } }
  ];
  const sel = w.document.getElementById('pain-type');
  w.akoreIntakeForm.apply(tpl, 'es');

  check('the options are replaced', [...sel.options].map(o => o.value).join(',') === 'cost,downtime',
    [...sel.options].map(o => o.value).join(','));
  check('and are worded in the chosen language', sel.options[1].textContent === 'Paro de línea',
    sel.options[1].textContent);

  // Re-applying must not wipe an answer already given — apply() runs before saved answers are
  // restored, but also on a language switch, with the customer's choice already in the field.
  sel.value = 'downtime';
  w.akoreIntakeForm.apply(tpl, 'en');
  check('a choice the customer already made survives re-applying', sel.value === 'downtime', sel.value);
}

console.log('\nAdding a question:\n');
{
  const w = freshPage();
  const tpl = clone();
  tpl.fields.push({
    id: 'shift-pattern', section: 'panel-2', custom: true, type: 'textarea',
    paths: ['problem.shiftPattern'],
    label: { en: 'What shift pattern do they run?', es: '¿Qué turnos manejan?' },
    help: { en: 'Only asked of manufacturers.', es: 'Solo se pregunta a fabricantes.' }
  });
  w.akoreIntakeForm.apply(tpl, 'es');

  const el = w.document.getElementById('shift-pattern');
  check('the question is drawn into its own section', !!el && w.document.getElementById('panel-2').contains(el),
    el ? 'wrong section' : 'not rendered');
  check('it is the right kind of control', el && el.tagName === 'TEXTAREA', el && el.tagName);

  el.value = 'Tres turnos';
  const data = w.akoreIntakeForm.collect(tpl, {});
  check('and what is typed into it is saved', data.problem && data.problem.shiftPattern === 'Tres turnos',
    JSON.stringify(data.problem && data.problem.shiftPattern));

  // Applying twice is normal — the language toggle does it — and must not stack duplicates.
  w.akoreIntakeForm.apply(tpl, 'en');
  check('re-applying does not add it twice',
    w.document.querySelectorAll('#panel-2 [data-extra-questions] .field-group').length === 1,
    String(w.document.querySelectorAll('#panel-2 [data-extra-questions] .field-group').length));
}

console.log('\nThe default template changes nothing:\n');
{
  // The safety property behind shipping this at all: every customer starts on the extracted
  // default, so applying it to the page it came from must be a no-op.
  const w = freshPage();
  const before = w.document.getElementById('competitors').closest('.field-group').outerHTML;
  w.akoreIntakeForm.apply(clone(), 'es');
  const after = w.document.getElementById('competitors').closest('.field-group').outerHTML;
  check('applying the default leaves a question as it was', before === after, 'markup changed');

  const hidden = [...w.document.querySelectorAll('.field-group')].filter(g => g.style.display === 'none');
  check('and hides nothing', hidden.length === 0, hidden.length + ' hidden');
  check('and adds nothing', w.document.querySelectorAll('[data-extra-questions]').length === 0,
    String(w.document.querySelectorAll('[data-extra-questions]').length));
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
