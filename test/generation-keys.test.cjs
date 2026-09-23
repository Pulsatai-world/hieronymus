// Which key prompt generation spends.
//
// Every engine call in this platform is billed to the customer it is for. Generation was the one
// exception: it ran on a single platform-wide ANTHROPIC_API_KEY, so one customer's generation spent
// against a pool shared with everyone else, and a customer whose own keys were set correctly could
// still be told an API key was invalid — with no key on their record that changing would fix.
//
// These assert the segmentation itself, not the wording: the customer's key is the one that goes
// out, a missing one is refused before any spend, and there is no fallback to an environment
// variable for a customer who has not configured one.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = name => (STORES[name] = STORES[name] || {});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

const crypto = require('crypto');
const POST = (fn, body) => fn(new Request('https://x/api/generate-prompts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), {});

// Generation is staff-only now, so every call here carries a real staff session — the same thing
// the customer page sends. A run with no session is covered in login-attacks.test.cjs.
async function staffSession() {
  const { createStaffSession } = await import(pathToFileURL(
    path.resolve('netlify/functions/lib/session.js')).href);
  return await createStaffSession('akore-rene', 'admin');
}

(async () => {
  const generate = (await import(pathToFileURL(
    path.resolve('netlify/functions/generate-prompts-background.js')).href)).default;

  const realFetch = globalThis.fetch;
  let sentKeys = [];
  // Every Claude call answers with something shaped enough to get past the brief stage; what the
  // suite reads is the header that went out, not the pipeline's output.
  globalThis.fetch = async (url, init) => {
    sentKeys.push((init && init.headers && init.headers['x-api-key']) || null);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const SESSION = await staffSession();

  const seed = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-intake')['acme'] = { intake: { company: 'Acme', whatTheySell: 'pumps' } };
    // The wipe takes the session store with it; put the caller's session back.
    store('hieronymus-staff-sessions')[SESSION] = {
      kind: 'staff', username: 'akore-rene', role: 'admin',
      createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()
    };
  };

  console.log('Which key generation spends:');

  // ── The customer's own key is the one that goes out ──
  seed();
  store('hieronymus-customer-keys')['acme'] = { company: 'Acme', claude: 'sk-ant-CUSTOMER-acme' };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-PLATFORM-shared';
  sentKeys = [];
  await POST(generate, { company: 'Acme', count: 5, languages: ['English'], session: SESSION });
  check("the customer's own Claude key is what is sent",
    sentKeys.length > 0 && sentKeys.every(k => k === 'sk-ant-CUSTOMER-acme'),
    JSON.stringify(sentKeys.slice(0, 3)));
  check('the platform-wide key is never reached for',
    !sentKeys.includes('sk-ant-PLATFORM-shared'), 'a shared key was spent');

  // ── Two customers, two keys ──
  seed();
  store('hieronymus-customer-keys')['acme'] = { company: 'Acme', claude: 'sk-ant-CUSTOMER-acme' };
  store('hieronymus-intake')['globex'] = { intake: { company: 'Globex' } };
  store('hieronymus-customer-keys')['globex'] = { company: 'Globex', claude: 'sk-ant-CUSTOMER-globex' };
  sentKeys = [];
  await POST(generate, { company: 'Globex', count: 5, languages: ['English'], session: SESSION });
  check('a second customer bills their own key, not the first one\'s',
    sentKeys.length > 0 && sentKeys.every(k => k === 'sk-ant-CUSTOMER-globex'),
    JSON.stringify(sentKeys.slice(0, 3)));

  // ── No key configured: refused before anything is spent ──
  seed();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-PLATFORM-shared';
  sentKeys = [];
  await POST(generate, { company: 'Acme', count: 5, languages: ['English'], session: SESSION });
  check('a customer with no key spends nothing at all', sentKeys.length === 0,
    'it called out ' + sentKeys.length + ' times');
  const job = store('hieronymus-generate-jobs')['acme'];
  check('and the job says so, naming the customer',
    job && job.status === 'error' && /Acme/.test(job.message || ''), JSON.stringify(job));
  check('rather than falling back to a shared key',
    job && !/ANTHROPIC_API_KEY/.test(job.message || ''), JSON.stringify(job && job.message));

  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = realFetch;
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
