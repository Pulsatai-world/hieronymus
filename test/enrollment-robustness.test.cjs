// The failure that reached the user five times: they scanned a QR, typed the code the authenticator
// showed, and the server answered 403 "that code is not valid" — on a brand-new account.
//
// The crypto was never wrong (the TOTP implementation matches the RFC 6238 vectors). The cause was
// that a single user action could issue MORE THAN ONE setup secret. Pressing Enter in the password
// field and clicking the button both call the page's login; each login that needed setup asked the
// server for a fresh secret; each new secret replaced the last in storage. Two QR codes reached the
// authenticator under an identical label, and only one of them could ever work.
//
// This suite issues several secrets on purpose and then confirms with a code derived from an EARLIER
// one, which is what a person holding two indistinguishable entries actually does.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const ENV = {};
const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});

// A store that can serve one stale read after a write, the way a distributed store may lag.
let staleNext = null;
const getStore = name => ({
  get: async (k, o) => {
    if (staleNext && staleNext.store === name && staleNext.key === k) {
      const snapshot = staleNext.value; staleNext = null;
      return o && o.type === 'json' ? JSON.parse(JSON.stringify(snapshot)) : snapshot;
    }
    return (k in store(name)) ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k]) : null;
  },
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  set: async (k, v) => { store(name)[k] = v; },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

