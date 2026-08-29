// The login as a person actually experiences it: the real browser code, in a real DOM, against the
// real endpoints.
//
// Every failure that reached production in this feature lived in the join between two halves that
// each passed their own tests — an endpoint with no route, a payload missing a field the page
// rendered from, a ticket that let a fresh sign-in skip its code, a button left disabled after a
// retry, a page that decided it was signed in from a value in its own storage. None of those could
// fail in a server test or a syntax check.
//
// So this drives js/auth.js and js/enroll-dialog.js unmodified, clicks what a person clicks, and
// asserts what they would see.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register('./support/blobs-hook.mjs', pathToFileURL(__filename));
const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = name => (STORES[name] = STORES[name] || {});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

// Never await something that might not settle: a hung await drains the event loop and node exits
// quietly with status 0, so the failure disappears instead of being reported.
const settle = (p, ms = 2000) => Promise.race([p, new Promise(r => setTimeout(() => r({ __hung: true }), ms))]);

// An authenticator app.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function codeAt(secret, step) {
  const c = Buffer.alloc(8);
  c.writeUInt32BE(Math.floor(step / 4294967296), 0);
  c.writeUInt32BE(step >>> 0, 4);
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(c).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}
const nowStep = () => Math.floor(Date.now() / 1000 / 30);

const PW = 'a-real-password';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

