// Every page loads and runs its own startup without throwing.
//
// A page that throws on load stops executing at that line. Whatever was going to be wired up below
// it never is, and the page still renders, because the markup was already parsed — so the failure
// looks like a feature that was never built rather than one that broke. That is exactly how a
// deleted openIntakeEditor() reached a browser with twenty-four suites green.
//
// Nothing is asserted here about what a page shows. Only that it gets through its own startup, with
// its real scripts, against a network that answers plausibly.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'intake-template.default.json'), 'utf8'));

// Answers shaped like the real ones, so startup takes its normal path rather than its error path.
const ROUTES = [
  [/\/api\/login/, () => ({ username: 'akore-local', kind: 'staff', role: 'admin', company: '' })],
  [/\/api\/intake-template/, () => ({ company: 'Demo', draft: null, released: null, unreleasedChanges: false })],
  [/intake-template\.default\.json/, () => template],
  [/\/api\/intake-codes/, () => ({ company: 'Demo', username: 'demo', monitoringEnabled: false })],
  [/\/api\/intake\b/, () => ({ company: 'Demo', intake: {}, savedAt: '2026-09-01T00:00:00Z' })],
  [/\/api\/prompts/, () => ({ company: 'Demo', promptsText: 'one\ntwo', promptCount: 2 })],
  [/\/api\/audit-job/, () => ({ status: 'none' })],
  [/\/api\/geo-scan-job/, () => ({ status: 'none' })],
  [/\/api\/customer-keys/, () => ({ claude: true, chatgpt: false, gemini: false })],
  [/\/api\/staff-users/, () => ({ items: [] })]
];

// Pages are loaded with their own <script src> files inlined, because jsdom will not fetch them.
function pageWithScripts(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(
    /<script src="([^"]+)"><\/script>/g,
    (m, src) => {
      const p = path.join(ROOT, src.replace(/^\//, ''));
      return fs.existsSync(p) ? '<script>' + fs.readFileSync(p, 'utf8') + '</script>' : '';
    });
}

// Proof a page's startup reached the end, not just that nothing shouted on the way.
const RENDERED = {
  'index.html': d => d.querySelectorAll('#main-content .card').length >= 3
    || 'main-content has ' + d.querySelectorAll('#main-content .card').length + ' cards',
  'portal.html': d => {
    const el = d.getElementById('customers-list');
    if (!el) return 'no customers-list element';
    // Rendered means it got past its own placeholder, whatever it then found to show.
    return (el.children.length > 0 || el.textContent.trim().length > 0)
      || 'customers-list was never filled in';
  },
  'intake.html': d => !!d.getElementById('access-gate') && !!d.getElementById('company')
    || 'the form did not render',
  'client-portal.html': d => !!d.getElementById('access-gate') || 'no gate rendered',
  'prompt-review.html': d => !!d.getElementById('access-gate') || 'no gate rendered'
};

const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));

(async () => {
  for (const page of PAGES) {
    const errors = [];
    const vc = new VirtualConsole();
    // jsdom cannot navigate, and a page redirecting a signed-in visitor is it working, not failing.
    // Everything else counts.
    vc.on('jsdomError', e => {
      const first = e.message.split('\n')[0];
      if (/Not implemented: navigation/.test(first)) return;
      errors.push(first);
    });

    let dom;
    try {
      dom = new JSDOM(pageWithScripts(page), {
        url: 'https://t.local/' + page + '?company=Demo&username=demo',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(w) {
          w.alert = () => {};
          w.confirm = () => false;
          w.scrollTo = () => {};
          w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
          w.fetch = async (u) => {
            const s = String(u);
            const hit = ROUTES.find(([re]) => re.test(s));
            const body = hit ? hit[1]() : {};
            const text = /\/api\/results/.test(s) ? '' : JSON.stringify(body);
            // Duck-typed rather than a real Response: jsdom does not expose the constructor in
            // every window, and the pages only ever use these four members.
            return { ok: true, status: 200, json: async () => JSON.parse(text || '{}'),
                     text: async () => text, headers: { get: () => 'application/json' } };
          };
          // Most of a page's startup happens inside promises, and a rejected one is not a
          // jsdomError — it is silent. Deleting loadCompany() from index.html produced a clean pass
          // until these two were added, which is precisely the failure this file exists to catch.
          w.addEventListener('unhandledrejection', ev => {
            const r = ev && ev.reason;
            errors.push('unhandled rejection: ' + ((r && r.message) || r));
          });
          w.addEventListener('error', ev => {
            if (ev && ev.message) errors.push(ev.message);
          });
          // A staff session in storage, so internal pages take their signed-in path.
          try { w.localStorage.setItem('akore_staff_session', 'test-session'); } catch (e) {}
        }
      });
    } catch (e) {
      check(page + ' — loads without throwing', false, 'construction threw: ' + e.message);
      continue;
    }

    // Let startup and its first round of promises settle.
    await new Promise(r => setTimeout(r, 250));

    check(page + ' — loads and starts up without throwing', errors.length === 0,
      errors.slice(0, 2).join(' | '));

    // Absence of a reported error is not proof a page ran. jsdom does not fire
    // unhandledrejection, and most of these pages do their work in an un-awaited async call — so a
    // ReferenceError inside startup is completely silent. Deleting loadCompany() from index.html
    // passed the error check cleanly. What it cannot fake is having rendered.
    const signal = RENDERED[page];
    if (signal) {
      let got = '';
      try { got = signal(dom.window.document); } catch (e) { got = 'threw: ' + e.message; }
      check(page + ' — startup actually rendered the page', got === true, String(got));
    }

    try { dom.window.close(); } catch (e) {}
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