function load(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  const libs = [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')
      .replace(/^import .*?;$/gm, '').replace(/^export (function|const|async function) /gm, '$1 ')).join('\n');
  const src = libs + '\n' + raw.replace(/^import .*?;$/gm, '').replace(/^export default /m, 'EXPORTS.handler = ');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, console,
                EXPORTS: {}, QRCode: require('qrcode'), process: { env: ENV } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  return ctx.EXPORTS.handler;
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

// TOTP exactly as an authenticator app computes it.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
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
// What the authenticator app actually stores: the secret parsed out of the scanned QR's URI.
const secretFromUri = uri => /[?&]secret=([A-Z2-7]+)/.exec(uri)[1];

const PW = 'a-real-password';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
const POST = (fn, body) => fn(new Request('https://x/api/two-factor', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), {});
const GET = (fn, qs) => fn(new Request('https://x/api/x?' + qs), {});

(async () => {
  const twoFactor = load('two-factor.js');
  const staffUsers = load('staff-users.js');

  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    staleNext = null;
    store('hieronymus-staff-users')['akore-roy'] = {
      username: 'akore-roy', role: 'user', passwordHash: scrypt(PW), createdAt: '2026-08-29T00:00:00Z'
    };
  };
  const begin = () => POST(twoFactor, { action: 'begin', username: 'akore-roy', password: PW });
  const confirm = code => POST(twoFactor, { action: 'confirm', username: 'akore-roy', password: PW, code });

  // ── THE REPORTED FAILURE ──
  console.log('A brand-new account issued two QR codes by one action:');
  reset();
  {
    const first = await (await begin()).json();
    const second = await (await begin()).json();
    check('both requests returned a QR', !!first.qrSvg && !!second.qrSvg, 'missing QR');
    check('and they are different secrets', first.secret !== second.secret, 'same secret twice');

    // The person scanned the FIRST QR. Its code must be accepted.
    const scanned = secretFromUri(first.otpauth);
    const res = await confirm(codeAt(scanned, nowStep()));
    const body = await res.json();
    check('a code from the FIRST QR is accepted', res.status === 200, 'status ' + res.status + ' ' + JSON.stringify(body));
    check('the account ends up enrolled', !!store('hieronymus-staff-users')['akore-roy'].totp.enabledAt, 'not enrolled');
    check('against the secret that was actually scanned',
      store('hieronymus-staff-users')['akore-roy'].totp.secret === scanned, 'stored a different secret');
    check('and the other candidates are dropped',
      !store('hieronymus-staff-users')['akore-roy'].totp.pending
      || store('hieronymus-staff-users')['akore-roy'].totp.pending.length === 0, 'candidates left behind');
  }

  console.log('\nThe same, scanning the SECOND QR:');
  reset();
  {
    await begin();
    const second = await (await begin()).json();
    const scanned = secretFromUri(second.otpauth);
    const res = await confirm(codeAt(scanned, nowStep()));
    check('a code from the newest QR is accepted', res.status === 200, 'status ' + res.status);
  }

  console.log('\nFive QR codes (a person retrying repeatedly) — any of them works:');
  reset();
  {
    const issued = [];
    for (let i = 0; i < 5; i++) issued.push(await (await begin()).json());
    for (let i = 0; i < issued.length; i++) {
      const fresh = () => { reset(); return null; };
      // Re-issue the same sequence for each attempt so each test starts from the same state.
      Object.keys(STORES).forEach(k => delete STORES[k]);
      store('hieronymus-staff-users')['akore-roy'] = {
        username: 'akore-roy', role: 'user', passwordHash: scrypt(PW), createdAt: '2026-08-29T00:00:00Z'
      };
      const again = [];
      for (let n = 0; n < 5; n++) again.push(await (await begin()).json());
      const scanned = secretFromUri(again[i].otpauth);
      const res = await confirm(codeAt(scanned, nowStep()));
      check('QR #' + (i + 1) + ' of 5 is accepted', res.status === 200, 'status ' + res.status);
    }
  }

  console.log('\nA sixth QR pushes the oldest out (the list is bounded):');
  reset();
  {
    const issued = [];
    for (let i = 0; i < 6; i++) issued.push(await (await begin()).json());
    const oldest = secretFromUri(issued[0].otpauth);
    const res = await confirm(codeAt(oldest, nowStep()));
    check('the oldest of six is refused', res.status === 403, 'status ' + res.status);
    const newest = secretFromUri(issued[5].otpauth);
    const ok = await confirm(codeAt(newest, nowStep()));
    check('the newest still works', ok.status === 200, 'status ' + ok.status);
  }

  console.log('\nA human takes time to read and type the code:');
  for (const stepsAgo of [0, 1, 2, 3]) {
    reset();
    const b = await (await begin()).json();
    const res = await confirm(codeAt(secretFromUri(b.otpauth), nowStep() - stepsAgo));
    check('a code from ' + (stepsAgo * 30) + 's ago is accepted', res.status === 200, 'status ' + res.status);
  }
  {
    reset();
    const b = await (await begin()).json();
    const res = await confirm(codeAt(secretFromUri(b.otpauth), nowStep() - 6));
    check('but one from 3 minutes ago is refused', res.status === 403, 'status ' + res.status);
  }

  console.log('\nA phone clock that is out by a minute still completes setup:');
  for (const skew of [-2, 2]) {
    reset();
    const b = await (await begin()).json();
    const res = await confirm(codeAt(secretFromUri(b.otpauth), nowStep() + skew));
    check('clock ' + (skew * 30) + 's off is tolerated at setup', res.status === 200, 'status ' + res.status);
  }

  console.log('\nThe store serving one stale read after the write:');
  reset();
  {
    const before = JSON.parse(JSON.stringify(store('hieronymus-staff-users')['akore-roy']));
    const b = await (await begin()).json();
    // The next read of this record returns the pre-begin copy, as a lagging replica would.
    staleNext = { store: 'hieronymus-staff-users', key: 'akore-roy', value: before };
    const res = await confirm(codeAt(secretFromUri(b.otpauth), nowStep()));
    // A stale read cannot see the pending secret at all, so this is the one case that legitimately
    // cannot succeed — it must at least fail in a way the dialog turns into a fresh start, not a
    // "wrong code" that makes the person doubt their authenticator.
    check('a stale read reports the setup as stale (409), not a wrong code', res.status === 409, 'status ' + res.status);
    const retry = await confirm(codeAt(secretFromUri(b.otpauth), nowStep()));
    check('and the very next attempt succeeds', retry.status === 200, 'status ' + retry.status);
  }

  console.log('\nNone of this weakens the check:');
  reset();
  {
    const b = await (await begin()).json();
    const wrong = await confirm('000000');
    check('a wrong code is still refused',
      wrong.status === 403 || codeAt(secretFromUri(b.otpauth), nowStep()) === '000000', 'status ' + wrong.status);
    const other = await confirm(codeAt('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', nowStep()));
    check("a code from an unrelated secret is refused", other.status === 403, 'status ' + other.status);
    check('the account is not enrolled by a failed attempt',
      !(store('hieronymus-staff-users')['akore-roy'].totp || {}).enabledAt, 'enrolled anyway');

    // And a login still demands a code once enrolled.
    const good = await confirm(codeAt(secretFromUri(b.otpauth), nowStep()));
    check('setup completes with the right code', good.status === 200, 'status ' + good.status);
    const login = await GET(staffUsers, 'username=akore-roy&password=' + encodeURIComponent(PW));
    check('and the login then demands a code', login.status === 401 && (await login.json()).needsCode === true,
      'status ' + login.status);
  }

  console.log('\nOne action cannot open two dialogs (the browser side):');
  {
    const setup = fs.readFileSync('js/two-factor-setup.js', 'utf8');
    check('startTwoFactorSetup returns the dialog already open', /if \(openSetup\) return openSetup;/.test(setup),
      'no in-flight guard');
    const auth = fs.readFileSync('js/results-auth.js', 'utf8');
    check('a second login joins the one in flight', /function dedupe\(/.test(auth) && /dedupe\('staff:/.test(auth),
      'no login dedupe');
    check('and the client login too', /dedupe\('client:/.test(auth), 'client login not deduped');
    check('the post-enrollment retry bypasses the dedupe so it cannot deadlock',
      /staffGateLoginOnce\(username, password, '', lang, \{ useTicket: true \}\)/.test(auth),
      'recursion goes through the wrapper and would hang');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
