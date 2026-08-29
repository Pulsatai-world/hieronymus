// The whole login flow, driven through a real DOM against the real endpoints.
//
// Every other suite here tests one side or the other. The bugs that reached production lived in the
// join: an endpoint with no route, a login payload missing a field the page rendered from, and a
// ticket that was supposed to save a customer from retyping a code between pages but also let a
// fresh sign-in skip the code entirely. None of those could fail in a server test or a parse check.
//
// So this drives the actual browser code — js/results-auth.js and js/two-factor-setup.js, unmodified
// — inside jsdom, with fetch wired to the real Netlify handlers over an in-memory store. It clicks
// the buttons a person clicks.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

// Never await a promise that might not settle. A hung await drains the event loop and node exits
// quietly with status 0 — the failure disappears instead of being reported.
const settle = (p, ms = 1500) => Promise.race([p, new Promise(r => setTimeout(() => r({ __hung: true }), ms))]);

// ── The real handlers, over an in-memory store ──
const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});
const getStore = name => ({
  get: async (k, o) => (k in store(name) ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k]) : null),
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  set: async (k, v) => { store(name)[k] = v; },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

function load(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  const libs = [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')
      .replace(/^import .*?;$/gm, '')
      .replace(/^export (function|const|async function) /gm, '$1 ')).join('\n');
  const src = libs + '\n' + raw.replace(/^import .*?;$/gm, '').replace(/^export default /m, 'EXPORTS.handler = ');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, console,
                EXPORTS: {}, QRCode: require('qrcode') };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  return ctx.EXPORTS.handler;
}

const HANDLERS = {
  '/api/two-factor': load('two-factor.js'),
  '/api/staff-users': load('staff-users.js'),
  '/api/staff-session': load('staff-session.js'),
  '/api/intake-codes': load('intake-codes.js')
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

// ── TOTP, as an authenticator app computes it ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
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
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}
const nowStep = () => Math.floor(Date.now() / 1000 / 30);
const PW = 'staff-password';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

