// The intake editor as it behaves when rendered, not as it reads in the source.
//
// The first version of this editor was reviewed by its author and shipped, and every complaint it
// came back with was something a render would have shown: an English box offered to a customer set
// to Spanish only, questions marked permanently locked that nothing actually required, dropdown
// choices as pipe-delimited text someone had to punctuate correctly, and no way to add or remove a
// section at all. So the editor is now driven here the way a person drives it.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const pageSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = [...pageSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// Just the editor. Pulling the whole page in would drag the audit poller and its network calls with it.
const from = inline.indexOf('const TPL_GROUND_TRUTH');
const to = inline.indexOf('/** Writes the draft. Never changes what the customer is being served. */');
check('the editor block was found in index.html', from !== -1 && to > from, `${from}..${to}`);
if (from === -1 || to <= from) { console.log('\n1 FAILURE(S)'); process.exit(1); }
const editorSrc = inline.slice(from, to);

// The modal the editor draws into, as index.html declares it.
const MODAL = `<div class="modal-backdrop" id="intake-tpl-modal"><div class="modal-box wide">
  <div id="intake-tpl-title"></div>
  <select id="tpl-language"><option value="both"></option><option value="es"></option><option value="en"></option></select>
  <div id="tpl-body"></div><div id="tpl-status"></div></div></div>`;

function boot(template) {
  const dom = new JSDOM('<!doctype html><body>' + MODAL + '<div id="unused"></div></body>', {
    url: 'https://test.local/index.html', runScripts: 'outside-only', virtualConsole: new VirtualConsole()
  });
  const w = dom.window;
  // The page pieces the editor leans on, stubbed to their real behaviour and nothing more.
  w.eval(`
    var lang = 'es';
    var currentCompany = 'Demo';
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function t(k, a, b) { return typeof k === 'string' ? k + (a !== undefined ? ':' + a : '') : ''; }
  `);
  w.confirm = () => true;
  // One eval, because `let intakeEditor` is scoped to the script that declares it — a second
  // eval assigning to it would create a different binding and the editor would keep reading its own.
  // `run` is a direct eval inside that scope, so a test can call the editor's functions by name.
  w.eval(editorSrc + `
    intakeEditor = ${JSON.stringify({ company: 'Demo', template, releasedAt: null, unreleased: false })};
    window.__ed = () => intakeEditor;
    window.__run = src => eval(src);
    renderIntakeEditor();
  `);
  return w;
}

const baseTemplate = () => ({
  version: 1,
  language: 'both',
  sections: [
    { id: 'panel-0', order: 0, title: { en: 'General', es: 'General' } },
    { id: 'panel-1', order: 1, title: { en: 'Customer', es: 'Cliente' } }
  ],
  fields: [
    { id: 'company', section: 'panel-0', type: 'text', paths: ['general.company'], label: { en: 'Company', es: 'Empresa' } },
    { id: 'industry', section: 'panel-0', type: 'text', paths: ['general.industry'], label: { en: 'Industry', es: 'Industria' } },
    { id: 'gbp', section: 'panel-0', type: 'select', paths: ['general.googleBusinessProfile'],
      label: { en: 'Google profile?', es: '¿Perfil de Google?' },
      options: [{ value: 'yes', label: { en: 'Yes', es: 'Sí' } }, { value: 'no', label: { en: 'No', es: 'No' } }] },
    { id: 'ideal', section: 'panel-1', type: 'textarea', paths: ['customer.idealCustomer'], label: { en: 'Ideal customer', es: 'Cliente ideal' } }
  ]
});

const rowOf = (w, id) => w.document.querySelector(`.tpl-row[ondragstart*="'${id}'"]`);
const wordingInputs = (w, id) => rowOf(w, id).querySelectorAll(':scope > .tpl-words > input[type=text]');

console.log('\nA customer who fills the form in one language:\n');
{
  const both = boot(baseTemplate());
  check('with both languages there are two wording boxes', wordingInputs(both, 'company').length === 2,
    String(wordingInputs(both, 'company').length));

  const es = boot(Object.assign(baseTemplate(), { language: 'es' }));
  check('set to Spanish only there is one', wordingInputs(es, 'company').length === 1,
    String(wordingInputs(es, 'company').length));
  check('and it holds the Spanish wording, not the English',
    wordingInputs(es, 'company')[0].value === 'Empresa', wordingInputs(es, 'company')[0].value);

  // The dropdown choices have to narrow with it, or the English column comes back through them.
  const optRow = rowOf(es, 'gbp').querySelector('.tpl-opt');
  check('a dropdown choice shows one wording box too', optRow.querySelectorAll('input[type=text]').length === 2,
    optRow.querySelectorAll('input[type=text]').length + ' (value + one wording)');

  const en = boot(Object.assign(baseTemplate(), { language: 'en' }));
  check('set to English only it is the English wording', wordingInputs(en, 'company')[0].value === 'Company',
    wordingInputs(en, 'company')[0].value);

  // Changing the setting must redraw, not wait for a reopen.
  both.__run("tplSetLanguage('es')");
  check('changing the language redraws the columns immediately',
    wordingInputs(both, 'company').length === 1, String(wordingInputs(both, 'company').length));
}

