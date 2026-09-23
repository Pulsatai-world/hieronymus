// Every staff page has to do two things before it decides whether someone is signed in, and
// geo-report.html did neither — which is how a signed-in reader opening a report link was told to
// log in.
//
//   window.akoreAuth.useStaffSession()   declares the audience. Without it auth.js reads the
//                                        CLIENT session key, which lives in sessionStorage and is
//                                        empty in the new tab a report link opens in.
//   await window.akoreAuth.restore()     asks the server. who() returns only what is already held
//                                        in memory, and on a freshly loaded page that is null.
//
// Gating on who() without restore() is the failure that is easy to reintroduce, because it reads
// perfectly well and works whenever the page happens to have been open already.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// A page may ask the server directly with restore(), or through akoreRequireStaff(), which wraps
// restore() and additionally turns away a signed-in customer. Either satisfies "asks the server" —
// but only because auth.js really does restore inside that helper, which is asserted below rather
// than assumed. Without that second assertion this would be a textual check that a name appears.
const ASKS_SERVER = /akoreAuth\.restore\s*\(|akoreRequireStaff\s*\(/;

// Pages that gate on a staff session. A page added here without the two calls fails this test.
const STAFF_PAGES = ['portal.html', 'index.html', 'intake-view.html', 'geo-report.html'];

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

console.log('Every staff page declares its audience and restores the session:\n');

for (const page of STAFF_PAGES) {
  const file = path.join(ROOT, page);
  if (!fs.existsSync(file)) { check(page + ' exists', false, 'file not found'); continue; }
  const html = fs.readFileSync(file, 'utf8');

  check(page + ' — declares the staff audience',
    /window\.akoreAuth\.useStaffSession\s*\(/.test(html),
    'add <script>window.akoreAuth.useStaffSession();</script> after /js/auth.js');

  check(page + ' — restores the session from the server',
    ASKS_SERVER.test(html),
    'call await window.akoreAuth.restore(), or window.akoreRequireStaff(), before deciding who the visitor is');

  // The specific mistake: gating on the in-memory payload with no restore anywhere on the page.
  const gatesOnWho = /akoreAuth\.who\s*\(\s*\)[^\n]*kind/.test(html);
  const restores = ASKS_SERVER.test(html);
  check(page + ' — does not gate on who() without restoring first',
    !gatesOnWho || restores,
    'who() returns memory, not a session; restore() is what asks the server');
}

// The helper the pages now lean on has to actually do both jobs, or every check above is satisfied
// by a name that means nothing.
const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
const helper = auth.slice(auth.indexOf('window.akoreRequireStaff'));
const body = helper.slice(0, helper.indexOf('\n  };'));
check('akoreRequireStaff asks the server itself',
  /api\.restore\s*\(/.test(body), 'it does not call restore(); the pages relying on it now ask nobody');
check('akoreRequireStaff admits only staff',
  /kind\s*===\s*'staff'/.test(body), 'it does not distinguish a customer from a staff member');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all staff pages check the session properly'));
process.exit(failures ? 1 : 0);
