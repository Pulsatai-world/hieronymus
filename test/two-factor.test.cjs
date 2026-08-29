// Exercises the real login endpoints and the real TOTP verifier against a stubbed Blobs store.
//
// The point of these assertions is the JOIN, not the halves: a previous bug here got through because
// "who may read a record" and "what the login returns" were each tested alone. So every case below
// drives an actual HTTP-shaped request through the real handler and asserts on the real response —
// including that the shared secret never appears in one.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

// ── Loading the real handlers ──
// These are ES modules that reach for Netlify Blobs at call time, so they are evaluated in a vm with
// getStore injected — the same lift-the-real-source approach the other suites here use. Nothing is
// reimplemented: the code under test is the code that ships.
const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});
const getStore = name => ({
  get: async (k, o) => (k in store(name)
    ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k])
    : null),
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  set: async (k, v) => { store(name)[k] = v; },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

// Sibling ./lib modules are inlined ahead of the handler, the same way Netlify's bundler follows
// the import. Keeps the suite honest: it runs the shared gate, not a copy of it.
function libSource(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  const libs = [...raw.matchAll(/^import \{([^}]+)\} from '\.\/(lib\/[\w.-]+)';$/gm)];
  return libs.map(m => fs.readFileSync('netlify/functions/' + m[2], 'utf8')
    .replace(/^import .*?;$/gm, '')
    .replace(/^export (function|const|async function) /gm, '$1 ')).join('\n');
}

