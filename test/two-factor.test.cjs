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
const ENV = {};
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
                console, EXPORTS: {}, QRCode: require('qrcode'), process: { env: ENV } };
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
  // Issues a live two-factor ticket, exactly as a successful login would. Scoped reads and admin
  // actions now require one alongside the password.
  const ticketFor = name => {
    const t = 'ticket-' + name;
    store('hieronymus-2fa-sessions')[t] = {
      username: name, expiresAt: new Date(Date.now() + 11 * 3600 * 1000).toISOString()
    };
    return t;
  };
  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    // The one-shot lockout recovery in staff-users.js is keyed to this very username, so it would
    // fire mid-test and clear the enrollment the test just made. Marked spent here; the recovery
    // itself is covered by its own assertions.
    store('hieronymus-staff-sessions')['__recovery_used_akore-rene'] = { at: '2026-08-29T00:00:00Z' };
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

    // The listing is staff-only now, so it is read the way the Portal reads it.
    const list = await (await GET(staffUsers, 'staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW)
      + '&tfToken=' + ticketFor('akore-rene'))).text();
    check('staff listing carries no secret', !list.includes(sb.secret) && !list.includes('totp'), list.slice(0, 200));
    check('staff listing reports enrollment instead', list.includes('twoFactorEnabled'), list.slice(0, 200));

    const login = await (await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW)
      + '&code=' + codeAt(sb.secret, nowStep()))).text();
    check('staff login carries no secret', !login.includes(sb.secret), login.slice(0, 200));

    const rec = await (await GET(intakeCodes, 'company=FIACSA&staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW)
      + '&tfToken=' + ticketFor('akore-rene'))).text();
    check('customer record carries no secret', !rec.includes(cb.secret) && !rec.includes('pendingSecret'), rec.slice(0, 300));
    check('customer record reports enrollment instead', rec.includes('twoFactorEnabled'), rec.slice(0, 300));

    // The GET status endpoint was removed outright: it was never called, and answering 404 for an
    // unknown name versus 200 for a real one let anyone enumerate usernames.
    const gone = await GET(twoFactor, 'username=fiacsa');
    check('the account-status endpoint is gone', gone.status === 405, 'status ' + gone.status);
  }

  // ── Recovery ──
  console.log('\nResetting a lost authenticator:');
  reset();
  {
    const cb = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(cb.secret, nowStep() - 1) });

    const nope = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'fiacsa', requestingStaffPassword: PW, tfToken: ticketFor('fiacsa') });
    check('a customer cannot reset their own two-factor', nope.status === 403, 'status ' + nope.status);

    const badPw = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: 'wrong', tfToken: ticketFor('akore-rene') });
    check("a staff password must be right", badPw.status === 403, 'status ' + badPw.status);

    const ok = await POST(twoFactor, { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW, tfToken: ticketFor('akore-rene') });
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

  // ── The QR code ──
  // The risk worth testing is not "is there an image" but "does the image agree with the key printed
  // beside it". If they disagreed, someone would scan, get a working-looking entry, and then fail
  // every code forever — or worse, half the users would enroll against one secret and half another.
  console.log('\nThe setup QR:');
  reset();
  {
    const QRCode = require('qrcode');
    const res = await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW });
    const body = await res.json();

    check('enrollment returns a QR', typeof body.qrSvg === 'string' && body.qrSvg.startsWith('<svg'), String(body.qrSvg).slice(0, 60));
    check('it is a complete SVG', body.qrSvg.includes('</svg>'), 'truncated');
    check('and it draws something', /<path|<rect/.test(body.qrSvg), 'empty image');

    // The URI the app will read.
    check('the otpauth URI names the issuer', body.otpauth.includes('issuer=Akore%20Labs'), body.otpauth);
    check('carries the secret', body.otpauth.includes('secret=' + body.secret), body.otpauth);
    check('and states the algorithm, digits and period',
      /algorithm=SHA1/.test(body.otpauth) && /digits=6/.test(body.otpauth) && /period=30/.test(body.otpauth), body.otpauth);
    check('the label is the account, so the app shows who it is for', body.otpauth.includes('fiacsa'), body.otpauth);

    // The QR must encode exactly the URI built from the secret shown beside it.
    const expected = await QRCode.toString(body.otpauth, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    check('the QR encodes the same secret as the printed key', body.qrSvg === expected, 'QR and key disagree');

    // And the secret in both is the one the server is actually waiting on.
    const pending = store('hieronymus-intake-codes')['fiacsa'].members[0].totp.pendingSecret;
    check('which is the secret the server will check against', pending === body.secret, pending + ' vs ' + body.secret);

    // "Valid SVG" is not "a phone can read it". This walks the drawn path back into a module grid
    // and compares it to the matrix the encoder computed, so a rendering change that shifts, inverts
    // or truncates the image fails here instead of in a customer's camera.
    {
      const qr = QRCode.create(body.otpauth, { errorCorrectionLevel: 'M' });
      const size = qr.modules.size, margin = 1;
      const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(body.qrSvg);
      check('the image leaves a quiet zone around the code',
        vb && Number(vb[1]) === size + 2 * margin, vb ? vb[1] + ' for size ' + size : 'no viewBox');

      const d = /stroke="#000000" d="([^"]+)"/.exec(body.qrSvg);
      const grid = Array.from({ length: size }, () => new Uint8Array(size));
      let x = 0, y = 0;
      for (const tk of (d ? d[1].match(/[MmHhVvLl][^MmHhVvLl]*/g) || [] : [])) {
        const nums = (tk.slice(1).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        if (tk[0] === 'M') { x = nums[0]; y = nums[1]; }
        else if (tk[0] === 'm') { x += nums[0]; y += nums[1]; }
        else if (tk[0] === 'h' || tk[0] === 'H') {
          const n = tk[0] === 'h' ? nums[0] : nums[0] - x;
          const r = Math.floor(y) - margin;
          for (let i = 0; i < Math.abs(n); i++) {
            const c = Math.floor(x) + (n > 0 ? i : -i) - margin;
            if (r >= 0 && r < size && c >= 0 && c < size) grid[r][c] = 1;
          }
          x += n;
        }
      }
      let diff = 0;
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if ((qr.modules.data[r * size + c] ? 1 : 0) !== grid[r][c]) diff++;
      }
      check('every module in the image matches the encoded matrix', diff === 0, diff + ' modules wrong');
    }

    // Scanning it and entering the resulting code must complete enrollment.
    const code = codeAt(body.secret, nowStep());
    const done = await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code });
    check('a code from that secret completes setup', done.status === 200, 'status ' + done.status);

    // A QR is no help on a desktop password manager or without a camera, so the key stays.
    const setup = fs.readFileSync('js/two-factor-setup.js', 'utf8');
    check('the dialog still offers the key by hand', setup.includes('manualToggle') && setup.includes('tfa-secret'), 'fallback gone');
    check('and opens that fallback if the QR is missing', /qrBox\.remove\(\)[\s\S]{0,200}manual\.open = true/.test(setup), 'no fallback path');
    check('the QR is never fetched from a third party',
      !/qrserver|chart\.googleapis|api\.qrcode|https?:\/\/[^"'\s]*qr/i.test(setup), 'external QR reference');
    check('it is placed on a white plate so it scans in dark mode', setup.includes(".tfa-qr{") && setup.includes('background:#fff'), 'no plate');
    check('both languages describe scanning', /step2:\s*\{ en: '2\. Scan[\s\S]{0,120}es: '2\. Escanea/.test(setup), 'copy not bilingual');
  }

  // ── Findings from the line-by-line audit ──
  console.log('\nA stolen password must not be able to replace the authenticator:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(b.secret, nowStep() - 1) });

    // The attack: password only, enroll a new phone, own the account.
    const takeover = await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW });
    const tbody = await takeover.json();
    check('re-enrolling with the password alone is refused', takeover.status === 403, 'status ' + takeover.status);
    check('and it says a current code is needed', tbody.needsCurrentCode === true, JSON.stringify(tbody));
    check('no new pending secret was issued', !tbody.secret, JSON.stringify(tbody));
    check("the original authenticator still works",
      (await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=' + codeAt(b.secret, nowStep()))).status === 200, 'locked out');

    // The legitimate case — switching phones — works with a code from the current authenticator.
    const legit = await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW, currentCode: codeAt(b.secret, nowStep() + 1) });
    check('switching phones works with a current code', legit.status === 200 && !!(await legit.json()).secret, 'status ' + legit.status);
  }

  console.log('\nCodes must move forward, never repeat or go back:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    const q = c => 'username=fiacsa&password=' + encodeURIComponent(PW) + '&code=' + c;

    // Enrollment consumed step-1. The ±1 window still offers step-1 as valid, so an earlier step
    // must be refused outright, not just the exact one used last.
    const earlier = await GET(intakeCodes, q(codeAt(b.secret, nowStep() - 1)));
    check('the code just used at enrollment is refused', earlier.status === 403, 'status ' + earlier.status);
    const current = await GET(intakeCodes, q(codeAt(b.secret, nowStep())));
    check('the current code works', current.status === 200, 'status ' + current.status);
    const back = await GET(intakeCodes, q(codeAt(b.secret, nowStep() - 1)));
    check('and stepping backwards afterwards is refused', back.status === 403, 'status ' + back.status);
  }

  console.log('\nThe internal directory and account names:');
  reset();
  {
    const open = await GET(staffUsers, '');
    check('listing staff accounts requires credentials', open.status === 403, 'status ' + open.status);
    const body = await open.json();
    check('the refusal leaks no usernames', !JSON.stringify(body).includes('akore-rene'), JSON.stringify(body));

    const probe = await GET(staffUsers, 'bootstrap=1');
    const pbody = await probe.json();
    check('the bootstrap probe answers one boolean', probe.status === 200 && pbody.empty === false && Object.keys(pbody).length === 1, JSON.stringify(pbody));

    const asStaff = await GET(staffUsers, 'staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW)
      + '&tfToken=' + ticketFor('akore-rene'));
    check('staff can still list accounts', asStaff.status === 200 && (await asStaff.json()).items.length === 1, 'status ' + asStaff.status);

    // The status endpoint that answered 404-vs-200 for any name is gone.
    const enumr = await GET(twoFactor, 'username=akore-rene');
    check('there is no unauthenticated account-status endpoint', enumr.status === 405, 'status ' + enumr.status);
  }

  console.log('\nThrottle and replay state survive being saved:');
  reset();
  {
    // The login endpoint used to save under slugify(company) rather than the key the record was read
    // from. This record's key and its company name deliberately disagree.
    STORES['hieronymus-intake-codes']['legacy-key'] = {
      company: 'Renamed Co. S.A.', submittedAt: null,
      members: [{ username: 'renamed-user', role: 'full', passwordHash: scrypt(PW) }]
    };
    const b = await (await POST(twoFactor, { action: 'begin', username: 'renamed-user', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'renamed-user', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    const keysBefore = Object.keys(STORES['hieronymus-intake-codes']).length;
    await GET(intakeCodes, 'username=renamed-user&password=' + encodeURIComponent(PW) + '&code=' + codeAt(b.secret, nowStep()));
    check('no shadow record is created', Object.keys(STORES['hieronymus-intake-codes']).length === keysBefore,
      Object.keys(STORES['hieronymus-intake-codes']).join(', '));
    check('the replay guard was actually persisted',
      typeof STORES['hieronymus-intake-codes']['legacy-key'].members[0].totp.lastStep === 'number', 'lastStep missing');
    const replay = await GET(intakeCodes, 'username=renamed-user&password=' + encodeURIComponent(PW) + '&code=' + codeAt(b.secret, nowStep()));
    check('so a replayed code is refused', replay.status === 403, 'status ' + replay.status);
  }

  console.log('\nThe forced sign-out when the browser refuses to remember it:');
  {
    const src = fs.readFileSync('js/auth-epoch.js', 'utf8');
    let sess = { geo_portal_username: 'fiacsa', geo_portal_password: 'pw', geo_2fa_token: 'T' };
    // Reads allowed, writes throw — private windows and storage-blocked settings behave this way.
    const ctx = {
      localStorage: { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} },
      sessionStorage: { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => { sess[k] = v; }, removeItem: k => { delete sess[k]; } },
      console
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    check('the first load signs them out', !sess.geo_portal_password, JSON.stringify(sess));
    sess.geo_portal_username = 'fiacsa'; sess.geo_portal_password = 'pw'; sess.geo_2fa_token = 'T2';
    vm.runInContext(src, ctx);
    check('a second load does NOT wipe the new session again', sess.geo_portal_password === 'pw', JSON.stringify(sess));
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

  // ── Break-glass recovery ──
  // A lost authenticator on the only admin account is a lockout with no way out: the reset needs an
  // admin who is signed in, and that admin is the one locked out. This is the way back, and it must
  // be closed unless someone with access to the hosting account deliberately opens it.
  console.log('\nRecovering the only admin account:');
  reset();
  {
    const b = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    store('hieronymus-staff-sessions')['SESS'] = { username: 'akore-rene', createdAt: new Date().toISOString(), expiresAt: '2030-01-01T00:00:00Z' };

    // Locked out for real: they cannot sign in, so they cannot use the normal reset.
    delete ENV.TWO_FACTOR_RECOVERY_SECRET;
    const noSecret = await POST(twoFactor, { action: 'reset', username: 'akore-rene', recoverySecret: 'anything-at-all-here-ok' });
    check('with no recovery secret configured, this path does not exist', noSecret.status === 401 || noSecret.status === 403, 'status ' + noSecret.status);
    check('the authenticator is untouched', !!store('hieronymus-staff-users')['akore-rene'].totp, 'cleared');

    // Configured, but a short secret is refused rather than treated as protection.
    ENV.TWO_FACTOR_RECOVERY_SECRET = 'too-short';
    const short = await POST(twoFactor, { action: 'reset', username: 'akore-rene', recoverySecret: 'too-short' });
    check('a secret under 24 characters is refused', short.status === 500, 'status ' + short.status);

    ENV.TWO_FACTOR_RECOVERY_SECRET = 'a-real-recovery-secret-of-sufficient-length';
    const wrong = await POST(twoFactor, { action: 'reset', username: 'akore-rene', recoverySecret: 'a-real-recovery-secret-of-WRONG-length-xxxxx' });
    check('a wrong secret is refused', wrong.status === 403, 'status ' + wrong.status);
    check('and still nothing was cleared', !!store('hieronymus-staff-users')['akore-rene'].totp, 'cleared');

    const ok = await POST(twoFactor, { action: 'reset', username: 'akore-rene', recoverySecret: ENV.TWO_FACTOR_RECOVERY_SECRET });
    const okBody = await ok.json();
    check('the right secret resets the account', ok.status === 200, 'status ' + ok.status);
    check('it says how it was reset', okBody.resetBy === 'recovery-secret', JSON.stringify(okBody));
    check('the authenticator is gone', !store('hieronymus-staff-users')['akore-rene'].totp, 'still enrolled');
    check('every session for that account is gone too',
      !Object.values(STORES['hieronymus-staff-sessions'] || {}).some(v => v.username === 'akore-rene'),
      'a session survived the reset');
    check('so the next login sends them through setup',
      (await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW))).status === 401, '');

    const after = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    check('and it is enrollment they are sent to, not a code', (await after.json()).needsEnrollment === true, '');

    // It resets one named account, not everything.
    const cb = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(cb.secret, nowStep() - 1) });
    await POST(twoFactor, { action: 'reset', username: 'akore-rene', recoverySecret: ENV.TWO_FACTOR_RECOVERY_SECRET });
    check("another account's authenticator is left alone",
      !!store('hieronymus-intake-codes')['fiacsa'].members[0].totp, 'cleared someone else too');
    delete ENV.TWO_FACTOR_RECOVERY_SECRET;
  }

  // ── The one-shot lockout recovery ──
  // akore-rene's account ended up enrolled against a secret their phone no longer had, and the only
  // admin cannot reset themselves. This clears that ONE account's dead enrollment on a correct
  // password, once, before a fixed moment — then it is spent.
  console.log('\nThe one-shot recovery for the locked-out admin:');
  reset();
  {
    // The recovery is live only on the deployed site, so this block opts in.
    ENV.NETLIFY = 'true';
    const b = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(b.secret, nowStep() - 1) });
    check('the account starts out enrolled', !!store('hieronymus-staff-users')['akore-rene'].totp.enabledAt, 'not enrolled');

    const wrong = await GET(staffUsers, 'username=akore-rene&password=not-the-password');
    check('a wrong password does not trigger it', wrong.status === 401
      && !!store('hieronymus-staff-users')['akore-rene'].totp, 'fired on a wrong password');

    const first = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    const fb = await first.json();
    check('the right password clears the dead authenticator', !store('hieronymus-staff-users')['akore-rene'].totp, 'still enrolled');
    check('and they are sent to setup, not asked for a code', fb.needsEnrollment === true, JSON.stringify(fb));

    // They enrol again, and the recovery must NOT fire a second time.
    const b2 = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(b2.secret, nowStep() - 1) });
    const again = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    // Repeatable while the window is open, deliberately. A single use is what left this account
    // stuck: the first attempt enrolled it against a secret its owner could not produce, the one use
    // was spent, and every login afterwards asked for a code with no route back to setup.
    check('it works again while the window is open', !store('hieronymus-staff-users')['akore-rene'].totp,
      'refused to clear a second time, which is how the lockout persisted');
    check('so they are sent to setup again', (await again.json()).needsEnrollment === true, 'not sent to setup');

    // It touches staff accounts only — no customer's second factor is affected by it.
    const cb = await (await POST(twoFactor, { action: 'begin', username: 'fiacsa', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'fiacsa', password: PW, code: codeAt(cb.secret, nowStep() - 1) });
    await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW));
    check('no customer is touched by it',
      !!store('hieronymus-intake-codes')['fiacsa'].members[0].totp.enabledAt, 'cleared a customer');
    check('a customer login still asks that customer for a code',
      (await (await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW))).json()).needsCode === true,
      'customer sent to setup by the staff recovery');

    // And it closes on its own.
    const src = fs.readFileSync('netlify/functions/staff-users.js', 'utf8');
    const m = /until: Date\.parse\('([^']+)'\)/.exec(src);
    check('it has a fixed expiry rather than living forever', !!m, 'no expiry');
    check('and that expiry is a real date', !!m && !Number.isNaN(Date.parse(m[1])), m ? m[1] : '');

    // It must not exist anywhere but the deployed site.
    delete ENV.NETLIFY;
    const b3 = await (await POST(twoFactor, { action: 'begin', username: 'akore-rene', password: PW })).json();
    await POST(twoFactor, { action: 'confirm', username: 'akore-rene', password: PW, code: codeAt(b3.secret, nowStep() - 1) });
    const offSite = await GET(staffUsers, 'username=akore-rene&password=' + encodeURIComponent(PW));
    check('with the hosting runtime absent it does nothing', (await offSite.json()).needsCode === true,
      'the recovery fired outside the deployed site');
  }

  // ── Nothing shows a customer a sentence in two languages ──
  console.log('\nThe setup dialog never mixes languages:');
  {
    const setup = fs.readFileSync('js/two-factor-setup.js', 'utf8');
    check("no message pastes the server's own words into a sentence",
      !/replace\('\{why\}'/.test(setup) && !/data\.error\)/.test(setup),
      "server text is still interpolated into user-facing copy");
    const keys = [...setup.matchAll(/^    (\w+):\s*\{ en: ([\s\S]*?)\},$/gm)];
    const missing = keys.filter(m => !m[2].includes('es:')).map(m => m[1]);
    check('every string has both languages', missing.length === 0, 'missing Spanish: ' + missing.join(', '));
    check('the only thing interpolated is a status number', /\{code\}/.test(setup), 'no {code} placeholder');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all assertions passed'));
  process.exit(failures ? 1 : 0);
})();
