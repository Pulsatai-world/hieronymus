// POST /api/customer-keys answered anyone who named a company. It sets the engine API keys a
// customer's audit runs are billed against, so an unauthenticated write meant a stranger could swap
// in their own key, redirect a customer's runs at it, or blank an engine out until runs failed.
// Read scoping was fixed here long ago; this is the write side of the same endpoint.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});
const getStore = name => ({
  get: async (k, o) => (k in store(name) ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k]) : null),
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

function load(file) {
  // Sibling ./lib modules are inlined ahead of the handler, the way Netlify's bundler follows the
  // import — the endpoint now calls into the shared two-factor gate.
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  const libs = [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')
      .replace(/^import .*?;$/gm, '')
      .replace(/^export (function|const|async function) /gm, '$1 ')).join('\n');
  const src = libs + '\n' + raw
    .replace(/^import .*?;$/gm, '')
    .replace(/^export default /m, 'EXPORTS.handler = ');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, console, EXPORTS: {} };
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

const PW = 'staff-pass';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}

(async () => {
  const keys = load('customer-keys.js');
  store('hieronymus-staff-users')['akore-rene'] = { username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW) };
  store('hieronymus-customer-keys')['fiacsa'] = { company: 'FIACSA', claude: 'sk-real-key' };
  // A live two-factor ticket, as a real staff login issues. Writes now require it beside the password.
  store('hieronymus-2fa-sessions')['staff-ticket'] = {
    username: 'akore-rene', expiresAt: new Date(Date.now() + 11 * 3600 * 1000).toISOString()
  };

  const POST = body => keys(new Request('https://x/api/customer-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }));

  console.log('Writing a customer\'s engine API keys:');
  const anon = await POST({ company: 'FIACSA', claude: 'sk-attacker-key' });
  check('an unauthenticated write is refused', anon.status === 403, 'status ' + anon.status);
  check('the real key is untouched', store('hieronymus-customer-keys')['fiacsa'].claude === 'sk-real-key',
    store('hieronymus-customer-keys')['fiacsa'].claude);

  const badPw = await POST({ company: 'FIACSA', claude: 'x', staffUsername: 'akore-rene', staffPassword: 'wrong', tfToken: 'staff-ticket' });
  check('a wrong staff password is refused', badPw.status === 403, 'status ' + badPw.status);

  const nulled = await POST({ company: 'FIACSA', claude: null });
  check('an unauthenticated key-clearing is refused too', nulled.status === 403, 'status ' + nulled.status);
  check('the key survives that as well', !!store('hieronymus-customer-keys')['fiacsa'].claude, 'cleared');

  const ok = await POST({ company: 'FIACSA', claude: 'sk-new-key', staffUsername: 'akore-rene', staffPassword: PW, tfToken: 'staff-ticket' });
  check('staff can still set a key', ok.status === 200, 'status ' + ok.status);
  check('the new key was stored', store('hieronymus-customer-keys')['fiacsa'].claude === 'sk-new-key',
    store('hieronymus-customer-keys')['fiacsa'].claude);

  const body = await ok.json();
  check('the response never echoes a raw key', !JSON.stringify(body).includes('sk-new-key'), JSON.stringify(body));

  // A signed-in staff session presents a token instead of a password.
  store('hieronymus-staff-sessions')['TOK'] = { username: 'akore-rene', createdAt: new Date().toISOString(), expiresAt: '2030-01-01T00:00:00Z' };
  const tok = await POST({ company: 'FIACSA', gemini: 'g-key', staffToken: 'TOK' });
  check('a session token is accepted', tok.status === 200, 'status ' + tok.status);

  // Both Portal call sites must actually send credentials, or the guard just breaks the feature.
  const portal = fs.readFileSync('portal.html', 'utf8');
  const writes = [...portal.matchAll(/fetch\(([^,]*?'\/api\/customer-keys'[^,]*?|await window\.apiQuery\('\/api\/customer-keys'[^)]*\)),\s*\{\s*\n?\s*method: 'POST'/g)];
  check('both Portal key writes go through apiQuery', writes.length === 2 && writes.every(m => m[1].includes('apiQuery')),
    writes.map(m => m[1]).join(' | '));

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
