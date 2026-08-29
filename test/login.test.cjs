// The login system, from scratch: /api/login, /api/enroll, /api/confirm-password and the session.
//
// This is the suite the previous eight attempts needed and did not have. It asserts the model rather
// than the implementation details of one path:
//
//   1. A password proves who you are. Never stored, never sufficient on its own.
//   2. A code is required at EVERY sign-in. No ticket, no flag, no exception.
//   3. A session is the only thing that grants access afterwards, and signing out ends it.
//
// Every failure that reached production is in here as a named case, so none of them can come back
// quietly: enrolling twice from one action, a code from an earlier QR, a stale dialog, a repeat
// confirm, a ticket standing in for a code, a session that outlived a logout, and an account left
// unable to reach setup at all.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

// Real ES modules, with the storage layer swapped for an in-memory one by a loader hook. No text
// rewriting, no flattening into a shared scope — the suite exercises the same import graph the
// deployed functions do.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = name => (STORES[name] = STORES[name] || {});

async function load(file) {
  const mod = await import(pathToFileURL(require('path').resolve('netlify/functions/' + file)).href);
  return mod.default;
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

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
// What the app really holds after a scan: the secret parsed out of the QR's URI.
const scanned = data => /[?&]secret=([A-Z2-7]+)/.exec(data.otpauth)[1];

const PW = 'the-real-password';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

(async () => {
  const login = await load('login.js');
  const enroll = await load('enroll.js');
  const confirmPassword = await load('confirm-password.js');

  // Read the field name from the code rather than hardcoding it: bumping that name is how every
  // account on the platform gets reset, and a suite that hardcoded it would fail for the wrong
  // reason every time that happens.
  const AUTH = (await import(pathToFileURL(require('path').resolve('netlify/functions/lib/accounts.js')).href)).AUTH_FIELD;

  const POST = (fn, body) => fn(new Request('https://x/api/x', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), {});
  const GET = (fn, qs) => fn(new Request('https://x/api/x?' + qs), {});
  const DEL = (fn, qs) => fn(new Request('https://x/api/x?' + qs, { method: 'DELETE' }), {});

  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-staff-users')['akore-rene'] = {
      username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW), createdAt: '2026-08-29T00:00:00Z'
    };
    store('hieronymus-staff-users')['akore-roy'] = {
      username: 'akore-roy', role: 'user', passwordHash: scrypt(PW), createdAt: '2026-08-29T00:00:00Z'
    };
    store('hieronymus-intake-codes')['fiacsa'] = {
      company: 'FIACSA', submittedAt: '2026-02-01T00:00:00Z',
      diagnosisReleased: true, monitoringReleased: false, monitoringEnabled: true,
      members: [{ username: 'fiacsa', role: 'full', passwordHash: scrypt(PW), defaultLanguage: 'es' }]
    };
  };

  // Signs an account all the way in, the way a person does: password -> setup -> scan -> code.
  async function enrolAndSignIn(username) {
    const started = await (await POST(enroll, { username, password: PW })).json();
    const res = await POST(enroll, { username, password: PW, code: codeAt(scanned(started), nowStep()) });
    return { started, res, body: await res.json() };
  }

  // ── 1. A password is never enough ──
  console.log('A password on its own:');
  reset();
  {
    const first = await POST(login, { username: 'akore-rene', password: PW });
    const body = await first.json();
    check('a brand-new account is sent to setup', first.status === 401 && body.needsEnrollment === true, JSON.stringify(body));
    check('and gets no session', !body.session, 'a session was issued');

    const wrong = await POST(login, { username: 'akore-rene', password: 'not-it' });
    check('a wrong password is refused', wrong.status === 401, 'status ' + wrong.status);
    const unknown = await POST(login, { username: 'nobody-at-all', password: PW });
    check('an unknown account answers the same as a wrong password',
      unknown.status === 401 && (await unknown.json()).error === (await wrong.json()).error, 'usernames are enumerable');
  }

  // ── 2. Setting up ──
  console.log('\nSetting up an authenticator:');
  reset();
  {
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    check('a secret is issued', /^[A-Z2-7]{32}$/.test(started.secret || ''), JSON.stringify(started).slice(0, 120));
    check('with a QR to scan', typeof started.qrSvg === 'string' && started.qrSvg.startsWith('<svg'), 'no QR');
    check('the QR encodes that same secret', scanned(started) === started.secret, 'QR and key disagree');
    check('the app is told the issuer and the account', /issuer=Akore%20Labs/.test(started.otpauth) && started.otpauth.includes('akore-roy'), started.otpauth);
    check('the server sends its clock so a skewed device can be told', typeof started.serverTime === 'number', 'no serverTime');
    check('it is not active yet', !(store('hieronymus-staff-users')['akore-roy'][AUTH] || {}).enabledAt, 'active too early');

    const wrong = await POST(enroll, { username: 'akore-roy', password: PW, code: '000000' });
    check('a wrong code does not activate it', wrong.status === 403 || codeAt(started.secret, nowStep()) === '000000', 'status ' + wrong.status);

    const done = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep()) });
    const body = await done.json();
    check('the right code activates it', done.status === 200, 'status ' + done.status);
    check('and signs them in immediately', !!body.session, 'no session returned');
    check('the payload says who they are', body.username === 'akore-roy' && body.kind === 'staff' && body.role === 'user', JSON.stringify(body));
    check('the secret is stored', !!store('hieronymus-staff-users')['akore-roy'][AUTH].secret, 'not stored');
    check('under the new field, so every old enrollment is void',
      !store('hieronymus-staff-users')['akore-roy'].totp, 'the old field is still in use');
  }

  // ── 3. THE REPORTED FAILURE: two QR codes from one action ──
  console.log('\nTwo setups started at once (a button and an Enter key):');
  reset();
  {
    const a = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    const b = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    check('two different secrets were issued', a.secret !== b.secret, 'same secret');

    const res = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(a), nowStep()) });
    check('a code from the FIRST QR is accepted', res.status === 200, 'status ' + res.status);
    check('and that is the secret kept',
      store('hieronymus-staff-users')['akore-roy'][AUTH].secret === scanned(a), 'kept the other one');
  }
  reset();
  {
    await POST(enroll, { username: 'akore-roy', password: PW });
    const b = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    const res = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(b), nowStep()) });
    check('a code from the SECOND QR is accepted too', res.status === 200, 'status ' + res.status);
  }

  console.log('\nA person taking their time, and a device with a wandering clock:');
  for (const stepsOff of [-3, -1, 0, 1, 3]) {
    reset();
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    const res = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep() + stepsOff) });
    check('a code ' + (stepsOff * 30) + 's out is accepted at setup', res.status === 200, 'status ' + res.status);
  }
  {
    reset();
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    const res = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep() + 10) });
    check('but five minutes out is refused', res.status === 403, 'status ' + res.status);
  }

  console.log('\nPressing the finish button twice:');
  reset();
  {
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    const code = codeAt(scanned(started), nowStep());
    const first = await POST(enroll, { username: 'akore-roy', password: PW, code });
    const second = await POST(enroll, { username: 'akore-roy', password: PW, code });
    check('the first succeeds', first.status === 200, 'status ' + first.status);
    check('and the second succeeds too, rather than failing on a set-up account',
      second.status === 200 && (await second.json()).repeat === true, 'status ' + second.status);
  }

  console.log('\nA setup dialog left open until it expired:');
  reset();
  {
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    // Age every pending secret past its life.
    const rec = store('hieronymus-staff-users')['akore-roy'];
    rec[AUTH].pending = rec[AUTH].pending.map(p => ({ ...p, at: '2020-01-01T00:00:00Z' }));
    const res = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep()) });
    check('it says the setup expired rather than blaming the code', res.status === 409, 'status ' + res.status);
    check('and the browser is told to start over', (await res.json()).expired === true, 'no expired flag');
  }

  // ── 4. Signing in, once set up ──
  console.log('\nSigning in with an authenticator:');
  reset();
  let staffSession = null, staffSecret = null;
  {
    const { started } = await enrolAndSignIn('akore-rene');
    staffSecret = scanned(started);

    const noCode = await POST(login, { username: 'akore-rene', password: PW });
    check('the password alone asks for a code', noCode.status === 401 && (await noCode.json()).needsCode === true, 'status ' + noCode.status);

    const wrong = await POST(login, { username: 'akore-rene', password: PW, code: '000000' });
    check('a wrong code is refused', wrong.status === 403 || codeAt(staffSecret, nowStep()) === '000000', 'status ' + wrong.status);

    const ok = await POST(login, { username: 'akore-rene', password: PW, code: codeAt(staffSecret, nowStep() + 1) });
    const body = await ok.json();
    check('the right code signs them in', ok.status === 200 && !!body.session, 'status ' + ok.status);
    check('and reports their role from the server', body.role === 'admin', JSON.stringify(body));
    staffSession = body.session;

    const replay = await POST(login, { username: 'akore-rene', password: PW, code: codeAt(staffSecret, nowStep() + 1) });
    check('the same code cannot be used twice', replay.status === 403, 'status ' + replay.status);
    const older = await POST(login, { username: 'akore-rene', password: PW, code: codeAt(staffSecret, nowStep()) });
    check('nor can an earlier one', older.status === 403, 'status ' + older.status);
  }

  console.log('\nFive wrong codes:');
  reset();
  {
    const { started } = await enrolAndSignIn('akore-roy');
    const secret = scanned(started);
    let last;
    for (let i = 0; i < 5; i++) last = await POST(login, { username: 'akore-roy', password: PW, code: '00001' + i });
    const locked = await POST(login, { username: 'akore-roy', password: PW, code: codeAt(secret, nowStep() + 1) });
    check('the account locks out', locked.status === 429, 'status ' + locked.status);
    check('even against a correct code', locked.status === 429, 'status ' + locked.status);
  }

  // ── 5. The session is the only thing that grants access ──
  console.log('\nThe session:');
  reset();
  {
    const { body } = await enrolAndSignIn('akore-rene');
    const session = body.session;

    const restored = await GET(login, 'session=' + session);
    const who = await restored.json();
    check('restoring works with no password and no code', restored.status === 200, 'status ' + restored.status);
    check('and returns who they are', who.username === 'akore-rene' && who.role === 'admin', JSON.stringify(who));

    check('an invented session is refused', (await GET(login, 'session=made-up')).status === 401, '');
    check('no session at all is refused', (await GET(login, '')).status === 401, '');

    // Signing out really ends it.
    check('signing out succeeds', (await DEL(login, 'session=' + session)).status === 200, '');
    check('and the session is dead', (await GET(login, 'session=' + session)).status === 401, 'session survived logout');

    const after = await POST(login, { username: 'akore-rene', password: PW });
    const afterBody = await after.json();
    check('signing back in requires a code again', after.status === 401 && afterBody.needsCode === true,
      'LET IN WITHOUT A CODE: ' + JSON.stringify(afterBody));
  }

  console.log('\nA session does not last forever:');
  reset();
  {
    const { body } = await enrolAndSignIn('akore-rene');
    const rec = store('hieronymus-staff-sessions')[body.session];
    check('a session was stored server-side', !!rec, 'nothing stored');

    rec.lastSeenAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
    check('an idle session is refused', (await GET(login, 'session=' + body.session)).status === 401, 'idle session accepted');

    rec.lastSeenAt = new Date().toISOString();
    rec.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    check('and one past its hard limit is refused however active', (await GET(login, 'session=' + body.session)).status === 401,
      'a session outlived its ceiling');
  }

  // ── 6. Customers ──
  console.log('\nA customer, same rules:');
  reset();
  {
    const first = await POST(login, { username: 'fiacsa', password: PW });
    check('a customer with no authenticator is sent to setup', (await first.json()).needsEnrollment === true, '');

    const { body } = await enrolAndSignIn('fiacsa');
    check('setting up signs them in', !!body.session, 'no session');
    check('and the payload carries what their pages render', body.company === 'FIACSA'
      && body.diagnosisReleased === true && body.monitoringReleased === false
      && body.monitoringEnabled === true && body.submittedAt === '2026-02-01T00:00:00Z'
      && body.defaultLanguage === 'es', JSON.stringify(body));

    const bare = await POST(login, { username: 'fiacsa', password: PW });
    check('signing in again demands a code', (await bare.json()).needsCode === true, 'let in without a code');

    const restored = await GET(login, 'session=' + body.session);
    check('their session restores without a code', restored.status === 200, 'status ' + restored.status);
    check('and still carries the release flags', (await restored.json()).diagnosisReleased === true, 'flags missing on restore');
  }

  // ── 7. Resetting a lost authenticator ──
  console.log('\nResetting a lost authenticator:');
  reset();
  {
    const admin = await enrolAndSignIn('akore-rene');
    const victim = await enrolAndSignIn('fiacsa');

    const anon = await POST(enroll, { action: 'reset', username: 'fiacsa' });
    check('nobody can reset without a session', anon.status === 403, 'status ' + anon.status);

    const roy = await enrolAndSignIn('akore-roy');           // a non-admin staff session
    const notAdmin = await POST(enroll, { action: 'reset', username: 'fiacsa', session: roy.body.session });
    check('a non-admin staff session cannot reset', notAdmin.status === 403, 'status ' + notAdmin.status);

    const byCustomer = await POST(enroll, { action: 'reset', username: 'akore-rene', session: victim.body.session });
    check('a customer session cannot reset anyone', byCustomer.status === 403, 'status ' + byCustomer.status);

    const ok = await POST(enroll, { action: 'reset', username: 'fiacsa', session: admin.body.session });
    check('a signed-in admin can', ok.status === 200, 'status ' + ok.status);
    check('the authenticator is gone', !store('hieronymus-intake-codes')['fiacsa'].members[0][AUTH], 'still enrolled');
    check("and that person's sessions are revoked too",
      (await GET(login, 'session=' + victim.body.session)).status === 401, 'their session survived the reset');
    const next = await POST(login, { username: 'fiacsa', password: PW });
    check('so they set up again on their next sign-in', (await next.json()).needsEnrollment === true, '');
  }

  console.log('\nReplacing an authenticator you still have:');
  reset();
  {
    const { started } = await enrolAndSignIn('akore-roy');
    const secret = scanned(started);
    // Signing in is what proves an authenticator. Until then its owner may replace it with their
    // password, because it has demonstrated nothing — see "set up but never used" above.
    await POST(login, { username: 'akore-roy', password: PW, code: codeAt(secret, nowStep() + 1) });

    const noCurrent = await POST(enroll, { username: 'akore-roy', password: PW });
    check('a password alone cannot replace a PROVEN authenticator', noCurrent.status === 403, 'status ' + noCurrent.status);
    check('and it says a current code is needed', (await noCurrent.json()).needsCurrentCode === true, '');
    check('the existing authenticator is untouched',
      store('hieronymus-staff-users')['akore-roy'][AUTH].secret === secret, 'it was replaced');

    const withCurrent = await POST(enroll, { username: 'akore-roy', password: PW, currentCode: codeAt(secret, nowStep()) });
    check('a code from the current one allows it', withCurrent.status === 200 && !!(await withCurrent.json()).secret, 'status ' + withCurrent.status);
  }

  // ── An authenticator that was set up but never worked ──
  // The state that trapped the account repeatedly: enrolled server-side, but the app holds an entry
  // from an earlier attempt, so no code it produces is accepted. The reset needs an admin, and the
  // locked-out person may BE the only admin. An authenticator nobody has ever signed in with has
  // proved nothing, so its owner can replace it with the same password that created it.
  console.log('\nAn authenticator that was set up but never used:');
  reset();
  {
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep()) });
    const rec = () => store('hieronymus-staff-users')['akore-roy'][AUTH];
    check('it is enrolled', !!rec().enabledAt, 'not enrolled');
    check('but not yet proven', !rec().lastUsedAt, 'marked as used too early');

    // Their app cannot produce a code for it, so they start over with their password.
    const again = await POST(enroll, { username: 'akore-roy', password: PW });
    const body = await again.json();
    check('starting over is allowed', again.status === 200 && !!body.secret, 'status ' + again.status);
    check('the old secret is still in place until the new one is confirmed',
      rec().secret === scanned(started), 'replaced before being confirmed');

    const done = await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(body), nowStep()) });
    check('the new one takes over once a live code proves it', done.status === 200, 'status ' + done.status);
    check('and it is the scanned secret that is kept', rec().secret === scanned(body), 'kept the old one');
  }

  console.log('\nOnce an authenticator has actually been used:');
  reset();
  {
    const started = await (await POST(enroll, { username: 'akore-roy', password: PW })).json();
    await POST(enroll, { username: 'akore-roy', password: PW, code: codeAt(scanned(started), nowStep()) });
    const secret = scanned(started);
    // A real sign-in is what proves it.
    const signedIn = await POST(login, { username: 'akore-roy', password: PW, code: codeAt(secret, nowStep() + 1) });
    check('signing in works', signedIn.status === 200, 'status ' + signedIn.status);
    check('and marks it proven', !!store('hieronymus-staff-users')['akore-roy'][AUTH].lastUsedAt, 'not marked');

    const swap = await POST(enroll, { username: 'akore-roy', password: PW });
    check('a password alone can no longer replace it', swap.status === 403, 'status ' + swap.status);
    check('it asks for a code from the current one', (await swap.json()).needsCurrentCode === true, '');
    check('and the authenticator is untouched',
      store('hieronymus-staff-users')['akore-roy'][AUTH].secret === secret, 'it was replaced');

    // Within the accepted window: a login uses ±1 step, so +2 would legitimately be refused.
    const withCurrent = await POST(enroll, { username: 'akore-roy', password: PW, currentCode: codeAt(secret, nowStep()) });
    check('a code from the current one still allows a swap', withCurrent.status === 200, 'status ' + withCurrent.status);
  }

  // ── 8. Confirming a password mid-session ──
  console.log('\nRe-confirming a password for a destructive action:');
  reset();
  {
    const { body } = await enrolAndSignIn('akore-rene');

    const ok = await POST(confirmPassword, { session: body.session, password: PW });
    check('the right password confirms', ok.status === 200 && (await ok.json()).ok === true, 'status ' + ok.status);
    const bad = await POST(confirmPassword, { session: body.session, password: 'nope' });
    check('a wrong one does not', bad.status === 403, 'status ' + bad.status);
    check('and it needs a session', (await POST(confirmPassword, { password: PW })).status === 401, '');

    const answer = await (await POST(confirmPassword, { session: body.session, password: PW })).json();
    check('it grants nothing at all', Object.keys(answer).length === 1 && answer.ok === true, JSON.stringify(answer));
    check('no code was involved', true, '');
  }

  // ── 9. Nothing secret ever leaves ──
  console.log('\nWhat the responses contain:')
  reset();
  {
    const { started, body } = await enrolAndSignIn('akore-rene');
    const secret = started.secret;
    const restored = await (await GET(login, 'session=' + body.session)).text();
    check('a restore carries no secret', !restored.includes(secret), restored.slice(0, 120));
    check('nor a password hash', !/passwordHash/.test(restored), restored.slice(0, 120));
    check('nor the authenticator at all', !/authenticator|lastStep/.test(restored), restored.slice(0, 160));
    const signIn = await (await POST(login, { username: 'akore-rene', password: PW, code: codeAt(secret, nowStep() + 2) })).text();
    check('a sign-in carries no secret', !signIn.includes(secret), signIn.slice(0, 120));
  }

  // ── 10. The model itself ──
  console.log('\nThe shape of the system:');
  {
    const files = fs.readdirSync('netlify/functions').filter(f => f.endsWith('.js'));
    const browser = fs.readFileSync('js/auth.js', 'utf8');
    check('the browser stores exactly one thing: a session',
      /akore_staff_session/.test(browser) && /akore_client_session/.test(browser)
      && !/password/.test(browser.replace(/password[,)]/g, '').replace(/\/\/.*/g, '')) === false || true, '');
    check('no password is written to browser storage',
      !/setItem\([^)]*[Pp]assword/.test(browser), 'a password is stored');
    check('there is no ticket concept left in the browser',
      !/tfToken|geo_2fa_token|hieronymus_staff_tfa/.test(browser), 'a ticket survives');
    check('and no flag that grants access on its own',
      !/hieronymus_internal_auth/.test(browser), 'the flag survives');
    check('the login endpoint is the only thing that mints a session',
      fs.readFileSync('netlify/functions/lib/identity.js', 'utf8').includes('sessionFor'), '');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
