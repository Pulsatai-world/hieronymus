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


console.log('\nReordering reaches the customer\'s form:\n');
{
  // The editor can drag questions around. If apply() ignored that, reordering would look like it
  // worked in the editor and change nothing the client ever sees - worse than not offering it.
  const w = freshPage();
  const tpl = clone();
  const inSection = tpl.fields.filter(f => f.section === 'panel-0' && !f.custom).map(f => f.id);
  const [first, second] = inSection;

  // Move the second question above the first.
  const i = tpl.fields.findIndex(f => f.id === second);
  const moved = tpl.fields.splice(i, 1)[0];
  tpl.fields.splice(tpl.fields.findIndex(f => f.id === first), 0, moved);
  w.akoreIntakeForm.apply(tpl, 'es');

  const a = groupOf(w.document.getElementById(first));
  const b = groupOf(w.document.getElementById(second));
  const bIsFirst = !!(b.compareDocumentPosition(a) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  check('a question moved above another really moves in the page', bIsFirst,
    first + ' still precedes ' + second);

  // And a question dragged into another section lands there.
  const w2 = freshPage();
  const tpl2 = clone();
  const mover = tpl2.fields.find(f => f.section === 'panel-0' && !f.custom && f.id !== 'company');
  mover.section = 'panel-2';
  w2.akoreIntakeForm.apply(tpl2, 'es');
  check('a question moved to another section is drawn in that section',
    w2.document.getElementById('panel-2').contains(w2.document.getElementById(mover.id)),
    'still in its old section');
}


console.log('\nChanging what kind of answer a question wants:\n');
{
  // The type used to be whatever the markup was born with. Making it editable is only real if the
  // control in the customer's form is actually replaced — otherwise the editor offers a change the
  // form quietly ignores, which is worse than not offering it.
  const w = freshPage();
  const tpl = clone();
  const f = fieldOf(tpl, 'competitors');
  check('it starts as the markup declares', w.document.getElementById('competitors').tagName === 'TEXTAREA',
    w.document.getElementById('competitors').tagName);

  f.type = 'select';
  f.options = [{ value: 'few', label: { en: 'A few', es: 'Pocos' } }, { value: 'many', label: { en: 'Many', es: 'Muchos' } }];
  w.akoreIntakeForm.apply(tpl, 'es');
  const sel = w.document.getElementById('competitors');
  check('long text becomes a dropdown', sel.tagName === 'SELECT', sel.tagName);
  check('with the choices that were typed in', [...sel.options].map(o => o.value).join(',') === 'few,many',
    [...sel.options].map(o => o.value).join(','));
  sel.value = 'many';
  check('and it is collected like any other answer',
    w.akoreIntakeForm.collect(tpl, {}).competitors.competitors === 'many',
    JSON.stringify(w.akoreIntakeForm.collect(tpl, {}).competitors));

  // A number is a number, so the browser's own keyboard and validation apply.
  const w2 = freshPage();
  const tpl2 = clone();
  fieldOf(tpl2, 'years-business').type = 'number';
  w2.akoreIntakeForm.apply(tpl2, 'es');
  const num = w2.document.getElementById('years-business');
  check('a question can be made a number', num.tagName === 'INPUT' && num.type === 'number',
    num.tagName + '/' + num.type);

  // And back again, because a staff member will change their mind.
  const tpl3 = clone();
  w2.akoreIntakeForm.apply(tpl3, 'es');
  check('and changed back to what it was', w2.document.getElementById('years-business').type === 'text',
    w2.document.getElementById('years-business').type);
}

console.log('\nMultiple choice:\n');
{
  const w = freshPage();
  const tpl = clone();
  const f = fieldOf(tpl, 'pain-type');
  f.type = 'multi';
  f.options = [
    { value: 'cost', label: { en: 'Cost', es: 'Costo' } },
    { value: 'downtime', label: { en: 'Downtime', es: 'Paro de línea' } },
    { value: 'quality', label: { en: 'Quality', es: 'Calidad' } }
  ];
  w.akoreIntakeForm.apply(tpl, 'es');

  const box = w.document.getElementById('pain-type');
  const boxes = box.querySelectorAll('input[type=checkbox]');
  check('every choice gets its own tick box', boxes.length === 3, String(boxes.length));
  check('worded in the language the form is in',
    box.querySelectorAll('span')[1].textContent === 'Paro de línea',
    box.querySelectorAll('span')[1].textContent);

  // More than one answer means the answer is a list, not a string.
  boxes[0].checked = true; boxes[2].checked = true;
  const saved = w.akoreIntakeForm.collect(tpl, {});
  check('more than one answer can be given',
    JSON.stringify(saved.problem.painType) === JSON.stringify(['cost', 'quality']),
    JSON.stringify(saved.problem.painType));

  // And comes back on a return visit, which is the half that silently does not work if populate()
  // only knows how to assign to .value.
  const w2 = freshPage();
  w2.akoreIntakeForm.apply(tpl, 'es');
  w2.akoreIntakeForm.populate(tpl, saved, {});
  const back = [...w2.document.getElementById('pain-type').querySelectorAll('input[type=checkbox]')]
    .filter(c => c.checked).map(c => c.value);
  check('and is restored when the customer comes back',
    JSON.stringify(back) === JSON.stringify(['cost', 'quality']), JSON.stringify(back));
}

console.log('\nThe tag inputs are left alone:\n');
{
  // social-input and brand-input are bespoke chip sub-forms the page owns. Nothing here can rebuild
  // one, so a template naming them must not try — replacing the input would strip the chips.
  const w = freshPage();
  const tpl = clone();
  const before = w.document.getElementById('social-input').outerHTML;
  w.akoreIntakeForm.apply(tpl, 'es');
  check('a tag question is not rebuilt as a plain text box',
    w.document.getElementById('social-input').outerHTML === before, 'it was replaced');
}


console.log('\nA section staff added:\n');
{
  // The page was written with eleven panels and a tab bar to match. A section added years later has
  // neither, so its questions were drawn nowhere and its answers came back empty for ever — the
  // form looked complete and simply could not ask them.
  const w = freshPage();
  const tpl = clone();
  tpl.sections.push({ id: 'extra-ops', order: 99, title: { en: 'Operations', es: 'Operaciones' }, custom: true });
  tpl.fields.push({ id: 'extra-shifts', section: 'extra-ops', custom: true, type: 'textarea',
    paths: ['extra.shifts'], label: { en: 'Shifts?', es: '¿Turnos?' } });
  w.akoreIntakeForm.apply(tpl, 'es');

  const panel = w.document.getElementById('extra-ops');
  check('a panel is created for it', !!panel && panel.classList.contains('panel'), 'no panel');
  check('and it sits before the closing panel, not after it',
    !!panel && !!(panel.compareDocumentPosition(w.document.getElementById('panel-complete'))
      & w.Node.DOCUMENT_POSITION_FOLLOWING), 'it is after panel-complete');

  const tab = w.document.getElementById('tab-extra-ops');
  check('a tab is created for it', !!tab, 'no tab');
  check('worded in the language the form is in',
    !!tab && tab.querySelector('.tab-label').textContent === 'Operaciones',
    tab && tab.querySelector('.tab-label').textContent);
  check('and it sits before the closing tab',
    !!tab && !!(tab.compareDocumentPosition(w.document.getElementById('tab-complete'))
      & w.Node.DOCUMENT_POSITION_FOLLOWING), 'it is after tab-complete');

  check("the question is drawn inside it", !!panel && panel.contains(w.document.getElementById('extra-shifts')),
    'not in the new panel');

  // Applying twice is normal, and must not build a second one.
  w.akoreIntakeForm.apply(tpl, 'en');
  check('applying again does not create it twice',
    w.document.querySelectorAll('#extra-ops').length === 1
    && w.document.querySelectorAll('#tab-extra-ops').length === 1,
    w.document.querySelectorAll('#extra-ops').length + ' panels');
}

console.log('\nThe order the customer steps through:\n');
{
  const w = freshPage();
  const tpl = clone();
  tpl.sections.find(s => s.id === 'panel-4').enabled = false;
  tpl.sections.push({ id: 'extra-ops', order: 99, title: { en: 'Ops', es: 'Ops' }, custom: true });
  w.akoreIntakeForm.apply(tpl, 'es');

  const order = w.akoreIntakeForm.sectionOrder(tpl);
  check('a switched-off section is not a step any more', order.indexOf('panel-4') === -1,
    JSON.stringify(order));
  check('and its tab is hidden rather than left as a dead button',
    w.document.getElementById('tab-4').style.display === 'none',
    w.document.getElementById('tab-4').style.display);
  check('an added section is a step', order[order.length - 1] === 'extra-ops', JSON.stringify(order.slice(-2)));
  check('the rest keep the order they were in',
    order[0] === 'panel-0' && order[1] === 'panel-websites', JSON.stringify(order.slice(0, 2)));

  // The naming rule the page navigates by. A plain replace() of "panel-" returned the panel's own
  // id for an added section, and the page then looked for a tab that could never exist.
  check('a built-in section maps to its tab', w.akoreIntakeForm.tabIdFor('panel-websites') === 'tab-websites',
    w.akoreIntakeForm.tabIdFor('panel-websites'));
  check('and an added one gets a tab id of its own', w.akoreIntakeForm.tabIdFor('extra-ops') === 'tab-extra-ops',
    w.akoreIntakeForm.tabIdFor('extra-ops'));
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