console.log('\nEvery question is the operator\'s to change:\n');
{
  const w = boot(baseTemplate());
  check('nothing is rendered as locked', w.document.querySelectorAll('.tpl-row').length === 4
    && [...w.document.querySelectorAll('.tpl-row')].every(r => r.querySelector('.tpl-switch input')),
    'a row has no on/off switch');
  check('every question can be deleted, including the first three',
    [...w.document.querySelectorAll('.tpl-row')].every(r => r.querySelector('.tpl-icon.danger')),
    'a row has no delete button');

  w.__run('tplToggle(0, false)');
  check('switching one off records it', w.__ed().template.fields[0].enabled === false,
    String(w.__ed().template.fields[0].enabled));
  check('and it is visibly off', rowOf(w, 'company').classList.contains('off'), rowOf(w, 'company').className);

  w.__run('tplRemove(0)');
  check('deleting a question removes it', !w.__ed().template.fields.some(f => f.id === 'company'),
    'still present');
}

console.log('\nDropdown choices are edited as choices:\n');
{
  const w = boot(baseTemplate());
  check('each choice is its own row', rowOf(w, 'gbp').querySelectorAll('.tpl-opt').length === 2,
    String(rowOf(w, 'gbp').querySelectorAll('.tpl-opt').length));
  check('the page has no pipe-delimited textarea left in it',
    !/one per line, as value \| English/.test(pageSrc), 'the old options textarea is still there');

  w.__run("tplOption(2, 0, 'es', 'Sí, completo')");
  check('editing a choice updates it', w.__ed().template.fields[2].options[0].label.es === 'Sí, completo',
    w.__ed().template.fields[2].options[0].label.es);

  w.__run('tplAddOption(2)');
  check('a choice can be added', w.__ed().template.fields[2].options.length === 3,
    String(w.__ed().template.fields[2].options.length));
  w.__run('tplRemoveOption(2, 0)');
  check('and removed', w.__ed().template.fields[2].options.length === 2
    && w.__ed().template.fields[2].options[0].value === 'no',
    JSON.stringify(w.__ed().template.fields[2].options.map(o => o.value)));
}

console.log('\nEvery question says what kind of answer it wants:\n');
{
  const w = boot(baseTemplate());
  const typeSel = id => rowOf(w, id).querySelector('.tpl-type');
  check('each question has a type selector', !!typeSel('company') && !!typeSel('ideal'), 'missing');
  check('it shows the type the question currently is', typeSel('ideal').value === 'textarea',
    typeSel('ideal').value);
  check('and offers the kinds a form can ask for',
    ['textarea', 'text', 'select', 'multi', 'number', 'date', 'url', 'email']
      .every(v => [...typeSel('company').options].some(o => o.value === v)),
    [...typeSel('company').options].map(o => o.value).join(','));

  // Choosing a choice type with nothing to choose from is a dead end in the form, so it arrives
  // with empty choices ready to type into.
  w.__run("tplType(0, 'select')");
  check('switching to single choice records it', w.__ed().template.fields[0].type === 'select',
    w.__ed().template.fields[0].type);
  check('and seeds empty choices rather than none', (w.__ed().template.fields[0].options || []).length === 2,
    String((w.__ed().template.fields[0].options || []).length));
  check('which are shown as choice rows straight away',
    rowOf(w, 'company').querySelectorAll('.tpl-opt').length === 2,
    String(rowOf(w, 'company').querySelectorAll('.tpl-opt').length));

  // Multiple choice edits its choices the same way single choice does.
  w.__run("tplType(3, 'multi')");
  check('multiple choice also gets a choices editor',
    rowOf(w, 'ideal').querySelectorAll('.tpl-opt').length === 2,
    String(rowOf(w, 'ideal').querySelectorAll('.tpl-opt').length));

  // Choices already written are kept when the type changes between the two choice kinds.
  w.__run("tplType(2, 'multi')");
  check('an existing dropdown keeps its choices when it becomes multiple choice',
    w.__ed().template.fields[2].options.map(o => o.value).join(',') === 'yes,no',
    JSON.stringify(w.__ed().template.fields[2].options.map(o => o.value)));

  // A plain-text question has nothing to choose from, and must not show an empty choices box.
  w.__run("tplType(1, 'number')");
  check('a number question shows no choices editor',
    rowOf(w, 'industry').querySelectorAll('.tpl-opt').length === 0,
    String(rowOf(w, 'industry').querySelectorAll('.tpl-opt').length));
}

