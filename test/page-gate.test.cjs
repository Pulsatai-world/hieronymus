// What actually decides whether an internal page lets you in.
//
// This is the bug that kept reaching the user as "I logged in with no code". Two-factor was enforced
// at the login endpoints, but the pages never asked those endpoints anything:
//
//     function checkAuth() { return localStorage.getItem(SESSION_KEY) === 'true'; }
//
// A bare string that never expired and was never verified. One sign-in opened the Portal forever —
// no password, no code — and no amount of work on the endpoints could change that, because the page
// was not consulting them. Being signed in now means holding a session the server still recognises,
// and a session is only ever minted after a password AND a code.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});
const getStore = name => ({
  get: async (k, o) => (k in store(name) ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k]) : null),
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

function load(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  const libs = [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')
      .replace(/^import .*?;$/gm, '').replace(/^export (function|const|async function) /gm, '$1 ')).join('\n');
  const src = libs + '\n' + raw.replace(/^import .*?;$/gm, '').replace(/^export default /m, 'EXPORTS.handler = ');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, console, EXPORTS: {}, QRCode: require('qrcode') };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  return ctx.EXPORTS.handler;
}
const HANDLERS = { '/api/staff-session': load('staff-session.js'), '/api/staff-users': load('staff-users.js') };

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
const PW = 'staff-password';

// Loads a real internal page's gate logic and reports whether it let the visitor in.
function openPage(file, storage) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  vc.on('error', () => {});
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://test.local/' + file, runScripts: 'outside-only', virtualConsole: vc
  });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);

  w.fetch = async (url, init) => {
    const path = String(url).split('?')[0];
    if (!HANDLERS[path]) return new Response('Not Found', { status: 404 });
    return await HANDLERS[path](new Request('https://test.local' + url, init || {}), {});
  };
  vm.runInContext(fs.readFileSync('js/results-auth.js', 'utf8'), dom.getInternalVMContext(), { filename: 'results-auth.js' });

  // The page's own gate logic, lifted from the file: its keys, its checkAuth, its entry condition.
  const src = fs.readFileSync(file, 'utf8');
  const keys = src.match(/const SESSION_KEY = [^\n]+\n(?:const \w+_KEY = [^\n]+\n)*/)[0];
  const checkAuth = src.match(/function checkAuth\(\) \{[\s\S]*?\n\}/)[0];
  let gateShown = false;
  w.__showGate = () => { gateShown = true; };
  // Brace-matched, not regex-trimmed: the entry block has an `else` arm, and a non-greedy match
  // stopped at the first "\n}" and silently dropped it — so this suite ran only half the gate and
  // reported failures that were its own. Take the whole statement or take nothing.
  const at = src.indexOf('if (!checkAuth())');
  if (at < 0) throw new Error('no gate entry found in ' + file);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // Keep going while an `else` follows, so both arms come along.
  while (/^\s*else\b/.test(src.slice(end))) {
    depth = 0;
    for (let i = src.indexOf('{', end); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
  }
  const entry = src.slice(at, end).replace(/showPasswordGate/g, 'window.__showGate');
  if (!/requireStaffSession/.test(entry)) throw new Error('gate entry in ' + file + ' never validates the session');
  vm.runInContext(keys + checkAuth + '\n' + entry, dom.getInternalVMContext(), { filename: file + '#gate' });
  return { w, letIn: () => !gateShown };
}

(async () => {
  const reset = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-staff-users')['akore-rene'] = {
      username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW),
      totp: { secret: 'JBSWY3DPEHPK3PXP', enabledAt: '2026-08-29T15:00:00Z' }
    };
  };
  const liveSession = () => {
    store('hieronymus-staff-sessions')['LIVE'] = {
      username: 'akore-rene',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
    };
    return 'LIVE';
  };
  const settle = () => new Promise(r => setTimeout(r, 60));

  for (const page of ['portal.html', 'index.html', 'intake-view.html']) {
    console.log('\n' + page + ':');

    // THE BUG: the flag on its own.
    reset();
    {
      const { letIn } = openPage(page, { hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene' });
      await settle();
      check('the flag alone does NOT let anyone in', !letIn(), 'WALKED STRAIGHT IN with no session');
    }

    // A token the server has never heard of — a stale one, or an invented one.
    reset();
    {
      const { letIn } = openPage(page, {
        hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene',
        hieronymus_staff_token: 'MADE-UP'
      });
      await settle();
      check('an unrecognised session is refused', !letIn(), 'let in on a token the server never issued');
    }

    // A session that has run out.
    reset();
    {
      // Created recently (so the deploy cutoff is not what refuses it) but already run out, which
      // isolates the expiry check. A hardcoded date here was still in the future when the suite ran.
      store('hieronymus-staff-sessions')['OLD'] = {
        username: 'akore-rene',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString()
      };
      const { w, letIn } = openPage(page, {
        hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene', hieronymus_staff_token: 'OLD'
      });
      await settle();
      check('an expired session is refused', !letIn(), 'let in on an expired session');
      check('and the stale flags are cleared', !w.localStorage.getItem('hieronymus_internal_auth'), 'flag left behind');
    }

    // A session minted before two-factor existed.
    reset();
    {
      store('hieronymus-staff-sessions')['PRE'] = {
        username: 'akore-rene', createdAt: '2026-08-01T00:00:00Z',
        expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
      };
      const { letIn } = openPage(page, {
        hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene', hieronymus_staff_token: 'PRE'
      });
      await settle();
      check('a session from before two-factor is refused', !letIn(), 'let in on a pre-two-factor session');
    }

    // An account whose authenticator was reset must set one up again, not ride its old session.
    reset();
    {
      delete store('hieronymus-staff-users')['akore-rene'].totp;
      const tok = liveSession();
      const { letIn } = openPage(page, {
        hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene', hieronymus_staff_token: tok
      });
      await settle();
      check('an account with no authenticator is refused', !letIn(), 'rode an old session past enrollment');
    }

    // And the legitimate case: a real, live session must not be disturbed.
    reset();
    {
      const tok = liveSession();
      const { w, letIn } = openPage(page, {
        hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene', hieronymus_staff_token: tok
      });
      await settle();
      check('a live session is let straight through', letIn(), 'gate shown to a signed-in user');
      check('and the role comes from the server, not the browser',
        w.localStorage.getItem('hieronymus_internal_role') === 'admin',
        w.localStorage.getItem('hieronymus_internal_role'));
    }
  }

  console.log('\nThe staff bypass on the client-facing pages:');
  for (const f of ['client-portal.html', 'intake.html', 'prompt-review.html']) {
    const src = fs.readFileSync(f, 'utf8');
    const i = src.indexOf("localStorage.getItem('hieronymus_internal_auth') === 'true'");
    check(f + ' also requires a real session, not just the flag',
      i > -1 && src.slice(i, i + 200).includes("localStorage.getItem('hieronymus_staff_token')"),
      'bypasses on the flag alone');
  }

  console.log('\nA session is short enough that the code means something:');
  {
    const src = fs.readFileSync('netlify/functions/staff-session.js', 'utf8');
    const m = /const SESSION_HOURS = (\d+);/.exec(src);
    check('sessions are measured in hours, not days', !!m, 'still SESSION_DAYS');
    check('and last no more than a day', m && Number(m[1]) <= 24, m ? m[1] + 'h' : '?');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
