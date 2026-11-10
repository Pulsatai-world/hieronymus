// Every page stands behind the login page, and the list is taken from the directory — not typed.
//
// This is the second half of a bug, and the more important half. A signed-out visitor could open
// dashboard-monitoring.html and get the whole thing: the heading, the filters, the tabs, the
// customer's name sitting in the URL. No data came with it — every endpoint refuses without a
// session, and that was checked against production — but a page that renders for someone who is
// not signed in is one bad endpoint away from leaking, and to the person looking at it there is
// no difference.
//
// The login process had been gone over many times. It never caught this because the guards
// enumerated pages BY NAME — portal, index, intake-view, geo-report — and the dashboards and the
// client pages were in neither list. Every pass re-checked the same four files. So this one reads
// the directory instead: a page added tomorrow is covered the moment it exists, and the only way
// off the list is to be the login page.
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The sign-in page itself, which obviously cannot require a session to reach.
const EXEMPT = new Set(['login.html']);

const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && !EXEMPT.has(f));

test('there are pages to check, and the list came from the directory', () => {
  assert.ok(PAGES.length >= 8, `only found ${PAGES.length} pages — has the glob broken?`);
});

for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  // A page's own scripts count as the page: the gate may live in its module.
  const own = [...src.matchAll(/<script[^>]+src="(\/[^"]+)"/g)]
    .map(m => m[1].replace(/^\//, '').split('?')[0])
    .filter(rel => rel !== 'js/auth.js' && fs.existsSync(path.join(ROOT, rel)))
    .map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    .join('\n');
  const code = src + '\n' + own;

  test(`${page} draws nothing until the session is known`, () => {
    assert.match(src, /id="akore-gate-style"/,
      'the page paints before anyone has asked whether this visitor is signed in');
    assert.match(src, /visibility:\s*hidden/,
      'the gate style does not actually hide anything');
  });

  test(`${page} sends a signed-out visitor to the login page`, () => {
    assert.match(code, /akoreGate\s*\(|akoreGoToLogin\s*\(/,
      'no session check reaches the login page — a signed-out visitor stays here');
  });

  test(`${page} carries no sign-in form of its own`, () => {
    // One login page for everyone. Six pages each with their own form is where this started.
    assert.doesNotMatch(src, /id="gate-password-input"/,
      'this page asks for a password itself instead of using the one login page');
    assert.doesNotMatch(code, /akoreSignIn\s*\(/,
      'this page signs people in itself instead of using the one login page');
  });
}

test('the gate fails closed', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
  const gate = auth.slice(auth.indexOf('window.akoreGate ='));
  const body = gate.slice(0, gate.indexOf('\n  };'));
  assert.match(body, /catch[\s\S]{0,120}akoreGoToLogin/,
    'a gate that throws leaves the page open; it has to land on the login page instead');
  assert.match(body, /if \(!who\)[\s\S]{0,60}akoreGoToLogin/,
    'no session does not send the visitor to the login page');
});