(async () => {
  const load = async f => (await import(pathToFileURL(path.resolve('netlify/functions/' + f)).href)).default;
  // Read from the code rather than hardcoded: bumping the field name is how every account gets reset,
  // and a suite that hardcodes it would fail for the wrong reason every time that happens.
  const AUTH = (await import(pathToFileURL(path.resolve('netlify/functions/lib/accounts.js')).href)).AUTH_FIELD;
  const HANDLERS = {
    '/api/login': await load('login.js'),
    '/api/enroll': await load('enroll.js'),
    '/api/confirm-password': await load('confirm-password.js'),
    '/api/intake-codes': await load('intake-codes.js'),
    '/api/results': await load('results.js')
  };

  const AUTH_JS = fs.readFileSync('js/auth.js', 'utf8');
  const ENROLL_JS = fs.readFileSync('js/enroll-dialog.js', 'utf8');

  // A browser. `seed` carries storage over from a previous page, which is what makes a "reload" a
  // fresh page in the SAME browser rather than a different one — the distinction the reported
  // "logged out but still in" bug lived in, and which an earlier version of this harness missed by
  // building a clean browser every time.
  function snapshot(w) {
    const grab = s => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
    return { local: grab(w.localStorage), session: grab(w.sessionStorage) };
  }
  function browser(url, seed) {
    const vc = new VirtualConsole();
    const navigations = [];
    vc.on('jsdomError', e => { if (/navigation/i.test(e.message)) navigations.push(e.message); });
    vc.on('error', () => {});
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: url || 'https://test.local/portal.html', runScripts: 'outside-only', virtualConsole: vc
    });
    const w = dom.window;
    const calls = [];
    w.fetch = async (u, init) => {
      const p = String(u).split('?')[0];
      calls.push({ path: p, method: (init && init.method) || 'GET' });
      const h = HANDLERS[p];
      if (!h) return new Response('Not Found', { status: 404 });   // an unrouted path, as Netlify answers
      return await h(new Request('https://test.local' + u, init || {}), {});
    };
    if (seed) {
      Object.entries(seed.local || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      Object.entries(seed.session || {}).forEach(([k, v]) => w.sessionStorage.setItem(k, v));
    }
    const run = src => require('vm').runInContext(src, dom.getInternalVMContext());
    run(AUTH_JS);
    run(ENROLL_JS);
    return { w, dom, calls, navigations, run };
  }

  // Setup now ends on a success screen carrying the recovery codes, which waits to be acknowledged
  // rather than vanishing. Anything that submits a correct code has to clear it before the sign-in
  // promise settles.
  async function acknowledgeSuccess(w) {
    for (let i = 0; i < 500 && !w.document.querySelector('.ae-rec'); i++) await new Promise(r => setTimeout(r, 5));
    const codes = Array.from(w.document.querySelectorAll('.ae-rec span')).map(e => e.textContent);
    const box = w.document.querySelector('.ae-save input');
    const go = w.document.querySelector('.ae-actions .ae-go');
    const gatedBeforeTicking = !!(go && go.disabled);
    if (box) { box.checked = true; if (box.onchange) box.onchange(); }
    if (go) go.click();
    for (let i = 0; i < 500 && w.document.querySelector('.ae-back'); i++) await new Promise(r => setTimeout(r, 5));
    return { codes, gatedBeforeTicking };
  }

  // Acts as the person at the setup dialog: reads the QR, types the code from it, clicks.
  async function completeSetup(w, { fromQr = true, delaySteps = 0 } = {}) {
    for (let i = 0; i < 400 && !w.document.querySelector('.ae-back'); i++) await new Promise(r => setTimeout(r, 5));
    if (!w.document.querySelector('.ae-back')) return { opened: false };
    for (let i = 0; i < 400 && !w.document.getElementById('ae-secret').textContent; i++) await new Promise(r => setTimeout(r, 5));

    const shownError = w.document.getElementById('ae-err').textContent;
    const key = w.document.getElementById('ae-secret').textContent.replace(/\s/g, '');
    const qr = !!w.document.querySelector('#ae-qr svg');
    if (!key) return { opened: true, key: '', qr, error: shownError };

    w.document.getElementById('ae-code').value = codeAt(key, nowStep() - delaySteps);
    w.document.querySelector('.ae-go').click();

    // Three ways this settles: the dialog closes, it swaps to the success screen, or an error
    // appears under the code field. Waiting only for it to close hangs on the first of those.
    const settled = () => !w.document.querySelector('.ae-back')
      || !!w.document.querySelector('.ae-rec')
      || !!(w.document.getElementById('ae-err') || {}).textContent;
    for (let i = 0; i < 500 && !settled(); i++) await new Promise(r => setTimeout(r, 5));

    // The success screen holds the recovery codes and waits to be acknowledged, so read them and
    // then do what a person does: tick the box and press Continue.
    if (w.document.querySelector('.ae-rec')) {
      const ack = await acknowledgeSuccess(w);
      const open2 = !!w.document.querySelector('.ae-back');
      return { opened: true, key, qr, error: shownError, stillOpen: open2,
               recoveryCodes: ack.codes, gatedBeforeTicking: ack.gatedBeforeTicking,
               errorAfter: open2 ? ((w.document.getElementById('ae-err') || {}).textContent || '') : '' };
    }
    const recoveryCodes = [];

    const stillOpen = !!w.document.querySelector('.ae-back');
    return {
      opened: true, key, qr, error: shownError, stillOpen, recoveryCodes,
      errorAfter: stillOpen ? ((w.document.getElementById('ae-err') || {}).textContent || '') : ''
    };
  }

  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-staff-users')['akore-rene'] = {
      username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW), createdAt: '2026-08-29T00:00:00Z'
    };
    store('hieronymus-intake-codes')['fiacsa'] = {
      company: 'FIACSA', submittedAt: '2026-02-01T00:00:00Z', diagnosisReleased: true,
      members: [{ username: 'fiacsa', role: 'full', passwordHash: scrypt(PW), defaultLanguage: 'es' }]
    };
  };

  // ── A staff member's first ever visit ──
  console.log("Staff, first visit — password, then set up an authenticator:");
  reset();
  let staffKey = null, afterFirstVisit = null;
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();

    check('not signed in to begin with', (await w.akoreAuth.restore()) === null, 'restored something');

    const signingIn = w.akoreSignIn('akore-rene', PW, '', 'es');
    const setup = await completeSetup(w);

    check('the setup dialog opens', setup.opened, 'never appeared');
    check('with a QR to scan', setup.qr, 'no QR drawn');
    check('and no error while setting up', !setup.error, '"' + setup.error + '"');
    check('the dialog closes on a correct code', !setup.stillOpen, 'still open: "' + setup.errorAfter + '"');
    check('the setup is confirmed on screen, not just silently over',
      setup.recoveryCodes.length === 10, 'shown ' + setup.recoveryCodes.length + ' recovery codes');
    check('and Continue waits until the codes are acknowledged',
      setup.gatedBeforeTicking === true, 'it could be clicked straight past');

    const attempt = await settle(signingIn);
    check('and they are signed in', attempt && attempt.ok === true, JSON.stringify(attempt));
    check('as themselves, with their role from the server',
      attempt.ok && attempt.who.username === 'akore-rene' && attempt.who.role === 'admin', JSON.stringify(attempt.who));
    check('a session is held', !!w.akoreAuth.session(), 'none');
    check('and no password was stored anywhere',
      !JSON.stringify(w.localStorage).includes(PW) && !JSON.stringify(w.sessionStorage).includes(PW), 'a password is in storage');
    staffKey = store('hieronymus-staff-users')['akore-rene'][AUTH].secret;
    check('the key in the app is the one the server kept', setup.key === staffKey, 'they differ');
    afterFirstVisit = snapshot(w);
  }

  // ── Coming back ──
  console.log("\nReloading the page in the same browser:");
  {
    // A fresh page in the SAME browser: its storage came along.
    const { w } = browser('https://test.local/portal.html', afterFirstVisit);
    w.akoreAuth.useStaffSession();
    const who = await settle(w.akoreAuth.restore());
    check('still signed in, with no code asked for', !!(who && who.username === 'akore-rene'), JSON.stringify(who));
  }

  console.log("\nSigning out, then signing in again:");
  {
    const { w } = browser('https://test.local/portal.html', afterFirstVisit);
    w.akoreAuth.useStaffSession();
    await w.akoreAuth.restore();
    await w.akoreAuth.logout(false);
    check('the session is gone from the browser', !w.akoreAuth.session(), 'still held');
    check('and dead on the server too',
      Object.keys(store('hieronymus-staff-sessions')).length === 0, 'a session survived sign-out');

    const bare = await settle(w.akoreSignIn('akore-rene', PW, '', 'es'));
    check('signing in again DEMANDS a code', !!(bare && bare.needsCode),
      'LET STRAIGHT IN: ' + JSON.stringify(bare));
    const withCode = await settle(w.akoreSignIn('akore-rene', PW, codeAt(staffKey, nowStep() + 1), 'es'));
    check('and the code signs them in', withCode && withCode.ok === true, JSON.stringify(withCode));
  }

  console.log("\nA brand-new browser (someone else's machine):");
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();
    check('nothing is remembered', (await w.akoreAuth.restore()) === null, 'restored a session');
    const bare = await settle(w.akoreSignIn('akore-rene', PW, '', 'es'));
    check('the password alone gets nowhere', !!(bare && bare.needsCode), JSON.stringify(bare));
  }

  // ── The failure that kept reaching the user ──
  console.log("\nTwo sign-ins fired at once (a button and an Enter key):");
  reset();
  {
    const { w, calls } = browser();
    w.akoreAuth.useStaffSession();
    // Both handlers fire before either resolves.
    const a = w.akoreSignIn('akore-rene', PW, '', 'es');
    const b = w.akoreSignIn('akore-rene', PW, '', 'es');
    const setup = await completeSetup(w);
    const [ra, rb] = [await settle(a), await settle(b)];

    check('only ONE setup dialog opened', w.document.querySelectorAll('.ae-back').length === 0 && setup.opened,
      'saw ' + w.document.querySelectorAll('.ae-back').length + ' dialogs');
    check('only one setup was started server-side',
      calls.filter(c => c.path === '/api/enroll' && c.method === 'POST').length <= 2,
      calls.filter(c => c.path === '/api/enroll').length + ' enroll calls');
    check('both sign-ins succeed', ra && ra.ok === true && rb && rb.ok === true,
      JSON.stringify([ra && ra.ok, rb && rb.ok]));
    check('and the code from the shown QR was the one accepted',
      setup.key === store('hieronymus-staff-users')['akore-rene'][AUTH].secret, 'a different secret was kept');
  }

  console.log("\nA person who takes 90 seconds to type the code:");
  reset();
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();
    const signingIn = w.akoreSignIn('akore-rene', PW, '', 'es');
    const setup = await completeSetup(w, { delaySteps: 3 });
    const attempt = await settle(signingIn);
    check('setup still completes', !setup.stillOpen && attempt && attempt.ok === true,
      'error: "' + setup.errorAfter + '"');
  }

  console.log("\nWhen the setup endpoint cannot be reached:");
  reset();
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();
    const real = HANDLERS['/api/enroll'];
    HANDLERS['/api/enroll'] = null;                 // exactly what an unrouted path does

    const signingIn = w.akoreSignIn('akore-rene', PW, '', 'es');
    for (let i = 0; i < 400 && !w.document.getElementById('ae-err')?.textContent; i++) await new Promise(r => setTimeout(r, 5));
    const msg = w.document.getElementById('ae-err').textContent;
    const btn = w.document.querySelector('.ae-go');
    check('the message names the reason rather than "something went wrong"', /404|HTTP/.test(msg), '"' + msg + '"');
    check('the button offers a retry instead of sitting dead', !btn.disabled && /Intentar|Try again/i.test(btn.textContent),
      btn.textContent + ' disabled=' + btn.disabled);

    HANDLERS['/api/enroll'] = real;
    btn.click();
    for (let i = 0; i < 500 && !w.document.getElementById('ae-secret').textContent; i++) await new Promise(r => setTimeout(r, 5));
    const key = w.document.getElementById('ae-secret').textContent.replace(/\s/g, '');
    check('retrying in place gets a secret', !!key, 'still empty');
    w.document.getElementById('ae-code').value = codeAt(key, nowStep());
    w.document.querySelector('.ae-go').click();
    const ack = await acknowledgeSuccess(w);
    check('recovery codes are handed over even on the retry path', ack.codes.length === 10,
      'shown ' + ack.codes.length);
    const attempt = await settle(signingIn);
    check('and setup then completes', attempt && attempt.ok === true, JSON.stringify(attempt));
  }

  console.log("\nCancelling the dialog must not hang the page:");
  reset();
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();
    const signingIn = w.akoreSignIn('akore-rene', PW, '', 'es');
    for (let i = 0; i < 400 && !w.document.querySelector('.ae-x'); i++) await new Promise(r => setTimeout(r, 5));
    w.document.querySelector('.ae-x').click();
    const attempt = await settle(signingIn, 600);
    check('the sign-in settles as cancelled', attempt && !attempt.__hung && attempt.cancelled === true,
      attempt && attempt.__hung ? 'the page would wait forever' : JSON.stringify(attempt));
  }

  // ── Customers ──
  console.log("\nA customer, the same journey:");
  reset();
  {
    const { w } = browser('https://test.local/client-portal.html');
    const signingIn = w.akoreSignIn('fiacsa', PW, '', 'es');
    const setup = await completeSetup(w);
    const attempt = await settle(signingIn);

    check('they set up and are signed in', attempt && attempt.ok === true, JSON.stringify(attempt));
    check('and their page has what it renders from',
      attempt.ok && attempt.who.company === 'FIACSA' && attempt.who.diagnosisReleased === true
      && attempt.who.defaultLanguage === 'es', JSON.stringify(attempt.who));
    check('their session is in sessionStorage, so closing the browser ends it',
      !!w.sessionStorage.getItem('akore_client_session') && !w.localStorage.getItem('akore_client_session'),
      'stored in the wrong place');

    // Their own data, with only the session.
    const res = await w.fetch(w.akoreAuth.apiUrl('/api/intake-codes', { company: 'FIACSA' }));
    check('they can read their own record with just the session', res.status === 200, 'status ' + res.status);
    const other = await w.fetch(w.akoreAuth.apiUrl('/api/intake-codes', { company: 'SomeoneElse' }));
    check("but not another customer's", other.status === 403 || other.status === 404, 'status ' + other.status);

    await w.akoreAuth.logout(false);
    const again = await settle(w.akoreSignIn('fiacsa', PW, '', 'es'));
    check('signing in again demands a code', !!(again && again.needsCode), 'LET IN: ' + JSON.stringify(again));
  }

  // ── Staff opening a customer's page ──
  console.log("\nStaff opening a customer's own page:");
  reset();
  {
    const staffBrowser = browser();
    staffBrowser.w.akoreAuth.useStaffSession();
    const signingIn = staffBrowser.w.akoreSignIn('akore-rene', PW, '', 'es');
    await completeSetup(staffBrowser.w);
    await settle(signingIn);
    const staffSession = staffBrowser.w.localStorage.getItem('akore_staff_session');
    check('the staff session is in localStorage', !!staffSession, 'none');

    // A client page in that same browser.
    const clientPage = browser('https://test.local/intake.html');
    clientPage.w.localStorage.setItem('akore_staff_session', staffSession);
    const asCustomer = await settle(clientPage.w.akoreStaffBypass('fiacsa'));
    check('the customer payload comes back', !!(asCustomer && asCustomer.company === 'FIACSA'), JSON.stringify(asCustomer));
    check('marked as a staff view', !!(asCustomer && asCustomer.staffBypass), 'not marked');
    check('and no customer session was issued',
      !clientPage.w.sessionStorage.getItem('akore_client_session'), 'a customer session was minted');

    // Without a staff session it does nothing.
    const stranger = browser('https://test.local/intake.html');
    check('a stranger cannot use it', (await settle(stranger.w.akoreStaffBypass('fiacsa'))) === null, 'it worked');
  }

  // ── Confirming a password mid-session ──
  console.log("\nConfirming a password for a destructive action:");
  reset();
  {
    const { w } = browser();
    w.akoreAuth.useStaffSession();
    const signingIn = w.akoreSignIn('akore-rene', PW, '', 'es');
    await completeSetup(w);
    await settle(signingIn);

    check('the right password confirms', (await settle(w.akoreAuth.confirmPassword(PW))) === true, 'refused');
    check('a wrong one does not', (await settle(w.akoreAuth.confirmPassword('nope'))) === false, 'accepted');

    // And the dialog itself.
    const asking = w.requirePassword({ title: 'Test', message: 'Confirm' });
    for (let i = 0; i < 400 && !w.document.querySelector('.apw-in'); i++) await new Promise(r => setTimeout(r, 5));
    check('the dialog appears', !!w.document.querySelector('.apw-in'), 'no dialog');
    w.document.querySelector('.apw-in').value = PW;
    w.document.querySelector('.apw-go').click();
    check('and confirms with the right password', (await settle(asking)) === true, 'refused');
    check('no code was involved', !w.document.querySelector('.ae-back'), 'a setup dialog appeared');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