function libSourceRaw(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  return [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')).join('\n');
}

function load(file) {
  let src = libSource(file) + '\n' + fs.readFileSync('netlify/functions/' + file, 'utf8')
    .replace(/^import .*?;$/gm, '')            // getStore and crypto come from the context instead
    .replace(/^export default /m, 'EXPORTS.handler = ')
    .replace(/^export (function|const|async function) /gm, '$1 ');
  // Re-export anything the file declared with `export`, so helpers stay testable.
  const named = [...(fs.readFileSync('netlify/functions/' + file, 'utf8') + libSourceRaw(file))
    .matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]);
  src += '\n' + named.map(n => 'EXPORTS.' + n + ' = ' + n + ';').join('\n');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, Date, JSON,
                console, EXPORTS: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  return ctx.EXPORTS;
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

// Same construction as the server: base32 secret, HMAC-SHA1 over the 30-second counter.
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

function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
const GET = (fn, qs) => fn(new Request('https://x/api/x?' + qs));
const POST = (fn, body) => fn(new Request('https://x/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}));

(async () => {
  const tf = load('two-factor.js');
  const twoFactor = tf.handler;
  const staffUsers = load('staff-users.js').handler;
  const staffSession = load('staff-session.js').handler;
  const intakeCodes = load('intake-codes.js').handler;

  const PW = 'correct-horse';
  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-staff-users')['akore-rene'] = { username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW), createdAt: '2026-01-01T00:00:00Z' };
    store('hieronymus-intake-codes')['fiacsa'] = {
      company: 'FIACSA', submittedAt: '2026-02-01T00:00:00Z',
      members: [{ username: 'fiacsa', role: 'full', passwordHash: scrypt(PW), createdAt: '2026-01-01T00:00:00Z' }]
    };
  };

  // ── The verifier itself ──
  console.log('The TOTP verifier:');
  {
    const { verifyTotp, newSecret } = tf;
    const s = newSecret();
    check('accepts the current code', verifyTotp(s, codeAt(s, nowStep())).ok, 'rejected');
    check('accepts one step early (clock skew)', verifyTotp(s, codeAt(s, nowStep() - 1)).ok, 'rejected');
    check('accepts one step late', verifyTotp(s, codeAt(s, nowStep() + 1)).ok, 'rejected');
    check('rejects two steps away', !verifyTotp(s, codeAt(s, nowStep() - 2)).ok, 'accepted a stale code');
    check('rejects a wrong code', !verifyTotp(s, '000001').ok || codeAt(s, nowStep()) === '000001', 'accepted');
    check('rejects a short code', !verifyTotp(s, '1234').ok, 'accepted');
    check("rejects another secret's code", !verifyTotp(s, codeAt(newSecret(), nowStep())).ok, 'accepted');
    check('reports which step matched', verifyTotp(s, codeAt(s, nowStep())).step === nowStep(), 'no step');
  }

  // ── Enrollment ──
  console.log('\nEnrollment (two-step, so a mistyped key cannot lock the account out):');
  reset();
  let staffSecret;
  {
    const res = await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: 'wrong' });
    check('begin refuses a bad password', res.status === 403, 'status ' + res.status);

    const ok = await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW });
    const body = await ok.json();
    staffSecret = body.secret;
    check('begin issues a secret', ok.status === 200 && /^[A-Z2-7]{32}$/.test(staffSecret || ''), JSON.stringify(body));
    check('secret is held pending, not active', !!store('hieronymus-staff-users')['akore-rene'].totp.pendingSecret
      && !store('hieronymus-staff-users')['akore-rene'].totp.enabledAt, 'enabled too early');

    const bad = await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: '111111' });
    check('confirm rejects a wrong code', bad.status === 403 || codeAt(staffSecret, nowStep()) === '111111', 'status ' + bad.status);
    check('still not enabled after a failed confirm', !store('hieronymus-staff-users')['akore-rene'].totp.enabledAt, 'enabled anyway');

    const good = await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(staffSecret, nowStep()) });
    const gbody = await good.json();
    check('confirm with a live code enables it', good.status === 200 && gbody.status === 'enabled', JSON.stringify(gbody));
    check('confirm returns a token so setup leads straight in', !!gbody.tfToken, 'no token');
    check('pending secret is cleared', !store('hieronymus-staff-users')['akore-rene'].totp.pendingSecret, 'still pending');
  }

  // ── Mandatory enrollment at the login ──
  console.log('\nA correct password with no authenticator yet:');
  reset();
  {
    const res = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    const body = await res.json();
    check('staff login is refused with needsEnrollment', res.status === 401 && body.needsEnrollment === true, JSON.stringify(body));

    const sres = await POST(staffSession, { username: 'akore-rene', password: PW });
    const sbody = await sres.json();
    check('no session token is minted', sres.status === 401 && sbody.needsEnrollment === true && !sbody.token, JSON.stringify(sbody));

    const cres = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW));
    const cbody = await cres.json();
    check('customer login is refused too', cres.status === 401 && cbody.needsEnrollment === true, JSON.stringify(cbody));
    check('a wrong password still reads as a wrong password', (await GET(intakeCodes, 'username=fiacsa&password=nope')).status === 401, '');
  }

  // ── Logging in once enrolled ──
  console.log('\nLogging in with an authenticator enrolled:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    const secret = b.secret;

    const noCode = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW));
    check('password alone now asks for a code', noCode.status === 401 && (await noCode.json()).needsCode === true, 'status ' + noCode.status);

    const wrong = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=000000');
    check('a wrong code is refused', wrong.status === 403 || codeAt(secret, nowStep()) === '000000', 'status ' + wrong.status);

    const good = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=' + codeAt(secret, nowStep()));
    const gbody = await good.json();
    check('the right code logs in', good.status === 200 && gbody.company === 'FIACSA', JSON.stringify(gbody));
    check('login reports two-factor is on', gbody.twoFactorEnabled === true, JSON.stringify(gbody));
    check('release flags still travel with it', 'diagnosisReleased' in gbody && 'monitoringReleased' in gbody, JSON.stringify(gbody));
    check('a session token comes back', !!gbody.tfToken, 'no tfToken');

    // Replay: the same code inside its own 30-second window must not work twice.
    const replay = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=' + codeAt(secret, nowStep()));
    check('the same code cannot be used twice', replay.status === 403, 'status ' + replay.status);

    // The token stands in for a code on the next page.
    const withTok = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=' + gbody.tfToken);
    check('the token skips the code on the next page', withTok.status === 200, 'status ' + withTok.status);

    const stolen = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=' + 'deadbeef');
    check('an unknown token does not', stolen.status === 401, 'status ' + stolen.status);

    // A token issued to someone else must not work here.
    store('hieronymus-2fa-sessions')['other-token'] = { username: 'someone-else', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    const wrongUser = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=other-token');
    check("another account's token is rejected", wrongUser.status === 401, 'status ' + wrongUser.status);

    store('hieronymus-2fa-sessions')['expired'] = { username: 'fiacsa', expiresAt: '2020-01-01T00:00:00Z' };
    const exp = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=expired');
    check('an expired token is rejected', exp.status === 401, 'status ' + exp.status);
  }

  // ── Throttling: six digits is a million guesses ──
  console.log('\nThrottling repeated wrong codes:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    let last;
    for (let i = 0; i < 5; i++) {
      last = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=0000' + String(10 + i));
    }
    // The fifth wrong code is still answered as a wrong code; the lock it triggers bites from the
    // next attempt on. Asserting the lock itself rather than that particular status.
    check('the fifth wrong code is refused', last.status === 403, 'status ' + last.status);
    const locked = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=000099');
    check('and the account is then locked out', locked.status === 429, 'status ' + locked.status);
    const evenRight = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=' + codeAt(b.secret, nowStep()));
    check('even a correct code is refused while locked', evenRight.status === 429, 'status ' + evenRight.status);
  }

  // ── The secret must never leave the server ──
  console.log('\nThe shared secret never appears in a response:');
  reset();
  {
    const sb = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(sb.secret, nowStep()) });
    const cb = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(cb.secret, nowStep() - 1) });

    const list = await (await GET(staffUsers, '')).text();
    check('staff listing carries no secret', !list.includes(sb.secret) && !list.includes('totp'), list.slice(0, 200));
    check('staff listing reports enrollment instead', list.includes('twoFactorEnabled'), list.slice(0, 200));

    const login = await (await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW)
      + '&code=' + codeAt(sb.secret, nowStep()))).text();
    check('staff login carries no secret', !login.includes(sb.secret), login.slice(0, 200));

    const rec = await (await GET(intakeCodes, 'company=FIACSA&staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW))).text();
    check('customer record carries no secret', !rec.includes(cb.secret) && !rec.includes('pendingSecret'), rec.slice(0, 300));
    check('customer record reports enrollment instead', rec.includes('twoFactorEnabled'), rec.slice(0, 300));

    const status = await (await GET(twoFactor, 'username=fiacsa')).json();
    check('the status endpoint reports only the fact', status.enabled === true && !('secret' in status), JSON.stringify(status));
  }

  // ── Recovery ──
  console.log('\nResetting a lost authenticator:');
  reset();
  {
    const cb = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(cb.secret, nowStep() - 1) });

    const nope = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'fiacsa', requestingStaffPassword: PW });
    check('a customer cannot reset their own two-factor', nope.status === 403, 'status ' + nope.status);

    const badPw = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: 'wrong' });
    check("a staff password must be right", badPw.status === 403, 'status ' + badPw.status);

    const ok = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW });
    check('an admin can reset it', ok.status === 200, 'status ' + ok.status);
    check('the enrollment is gone', !store('hieronymus-intake-codes')['fiacsa'].members[0].totp, 'still enrolled');

    const after = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW));
    check('and they are sent back through setup', after.status === 401 && (await after.json()).needsEnrollment === true, 'status ' + after.status);
  }

  // ── The forced sign-out ──
  console.log('\nSessions minted before two-factor became mandatory:');
  {
    const src = fs.readFileSync('netlify/functions/prompts.js', 'utf8');
    check('token validators enforce a session cutoff', src.includes('SESSION_EPOCH'), 'no epoch check');
    const files = fs.readdirSync('netlify/functions').filter(f => f.endsWith('.js')).filter(f => {
      const t = fs.readFileSync('netlify/functions/' + f, 'utf8');
      return t.includes('hieronymus-staff-sessions') && t.includes('async function staffFromToken');
    });
    const missing = files.filter(f => !fs.readFileSync('netlify/functions/' + f, 'utf8').includes('SESSION_EPOCH'));
    check('every endpoint that accepts a token checks it', missing.length === 0, 'missing in: ' + missing.join(', '));

    const epoch = fs.readFileSync('js/auth-epoch.js', 'utf8');
    ['hieronymus_internal_auth', 'hieronymus_staff_token', 'geo_portal_password', 'geo_2fa_token'].forEach(k => {
      check('the browser wipe clears ' + k, epoch.includes(k), 'not listed');
    });
  }

  // ── Two-factor at the door, password behind it ──
  // The in-app gates re-check the password of someone already signed in. Routing those through the
  // full login would have demanded a code for every run-audit, dashboard release and delete — and
  // since confirm-gate.js verified against the login endpoint, that is exactly what shipping this
  // without verifyOnly would have done.
  console.log('\nConfirming a password behind an existing login:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(b.secret, nowStep() - 1) });

    const res = await GET(staffUsers, 'verifyOnly=1&username=akore-rene&password=' + encodeURIComponent(PW));
    const body = await res.json();
    check('an enrolled account can confirm its password with no code', res.status === 200 && body.ok === true, JSON.stringify(body));

    // It must confirm and nothing more: no record, no role, no token, no session.
    check('it returns nothing but a yes', Object.keys(body).length === 1 && 'ok' in body, JSON.stringify(body));
    ['passwordHash', 'totp', 'tfToken', 'role', 'username'].forEach(k => {
      check('the confirmation does not leak ' + k, !(k in body), JSON.stringify(body));
    });
    check('no session token was minted by it', Object.keys(STORES['hieronymus-2fa-sessions'] || {}).length === 1,
      'sessions: ' + Object.keys(STORES['hieronymus-2fa-sessions'] || {}).length);

    const bad = await GET(staffUsers, 'verifyOnly=1&username=akore-rene&password=wrong');
    check('a wrong password is still refused', bad.status === 401, 'status ' + bad.status);

    // And it must not become a way around the login itself.
    const login = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    check('logging in still demands a code', login.status === 401 && (await login.json()).needsCode === true, 'status ' + login.status);
    const listing = await GET(staffUsers, 'verifyOnly=1');
    const lbody = await listing.json();
    check('verifyOnly with no username cannot answer yes', lbody.ok !== true, JSON.stringify(lbody).slice(0, 120));
  }

  console.log('\nThe in-app gates and the API-key change:');
  {
    const gate = fs.readFileSync('js/confirm-gate.js', 'utf8');
    check('confirm-gate asks for password only', gate.includes('verifyOnly=1'), 'still uses the login path');
    check('and accepts only an explicit yes', gate.includes('data.ok !== true'), 'weaker check');

    const portal = fs.readFileSync('portal.html', 'utf8');
    const i = portal.indexOf('async function saveResetKey');
    const j = portal.indexOf("'/api/customer-keys'", i);
    check('changing a customer API key is password-gated',
      i > -1 && j > i && portal.slice(i, j).includes('requirePassword'), 'no gate before the write');
  }

  // ── The page wiring ──
  // The server can be perfect and the feature still absent, because a gate that never asks for a
  // code lets nobody in and a page that logs in its own way bypasses the shared handling entirely.
  console.log('\nEvery login page is wired to the shared handling:');
  {
    const CLIENT = ['client-portal.html', 'intake.html', 'prompt-review.html'];
    const STAFF = ['portal.html', 'index.html', 'intake-view.html'];

    CLIENT.forEach(f => {
      const src = fs.readFileSync(f, 'utf8');
      check(f + ' logs in through window.clientLogin', src.includes('window.clientLogin('), 'not used');
      check(f + ' has a code field', src.includes('id="gate-code-input"'), 'missing');
      check(f + ' sends unenrolled users to setup', src.includes('needsEnrollment') && src.includes('startTwoFactorSetup'), 'missing');
      // The whole point of routing through the shared helper is that no page keeps its own login.
      check(f + ' has no hand-rolled login call left',
        !/fetch\('\/api\/intake-codes\?username='/.test(src), 'still builds its own login URL');
      check(f + ' loads the setup module', src.includes('two-factor-setup.js'), 'not loaded');
    });

    STAFF.forEach(f => {
      const src = fs.readFileSync(f, 'utf8');
      check(f + ' logs in through window.staffGateLogin', src.includes('window.staffGateLogin('), 'not used');
      check(f + ' has a code field', src.includes('id="code-input"'), 'missing');
      check(f + ' has no hand-rolled login call left',
        !/fetch\('\/api\/staff-users\?username='/.test(src), 'still builds its own login URL');
      check(f + ' loads the setup module', src.includes('two-factor-setup.js'), 'not loaded');
    });

    // The wipe has to run before anything reads a session, or staff stay signed in for one more load.
    [...CLIENT, ...STAFF, 'dashboard-diagnostic.html', 'dashboard-monitoring.html'].forEach(f => {
      const src = fs.readFileSync(f, 'utf8');
      const first = src.indexOf('<script');
      check(f + ' loads auth-epoch.js first', src.slice(first, first + 60).includes('auth-epoch.js'),
        src.slice(first, first + 60).replace(/\n/g, ' '));
    });

    // Enrollment copy is shown to customers, so both languages have to be complete.
    const setup = fs.readFileSync('js/two-factor-setup.js', 'utf8');
    const keys = [...setup.matchAll(/^    (\w+):\s*\{ en:/gm)].map(m => m[1]);
    check('the setup dialog has strings', keys.length >= 12, keys.length + ' found');
    const missingEs = [...setup.matchAll(/^    (\w+):\s*\{ en: ([\s\S]*?)\},$/gm)]
      .filter(m => !m[2].includes('es:')).map(m => m[1]);
    check('every string has a Spanish translation', missingEs.length === 0, 'missing: ' + missingEs.join(', '));
    check('the secret is never sent to a third party for a QR image',
      !/api\.qrserver|chart\.googleapis|qrcode/i.test(setup), 'an external QR service is referenced');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all assertions passed'));
  process.exit(failures ? 1 : 0);
})();