console.log('\nSections:\n');
{
  const w = boot(baseTemplate());
  check('sections are listed', w.document.querySelectorAll('.tpl-section').length === 2,
    String(w.document.querySelectorAll('.tpl-section').length));

  w.__run('tplAddSection()');
  check('one can be added', w.__ed().template.sections.length === 3,
    String(w.__ed().template.sections.length));
  check('and it appears with a question button', w.document.querySelectorAll('.tpl-section').length === 3,
    String(w.document.querySelectorAll('.tpl-section').length));

  w.__run("tplAdd('panel-1')");
  const added = w.__ed().template.fields.filter(f => f.custom);
  check('a question can be added straight into a section without a dialog',
    added.length === 1 && added[0].section === 'panel-1', JSON.stringify(added.map(f => f.section)));
  check("and it is stored where nothing else reads", /^extra\./.test(added[0].paths[0]), added[0].paths[0]);

  w.__run("tplDeleteSection('panel-0')");
  check('deleting a section removes it', !w.__ed().template.sections.some(s => s.id === 'panel-0'),
    'still present');
  check('and takes its questions with it rather than orphaning them',
    !w.__ed().template.fields.some(f => f.section === 'panel-0'),
    JSON.stringify(w.__ed().template.fields.map(f => f.section)));
}

console.log('\nReordering by dragging:\n');
{
  const w = boot(baseTemplate());
  const ev = () => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { setData() {} } });
  w.ev = ev;

  w.__run("tplDragStart({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'field', 'industry')");
  w.__run("tplDrop({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'field', 'company')");
  check('a question can be moved above another',
    w.__ed().template.fields.map(f => f.id).indexOf('industry') === 0,
    JSON.stringify(w.__ed().template.fields.map(f => f.id)));

  // Dropping onto a question in another section moves it there, which is the obvious reading.
  w.__run("tplDragStart({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'field', 'gbp')");
  w.__run("tplDrop({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'field', 'ideal')");
  check('dragging it onto another section moves it into that section',
    w.__ed().template.fields.find(f => f.id === 'gbp').section === 'panel-1',
    w.__ed().template.fields.find(f => f.id === 'gbp').section);

  const w2 = boot(baseTemplate());
  w2.__run("tplDragStart({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'section', 'panel-1')");
  w2.__run("tplDrop({preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}}, 'section', 'panel-0')");
  const order = w2.__ed().template.sections.slice().sort((a, b) => a.order - b.order).map(s => s.id);
  check('sections can be reordered too', order[0] === 'panel-1', JSON.stringify(order));
}


(async () => {
console.log('\nOpening it, the way the button does:\n');
{
  // The button was dead on arrival once, because a rewrite replaced the block of the page that
  // happened to define openIntakeEditor() and did not put it back. This suite was green through
  // all of it: it called renderIntakeEditor() directly and never opened anything.
  const run = async (rec) => {
    const w = boot(baseTemplate());
    w.__run(`
      window.apiQuery = async (e, p) => e;
      window.fetch = async (u) => {
        const s = String(u);
        const body = s.indexOf('/api/intake-template') !== -1
          ? ${JSON.stringify('REC')}
          : ${JSON.stringify('DEFAULT')};
        return { ok: true, json: async () => JSON.parse(body === 'REC' ? window.__rec : window.__default) };
      };
    `);
    w.__rec = JSON.stringify(rec);
    w.__default = JSON.stringify(Object.assign(baseTemplate(), { language: 'both' }));
    // Caught, so a missing handler is reported as a failed check rather than crashing the suite
    // and taking every assertion after it down with it.
    try { await w.__run('openIntakeEditor()'); }
    catch (e) { w.__openError = String(e && e.message || e); }
    return w;
  };

  const fresh = await run({ company: 'Demo', draft: null, released: null });
  check('openIntakeEditor() exists and runs', !fresh.__openError, fresh.__openError || '');
  check('the modal is actually opened',
    fresh.document.getElementById('intake-tpl-modal').classList.contains('open'), 'never opened');
  check('and it is populated with the standard questions',
    fresh.document.querySelectorAll('.tpl-row').length === 4,
    String(fresh.document.querySelectorAll('.tpl-row').length));

  // A draft in progress is what you continue from, not the released copy underneath it.
  const draft = Object.assign(baseTemplate(), { language: 'es' });
  draft.fields = draft.fields.slice(0, 2);
  const cont = await run({ company: 'Demo', draft, released: baseTemplate(), unreleasedChanges: true });
  check('an unfinished draft is what reopens, not the released version',
    cont.document.querySelectorAll('.tpl-row').length === 2,
    String(cont.document.querySelectorAll('.tpl-row').length));
  check('and its language setting comes back with it',
    cont.document.getElementById('tpl-language').value === 'es',
    cont.document.getElementById('tpl-language').value);
  check('the unreleased-changes note is shown on open',
    !!cont.document.getElementById('tpl-status').textContent, 'nothing said');

  const closed = await run({ company: 'Demo', draft: null, released: null });
  closed.__run('closeIntakeEditor()');
  check('closeIntakeEditor() exists and closes it',
    !closed.document.getElementById('intake-tpl-modal').classList.contains('open'), 'still open');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
})();
