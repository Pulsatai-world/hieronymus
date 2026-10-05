// The internal app and the customer app are two applications, not two skins.
//
// They drifted together once and it was not subtle: staff reviewed a prompt set on the
// CUSTOMER's review page, entered through the staff bypass, so an Akore reviewer sat looking at
// a client's sidebar — Inicio, Tableros, Formulario, Ajustes — inside what is supposed to be the
// staff console. Releasing a set lived there too, which is why it looked like a client page with
// an extra button rather than an internal screen.
//
// Nothing here checks appearance. It checks the three ways the two sides actually touch:
// which chrome a page loads, which pages link to which, and where a staff-only action lives.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The staff console. Every page here is reached with a staff session and shows staff navigation.
const INTERNAL = ['portal.html', 'index.html', 'intake-view.html', 'geo-report.html'];
// The customer's own app. A customer signs in and sees only their own things.
const CLIENT = ['client-portal.html', 'prompt-review.html', 'intake.html'];

// The dashboards are deliberately not in either list: one page serves both audiences and picks
// its chrome from who is looking (js/portal-rail.js renders for a staff session and nothing at
// all otherwise). If that ever becomes two pages, add them here.

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

console.log('The two apps do not share chrome:\n');
for (const page of INTERNAL) {
  check(page + ' does not load the customer sidebar',
    !/js\/client-rail\.js/.test(read(page)), 'it renders customer navigation to staff');
}
for (const page of CLIENT) {
  check(page + ' does not load the staff console sidebar',
    !/js\/portal-rail\.js/.test(read(page)), 'it renders staff navigation to a customer');
}

console.log('\nAnd they do not link into each other:\n');
for (const page of INTERNAL) {
  const src = read(page);
  // ONE named exception, and it is named here rather than tolerated by a loose pattern:
  // "Ver como cliente" in the intake template editor opens the customer's intake form in its own
  // tab so a reviewer can see the form as the customer will meet it. It is a staff-bypass render
  // of a client page from the internal app — the same shape as the problem this file exists to
  // stop — and it survives only because it is deliberate and labelled. Delete the line in
  // index.html and this exception with it if that trade stops being worth making.
  const ALLOWED = [/window\.open\('\/intake\.html\?username='/];
  let body = src.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\/\/|\s\*).*$/gm, '');
  ALLOWED.forEach(re => { body = body.replace(re, ''); });
  const links = CLIENT.filter(c => new RegExp('[\'"/]' + c.replace('.', '\\.')).test(body));
  check(page + ' does not send staff into a customer page', links.length === 0,
    'links to ' + links.join(', '));
}

console.log('\nReleasing a prompt set is an internal action, and only an internal one:\n');
{
  const review = read('prompt-review.html');
  check('the customer review page has no staff entry',
    !/akoreStaffBypass/.test(review), 'staff can still open it as the customer');
  check('the customer review page cannot release a set',
    !/internalApprove/.test(review), 'the internal release action is still on a customer page');
  check('the customer review page has no internal reviewer view',
    !/isStaffReviewer/.test(review), 'it still branches on who is looking');
  check('the staff console is where a set is released',
    /internalApprove/.test(read('index.html')), 'nothing internal can release prompts');
}

// The gate the whole split rests on: a customer must never be handed the prompts before an Akore
// reviewer has released them, and that is enforced on the server, not by which page they open.
console.log('\nAnd the server still withholds an unreleased set:\n');
{
  const api = read('netlify/functions/prompts.js');
  check('an unreleased set is stripped of its text for a customer',
    /const \{ promptsText, \.\.\.rest \} = withoutInternals\(data\)/.test(api),
    'the text is sent and hidden in the browser');
  check('only a staff caller can release',
    /if \(asMember\) \{[\s\S]{0,200}Only a signed-in Akore staff user can release/.test(api),
    'a customer can release their own prompts');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'the two apps are separate'));
process.exit(failures ? 1 : 0);
