// What staff can actually read back after tailoring a customer's form.
//
// Every card in this viewer is a hand-written list of the original questions, written when the form
// was the same for everyone. Once staff could add a question, the customer answered it and nobody
// could ever see the answer: it was collected, stored, and rendered by nothing. A form that can ask
// something no one can read is worse than a form that cannot ask it.
//
// The second half is quieter. A multiple-choice answer is a list, and the viewer passed every value
// through esc() — so two choices came out as "cost,quality", joined by a comma the customer never
// typed and indistinguishable from a single answer that happened to contain one.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

function page() {
  return fs.readFileSync(path.join(ROOT, 'intake-view.html'), 'utf8').replace(
    /<script src="([^"]+)"><\/script>/g,
    (m, src) => {
      const p = path.join(ROOT, src.replace(/^\//, ''));
      return fs.existsSync(p) ? '<script>' + fs.readFileSync(p, 'utf8') + '</script>' : '';
    });
}

const TEMPLATE = {
  fields: [
    { id: 'extra-shifts', custom: true, paths: ['extra.shifts'],
      label: { en: 'Shift pattern?', es: '¿Qué turnos manejan?' } },
    { id: 'extra-fleet', custom: true, paths: ['extra.fleet'],
      label: { en: 'Fleet size', es: 'Tamaño de flota' } }
  ]
};
const INTAKE = {
  general: { company: 'Demo', website: 'https://demo.example' },
  problem: { painType: ['cost', 'quality'] },
  extra: { shifts: 'Tres turnos', fleet: '', unlabelled: 'kept anyway' }
};

// The page's own <script> blocks are inside <body>, so body.textContent includes the source — and a
// check for a string the code merely mentions in a comment passes or fails for the wrong reason.
// Only what was rendered counts.
function visibleText(doc) {
  const main = doc.getElementById('main-content') || doc.body;
  const clone = main.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(el => el.remove());
  return clone.textContent;
}

function render(opts) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message.split('\n')[0]));
  const dom = new JSDOM(page(), {
    url: 'https://t.local/intake-view.html?company=Demo',
    runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      try { w.localStorage.setItem('akore_staff_session', 's'); } catch (e) {}
      w.fetch = async (u) => {
        const s = String(u);
        const J = o => ({ ok: true, status: 200, json: async () => o });
        if (s.indexOf('/api/login') !== -1) return J({ username: 'a', kind: 'staff', role: 'admin' });
        if (s.indexOf('/api/intake-template') !== -1) {
          if (opts && opts.noTemplate) return { ok: false, status: 500, json: async () => ({}) };
          return J({ company: 'Demo', released: TEMPLATE });
        }
        if (s.indexOf('/api/intake') !== -1) {
          return J({ company: 'Demo', savedAt: '2026-09-01T00:00:00Z', intake: INTAKE });
        }
        return J({});
      };
    }
  });
  return new Promise(resolve => setTimeout(() => resolve({ dom, errors }), 350));
}

(async () => {
  console.log('Reading back a tailored intake:\n');
  {
    const { dom, errors } = await render();
    const doc = dom.window.document;
    const text = visibleText(doc);
    check('the viewer renders without error', errors.length === 0, errors[0] || '');

    check('an added question is shown at all', text.indexOf('Tres turnos') !== -1,
      'the answer is nowhere on the page');
    check('and under the question as it was actually asked',
      text.indexOf('¿Qué turnos manejan?') !== -1, 'the wording is missing');
    check('an added question left blank is not shown as an empty row',
      text.indexOf('Tamaño de flota') === -1, 'an unanswered question was listed');
    check('an answer whose question is gone from the template is still shown',
      text.indexOf('kept anyway') !== -1, 'it was dropped');

    const chips = [...doc.querySelectorAll('.tag')].map(t => t.textContent);
    check('a multiple-choice answer is shown as separate answers',
      chips.indexOf('cost') !== -1 && chips.indexOf('quality') !== -1, JSON.stringify(chips));
    check('and not run together into one string', text.indexOf('cost,quality') === -1,
      'it rendered as a comma-joined string');

    try { dom.window.close(); } catch (e) {}
  }

  console.log('\nWhen the template cannot be read:\n');
  {
    // The labels are a nicety. The answers are not — losing them because a second request failed
    // would be the viewer choosing to show nothing over showing something.
    const { dom, errors } = await render({ noTemplate: true });
    const text = visibleText(dom.window.document);
    check('the page still renders', errors.length === 0, errors[0] || '');
    check('the answers are still shown', text.indexOf('Tres turnos') !== -1, 'the answer was lost');
    check('under their storage key, since the wording is unavailable',
      text.indexOf('shifts') !== -1, 'no label at all');
    try { dom.window.close(); } catch (e) {}
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
