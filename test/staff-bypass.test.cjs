// What a client-facing page does when the person looking at it is staff.
//
// All three client pages are drawn for the person whose data they show, and staff can open any of
// them with their own session. Nothing said so. The page looked exactly like the customer's own,
// down to the company name in the corner, and offered two controls that meant something completely
// different from what they said:
//
//   "My portal"  sent an Akore staff member into that CUSTOMER's portal.
//   "Log out"    read the session being held, which under a bypass is the STAFF one, and revoked it
//                on the server — signing them out of the entire platform, in every tab, from a page
//                they had opened to look at a form.
//
// Both were one rule in js/auth.js, wrong once and therefore wrong on all three pages. Tested here
// at that level for the same reason.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const authSrc = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');

/** A browser holding a staff session, with the server answering the bypass. */
function browser(search) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://t.local/intake.html' + (search || ''),
    runScripts: 'outside-only', virtualConsole: new VirtualConsole()
  });
  const w = dom.window;
  w.__deleted = [];
  w.fetch = async (u, init) => {
    const s = String(u);
    if (init && init.method === 'DELETE') w.__deleted.push(s);
    if (s.indexOf('as=') !== -1) {
      return { ok: true, status: 200, json: async () => ({
        username: 'demo-logistics', company: 'Demo Logistics', kind: 'customer', role: 'full' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  w.localStorage.setItem('akore_staff_session', 'staff-token');
  w.eval(authSrc);
  return w;
}

(async () => {
  console.log('Staff standing in for a customer:\n');
  {
    const w = browser();
    const who = await w.akoreStaffBypass('demo-logistics');
    check('the bypass resolves', !!who && who.company === 'Demo Logistics', JSON.stringify(who));
    check('and the page can tell it is not the customer looking',
      w.akoreIsStaffBypass() === true, String(w.akoreIsStaffBypass()));

    check('"home" is the customer\'s internal page, not the customer\'s own portal',
      w.homeHref() === '/index.html?company=Demo%20Logistics', w.homeHref());

    // The destructive one.
    const dest = await w.clientLogoutAll();
    check('leaving the view does NOT revoke anything on the server',
      w.__deleted.length === 0, JSON.stringify(w.__deleted));
    check('and the staff session is still in this browser',
      w.localStorage.getItem('akore_staff_session') === 'staff-token',
      String(w.localStorage.getItem('akore_staff_session')));
    check('it goes back to the customer, not to a login screen',
      dest === '/index.html?company=Demo%20Logistics', String(dest));
  }

  console.log('\nA real customer is unaffected by any of it:\n');
  {
    const w = browser();
    w.localStorage.removeItem('akore_staff_session');
    w.sessionStorage.setItem('akore_client_session', 'client-token');
    w.fetch = async (u, init) => {
      const s = String(u);
      if (init && init.method === 'DELETE') { w.__deleted.push(s); return { ok: true, json: async () => ({}) }; }
      return { ok: true, status: 200,
        json: async () => ({ username: 'demo-logistics', company: 'Demo Logistics', kind: 'customer', role: 'full' }) };
    };
    const who = await w.akoreAuth.restore();
    check('a customer signs in normally', !!who && who.kind === 'customer', JSON.stringify(who));
    check('and is not mistaken for staff', w.akoreIsStaffBypass() === false, String(w.akoreIsStaffBypass()));
    check('their home is their own portal',
      w.homeHref().indexOf('/client-portal.html') === 0, w.homeHref());

    await w.clientLogoutAll();
    check('and logging out still really logs them out', w.__deleted.length === 1,
      JSON.stringify(w.__deleted));
  }

  console.log('\nSaying so on the page:\n');
  {
    const w = browser();
    await w.akoreStaffBypass('demo-logistics');
    const bar = w.document.getElementById('akore-bypass-bar');
    check('a bar says whose page this is', !!bar, 'no bar was drawn');
    check('and names the customer', bar && bar.textContent.indexOf('Demo Logistics') !== -1,
      bar && bar.textContent);
    check('with a way back to them',
      !!bar && !!bar.querySelector('a[href*="/index.html?company="]'),
      bar && bar.innerHTML.slice(0, 120));

    // Opening a second page must not stack bars.
    await w.akoreStaffBypass('demo-logistics');
    check('and it is not drawn twice', w.document.querySelectorAll('#akore-bypass-bar').length === 1,
      String(w.document.querySelectorAll('#akore-bypass-bar').length));
  }

  console.log('\nPreviewing an unreleased draft says what it is:\n');
  {
    const w = browser('?username=demo-logistics&preview=draft');
    await w.akoreStaffBypass('demo-logistics');
    const bar = w.document.getElementById('akore-bypass-bar');
    check('the bar says it is a preview', !!bar && /revia|review/i.test(bar.textContent),
      bar && bar.textContent);
    check('and that nothing is saved from it',
      !!bar && /no se guarda|not saved|nothing is saved/i.test(bar.textContent),
      bar && bar.textContent);
  }

  console.log('\nAnd the form itself removes the ways to write:\n');
  {
    // Preview opens the customer's REAL intake, wired to their REAL answers. A staff member typing
    // into it to see how it looks and pressing Save would overwrite what the client filled in.
    const page = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');
    check('intake.html has a preview mode that hides saving and submitting',
      /function applyPreviewMode\(\)/.test(page) && /save-progress-btn/.test(page), 'not present');
    check('and it is applied after the session is adopted',
      /applyPreviewMode\(\);/.test(page.slice(page.indexOf('async function adoptSession'))), 'never called');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