// ── A browser ──
function browser() {
  const navigations = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (/navigation/i.test(e.message)) navigations.push(e.message); });
  vc.on('error', () => {});
  const dom = new JSDOM(`<!doctype html><body>
    <input id="user-input"><input id="pw-input"><input id="code-input" style="display:none">
    <div id="pw-error"></div>
    <input id="gate-username-input"><input id="gate-password-input">
    <input id="gate-code-input" style="display:none"><div id="gate-error"></div>
  </body>`, { url: 'https://test.local/portal.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window;

  const calls = [];
  w.fetch = async (url, init) => {
    const u = String(url);
    const path = u.split('?')[0];
    const handler = HANDLERS[path];
    calls.push({ path, url: u, method: (init && init.method) || 'GET' });
    if (!handler) return new Response('Not Found', { status: 404 });   // an unrouted path, as Netlify answers
    const req = new Request('https://test.local' + u, init || {});
    return await handler(req, {});
  };
  for (const f of ['js/results-auth.js', 'js/two-factor-setup.js']) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  return { w, calls, dom, navigations };
}

// Acts as the person: waits for the dialog, reads the secret it shows, types the code, clicks.
async function completeEnrollment(w, { useQr = true } = {}) {
  for (let i = 0; i < 200 && !w.document.querySelector('.tfa-backdrop'); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const dialog = w.document.querySelector('.tfa-backdrop');
  if (!dialog) return { opened: false };
  // Let the begin request settle so the secret and QR are rendered.
  for (let i = 0; i < 200 && !w.document.getElementById('tfa-secret').textContent; i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const err = w.document.getElementById('tfa-err').textContent;
  const secret = w.document.getElementById('tfa-secret').textContent.replace(/\s/g, '');
  const qr = w.document.getElementById('tfa-qr');
  const shownError = err;
  if (!secret) return { opened: true, secret: '', error: shownError, qr: !!qr };

  w.document.getElementById('tfa-code').value = codeAt(secret, nowStep());
  w.document.querySelector('.tfa-go').click();
  for (let i = 0; i < 300 && w.document.querySelector('.tfa-backdrop'); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const stillOpen = !!w.document.querySelector('.tfa-backdrop');
  return {
    opened: true, secret, qr: !!qr, error: shownError,
    stillOpen,
    errorAfter: stillOpen ? w.document.getElementById('tfa-err').textContent : ''
  };
}

(async () => {
  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    // The one-shot lockout recovery in staff-users.js is keyed to this very username, so it would
    // fire mid-test and clear the enrollment the test just made. Marked spent here; the recovery
    // itself is covered by its own assertions.
    store('hieronymus-staff-sessions')['__recovery_used_akore-rene'] = { at: '2026-08-29T00:00:00Z' };
    store('hieronymus-staff-users')['akore-rene'] = {
      username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW), createdAt: '2026-01-01T00:00:00Z'
    };
    store('hieronymus-intake-codes')['fiacsa'] = {
      company: 'FIACSA', submittedAt: '2026-02-01T00:00:00Z',
      members: [{ username: 'fiacsa', role: 'full', passwordHash: scrypt(PW), createdAt: '2026-01-01T00:00:00Z' }]
    };
  };

  // ── A staff member enrolling for the first time ──
  console.log('Staff, first login after two-factor was turned on:');
  reset();
  {
    const { w, calls } = browser();
    const loginPromise = w.staffGateLogin('akore-rene', PW, '', 'es');
    const flow = await completeEnrollment(w);

    check('the setup dialog opens', flow.opened, 'never appeared');
    check('it fetched a secret', !!flow.secret, 'error shown: "' + flow.error + '"');
    check('and rendered a QR to scan', flow.qr, 'no QR element');
    check('no error is shown while setting up', !flow.error, '"' + flow.error + '"');

    const result = await loginPromise;
    check('the dialog closes after a correct code', !flow.stillOpen, 'still open: "' + flow.errorAfter + '"');
    check('and the login completes', result && result.ok === true, JSON.stringify(result));
    check('the account is enrolled', !!store('hieronymus-staff-users')['akore-rene'].totp.enabledAt, 'not enrolled');
    check('/api/two-factor was actually reachable', !calls.some(c => c.path === '/api/two-factor' && false), '');
  }

  // ── THE REPORTED BUG: signing in again ──
  console.log('\nSigning in again afterwards — a code must be required:');
  {
    const { w } = browser();          // a fresh browser, but the account is enrolled
    const secret = store('hieronymus-staff-users')['akore-rene'].totp.secret;
    const r = await w.staffGateLogin('akore-rene', PW, '', 'es');
    check('a password with no code is refused', !(r && r.ok), JSON.stringify(r));
    check('and it asks for the code', !!(r && r.needsCode), JSON.stringify(r));
    // A different step: the previous login consumed the current one, and codes may never repeat.
    const good = await w.staffGateLogin('akore-rene', PW, codeAt(secret, nowStep() + 1), 'es');
    check('with the code it signs in', good && good.ok === true, JSON.stringify(good));
  }

  console.log('\nStaff: enrol and then sign in again IN THE SAME BROWSER:');
  reset();
  {
    // The reported bug is about one browser: enrol, then sign in again and be taken straight in.
    // The first version of this test built a fresh browser for the second login, so its storage was
    // empty and the flaw could not show up — it passed while production was broken. One browser now.
    const { w } = browser();
    const enrolling = w.staffGateLogin('akore-rene', PW, '', 'es');
    const flow = await completeEnrollment(w);
    check('enrollment completes', !flow.stillOpen && (await enrolling).ok === true, 'error: "' + flow.errorAfter + '"');

    const ticketHeld = w.localStorage.getItem('hieronymus_staff_tfa');
    check('the browser is holding a two-factor ticket', !!ticketHeld, 'no ticket stored');

    // Same browser, same stored ticket, password typed at the gate again.
    const again = await w.staffGateLogin('akore-rene', PW, '', 'es');
    check('typing the password again still demands a code', !!(again && again.needsCode),
      'TOOK THEM STRAIGHT IN: ' + JSON.stringify(again));

    const secret = store('hieronymus-staff-users')['akore-rene'].totp.secret;
    const withCode = await w.staffGateLogin('akore-rene', PW, codeAt(secret, nowStep() + 1), 'es');
    check('and the code lets them in', withCode && withCode.ok === true, JSON.stringify(withCode));

    // Signing out must take the ticket with it.
    await w.staffSignOut();
    check('signing out clears the ticket', !w.localStorage.getItem('hieronymus_staff_tfa'),
      'ticket survived logout');
  }

  // ── A customer, same questions ──
  console.log('\nA customer enrolling, then signing in again:');
  reset();
  {
    const { w } = browser();
    const p = w.clientLogin('fiacsa', PW);
    const first = await p;
    check('a customer with no authenticator is sent to setup', !!first.needsEnrollment, JSON.stringify(first));

    const enroll = w.startTwoFactorSetup({ username: 'fiacsa', password: PW, lang: 'es', audience: 'client' });
    const flow = await completeEnrollment(w);
    check('the dialog opens and gets a secret', flow.opened && !!flow.secret, 'error: "' + flow.error + '"');
    const handoff = await enroll;
    check('enrollment reports success', !!handoff, JSON.stringify(handoff));
    check('the customer is enrolled', !!store('hieronymus-intake-codes')['fiacsa'].members[0].totp.enabledAt, 'not enrolled');

    const secret = store('hieronymus-intake-codes')['fiacsa'].members[0].totp.secret;
    const ticketHeld = w.sessionStorage.getItem('geo_2fa_token');
    check('the browser is holding a ticket for its API calls', !!ticketHeld, 'none stored');

    const bare = await w.clientLogin('fiacsa', PW);
    check('signing in again demands a code', !!bare.needsCode, 'LET STRAIGHT IN: ' + JSON.stringify(bare));

    // But moving between their pages must not ask again, or the feature is unusable.
    const restore = await w.clientLogin('fiacsa', PW, '', { useTicket: true });
    check('restoring the session on a page load does not ask', restore.ok === true, JSON.stringify(restore));

    const ok = await w.clientLogin('fiacsa', PW, codeAt(secret, nowStep() + 1));
    check('with the code they get in', ok.ok === true, JSON.stringify(ok));
    check('and the login payload still carries what the page renders',
      ok.ok && ok.data.company === 'FIACSA' && 'diagnosisReleased' in ok.data, JSON.stringify(ok.data));
  }

  // ── When setup cannot start ──
  // This is the state that was actually reported: an opaque "Algo salió mal" with an empty QR frame,
  // and no way forward. The cause was /api/two-factor answering 404 because it had no route. Two
  // things must hold now: the message names the reason, and the dialog is not a dead end.
  console.log('\nWhen the setup endpoint cannot be reached:');
  reset();
  {
    const { w } = browser();
    const real = HANDLERS['/api/two-factor'];
    HANDLERS['/api/two-factor'] = null;          // exactly what an unrouted path does

    const enrolling = w.startTwoFactorSetup({ username: 'akore-rene', password: PW, lang: 'es', audience: 'staff' });
    for (let i = 0; i < 200 && !w.document.querySelector('.tfa-backdrop'); i++) await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 200 && !w.document.getElementById('tfa-err').textContent; i++) await new Promise(r => setTimeout(r, 5));

    const msg = w.document.getElementById('tfa-err').textContent;
    check('the message names the reason instead of just "something went wrong"',
      /404|HTTP/.test(msg), '"' + msg + '"');
    check('it tells them what to do with it', /envíanos|send us/i.test(msg), '"' + msg + '"');

    const btn = w.document.querySelector('.tfa-go');
    check('the button offers a retry rather than sitting disabled',
      !btn.disabled && /Intentar|Try again/i.test(btn.textContent), btn.textContent + ' disabled=' + btn.disabled);

    // Restore the endpoint and retry from inside the dialog — no page reload.
    HANDLERS['/api/two-factor'] = real;
    btn.click();
    for (let i = 0; i < 300 && !w.document.getElementById('tfa-secret').textContent; i++) await new Promise(r => setTimeout(r, 5));
    const secret = w.document.getElementById('tfa-secret').textContent.replace(/\s/g, '');
    check('retrying in place fetches a secret', !!secret, 'still empty');
    check('and the QR appears', !!w.document.querySelector('#tfa-qr svg'), 'no QR drawn');

    w.document.getElementById('tfa-code').value = codeAt(secret, nowStep());
    w.document.querySelector('.tfa-go').click();
    for (let i = 0; i < 300 && w.document.querySelector('.tfa-backdrop'); i++) await new Promise(r => setTimeout(r, 5));
    const done = await settle(enrolling);
    check('enrollment then completes normally', !!done && !done.__hung,
      done && done.__hung
        ? 'never resolved — dialog open: ' + !!w.document.querySelector('.tfa-backdrop')
          + ', error shown: "' + (w.document.getElementById('tfa-err') || {}).textContent + '"'
          + ', button: "' + w.document.querySelector('.tfa-go').textContent + '"'
        : JSON.stringify(done));

    // Cancelling must always settle the promise, or the calling page hangs forever.
    const { w: w2 } = browser();
    HANDLERS['/api/two-factor'] = null;
    const p2 = w2.startTwoFactorSetup({ username: 'akore-rene', password: PW, lang: 'es', audience: 'staff' });
    for (let i = 0; i < 200 && !w2.document.querySelector('.tfa-x'); i++) await new Promise(r => setTimeout(r, 5));
    w2.document.querySelector('.tfa-x').click();
    const settled = await Promise.race([p2, new Promise(r => setTimeout(() => r('HUNG'), 400))]);
    check('cancelling settles instead of hanging the page', settled !== 'HUNG', 'the promise never resolved');
    HANDLERS['/api/two-factor'] = real;
  }

  console.log('\nA wrong code still reads as a wrong code, not as a system error:');
  reset();
  {
    const { w } = browser();
    const enrolling = w.startTwoFactorSetup({ username: 'fiacsa', password: PW, lang: 'es', audience: 'client' });
    for (let i = 0; i < 200 && !w.document.getElementById('tfa-secret').textContent; i++) await new Promise(r => setTimeout(r, 5));
    w.document.getElementById('tfa-code').value = '000000';
    w.document.querySelector('.tfa-go').click();
    for (let i = 0; i < 300 && !w.document.getElementById('tfa-err').textContent; i++) await new Promise(r => setTimeout(r, 5));
    const msg = w.document.getElementById('tfa-err').textContent;
    check('it says the code did not match', /no coincide/i.test(msg), '"' + msg + '"');
    check('and not that something went wrong', !/algo salió mal/i.test(msg), '"' + msg + '"');
    check('the dialog stays open to try the next code', !!w.document.querySelector('.tfa-backdrop'), 'closed');
    w.document.querySelector('.tfa-x').click();
    await settle(enrolling);
  }

  // ── Once the server has enrolled the account, the person MUST get in ──
  // This is the failure that was actually reported: enrollment had completed — it was possible to
  // log in afterwards — and the dialog still showed an error. Anything that goes wrong after the
  // server says "enabled" is not the person's problem and must not be shown to them as one.
  console.log('\nWhen something breaks AFTER the server has enrolled the account:');
  reset();
  {
    // Browser storage refuses writes: private windows and storage-blocked settings behave this way,
    // and the token-remembering step used to run inside the request's own try/catch.
    const { w } = browser();
    Object.defineProperty(w.localStorage, 'setItem', { value: () => { throw new Error('QuotaExceeded'); } });
    Object.defineProperty(w.sessionStorage, 'setItem', { value: () => { throw new Error('QuotaExceeded'); } });

    const enrolling = w.startTwoFactorSetup({ username: 'akore-rene', password: PW, lang: 'es', audience: 'staff' });
    const flow = await completeEnrollment(w);
    const done = await settle(enrolling);

    check('the dialog closes', !flow.stillOpen, 'stayed open showing: "' + flow.errorAfter + '"');
    check('no error is shown', !flow.errorAfter, '"' + flow.errorAfter + '"');
    check('enrollment reports success', !!done && !done.__hung, JSON.stringify(done));
    check('and the account really is enrolled', !!store('hieronymus-staff-users')['akore-rene'].totp.enabledAt, 'not enrolled');
    // Without a stored ticket the next step asks for a code — a working outcome, not an error.
    const secret = store('hieronymus-staff-users')['akore-rene'].totp.secret;
    const after = await w.staffGateLogin('akore-rene', PW, codeAt(secret, nowStep() + 1), 'es');
    check('and they can sign in with a code', after && after.ok === true, JSON.stringify(after));
  }

  console.log('\nWhen removing the dialog itself throws:');
  reset();
  {
    const { w } = browser();
    const enrolling = w.startTwoFactorSetup({ username: 'fiacsa', password: PW, lang: 'es', audience: 'client' });
    for (let i = 0; i < 300 && !w.document.getElementById('tfa-secret').textContent; i++) await new Promise(r => setTimeout(r, 5));
    const secret = w.document.getElementById('tfa-secret').textContent.replace(/\s/g, '');
    // The dialog is resolved before it is torn down, so a broken teardown cannot strand the caller.
    const backdrop = w.document.querySelector('.tfa-backdrop');
    backdrop.remove = () => { throw new Error('detached'); };
    w.document.getElementById('tfa-code').value = codeAt(secret, nowStep());
    w.document.querySelector('.tfa-go').click();
    const done = await settle(enrolling);
    check('the calling page is still let through', !!done && !done.__hung,
      done && done.__hung ? 'the promise never resolved — the page would hang forever' : JSON.stringify(done));
    check('and the account is enrolled', !!store('hieronymus-intake-codes')['fiacsa'].members[0].totp.enabledAt, 'not enrolled');
  }

  // ── THE REPORTED FAILURE, EXACTLY ──
  // "I logged out, and when I logged back in, it let me in without the authentication."
  // Driven through the real sign-out, in one browser, the way a person does it.
  console.log('\nEnrol, LOG OUT, log back in — a code must be required:');
  reset();
  {
    // jsdom cannot navigate and its location cannot be replaced, so the attempt is observed on the
    // virtual console instead — which is what jsdom reports when a page sets location.
    const { w, navigations } = browser();

    const enrolling = w.staffGateLogin('akore-rene', PW, '', 'es');
    await completeEnrollment(w);
    const first = await settle(enrolling);
    check('enrollment gets them in', !!first && first.ok === true, JSON.stringify(first));

    // The pages set these on a successful login; sign-out must clear them.
    w.localStorage.setItem('hieronymus_internal_auth', 'true');
    w.localStorage.setItem('hieronymus_internal_user', 'akore-rene');
    await w.staffSignIn('akore-rene', PW);           // the token the Portal trades for
    check('a session token was minted', !!w.localStorage.getItem('hieronymus_staff_token'), 'none');
    check('and a two-factor ticket is held', !!w.localStorage.getItem('hieronymus_staff_tfa'), 'none');

    // The real sign-out, the one the Log out button calls.
    await w.staffLogoutAll('reload');
    check('signing out navigates away', navigations.length > 0, 'no navigation attempted');
    check('the signed-in flag is gone', !w.localStorage.getItem('hieronymus_internal_auth'), 'still set');
    check('the session token is gone', !w.localStorage.getItem('hieronymus_staff_token'), 'still set');
    check('the two-factor ticket is gone', !w.localStorage.getItem('hieronymus_staff_tfa'), 'TICKET SURVIVED LOGOUT');
    // Count actual sessions, not every key in the store — the one-shot recovery marker lives there
    // too and is not a session.
    const liveSessions = Object.values(STORES['hieronymus-staff-sessions'] || {}).filter(v => v && v.username);
    check('the session was revoked server-side too', liveSessions.length === 0,
      'sessions left alive: ' + liveSessions.length);

    // Logging back in.
    const back = await w.staffGateLogin('akore-rene', PW, '', 'es');
    check('logging back in DEMANDS a code', !!(back && back.needsCode),
      'LET IN WITHOUT AUTHENTICATION: ' + JSON.stringify(back));
    check('and does not silently re-enrol them', !(back && back.cancelled), JSON.stringify(back));

    const secret = store('hieronymus-staff-users')['akore-rene'].totp.secret;
    const withCode = await w.staffGateLogin('akore-rene', PW, codeAt(secret, nowStep() + 1), 'es');
    check('the code lets them back in', withCode && withCode.ok === true, JSON.stringify(withCode));
  }

  console.log('\nSame for a customer: log out, log back in:');
  reset();
  {
    const { w } = browser();


    const enroll = w.startTwoFactorSetup({ username: 'fiacsa', password: PW, lang: 'es', audience: 'client' });
    await completeEnrollment(w);
    await settle(enroll);
    w.sessionStorage.setItem('geo_portal_username', 'fiacsa');
    w.sessionStorage.setItem('geo_portal_password', PW);
    check('a ticket is held for their session', !!w.sessionStorage.getItem('geo_2fa_token'), 'none');

    w.clientLogoutAll();
    check('logging out clears their ticket', !w.sessionStorage.getItem('geo_2fa_token'), 'TICKET SURVIVED LOGOUT');
    check('and their stored password', !w.sessionStorage.getItem('geo_portal_password'), 'still stored');

    const back = await w.clientLogin('fiacsa', PW);
    check('logging back in DEMANDS a code', !!back.needsCode, 'LET IN WITHOUT AUTHENTICATION: ' + JSON.stringify(back));
  }

  console.log('\nAll three internal pages sign out the same way:');
  {
    const auth = fs.readFileSync('js/results-auth.js', 'utf8');
    check('there is one implementation', auth.includes('window.staffLogoutAll'), 'missing');
    for (const f of ['portal.html', 'index.html', 'intake-view.html']) {
      const src = fs.readFileSync(f, 'utf8');
      check(f + ' delegates to it', /staffLogout\(\)\s*\{[\s\S]{0,200}staffLogoutAll\(/.test(src), 'has its own copy');
    }
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
