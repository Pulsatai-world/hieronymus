// Opening the front page costs the same whether there is one customer or any number of them.
//
// It did not. The portal fetched three things — the customer records, every prompt set on the
// platform, and a summary of every customer's audit history — and every one of them is a listing
// followed by one read per blob. Two of the three existed only to render two badges per row:
// "approved on <date>" and "N runs". So the front page read the entire platform to draw a list you
// were about to click one row of, and got slower with every customer and every audit, for ever.
//
// What is asserted here is the shape, not a time: the number of store operations must not grow
// with the number of customers. A threshold ("fast enough up to N") is the same bug with a number
// written on it — it still degrades, it just waits longer to start.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = n => (STORES[n] = STORES[n] || {});
const ops = () => globalThis.__BLOB_OPS__ || { get: 0, set: 0, list: 0, delete: 0 };
const resetOps = () => { const o = globalThis.__BLOB_OPS__; if (o) { o.get = 0; o.set = 0; o.list = 0; o.delete = 0; } };

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

(async () => {
  const codes = (await import(pathToFileURL(path.resolve('netlify/functions/intake-codes.js')).href)).default;
  const prompts = (await import(pathToFileURL(path.resolve('netlify/functions/prompts.js')).href)).default;
  const cache = await import(pathToFileURL(path.resolve('netlify/functions/lib/results-cache.js')).href);
  const { createStaffSession } = await import(pathToFileURL(path.resolve('netlify/functions/lib/session.js')).href);

  async function platform(customers, rows) {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    const S = await createStaffSession('akore-rene', 'admin');
    for (let i = 0; i < customers; i++) {
      // Keyed the way the endpoint keys them — slugified from the company name. Seeding 'co1' for
      // "Co 1" made every write 404 with "Unknown company", so the fixture, not the code, was what
      // the first version of this test was measuring.
      const slug = 'co-' + i;
      store('hieronymus-intake-codes')[slug] = {
        company: 'Co ' + i, members: [{ username: slug, role: 'full' }], createdAt: '2026-01-01' };
      store('hieronymus-prompts')[slug] = { company: 'Co ' + i, promptsText: 'a', approvedAt: '2026-09-01' };
    }
    for (let i = 0; i < rows; i++) {
      store('hieronymus-results-rows')['r' + i] = { brand: 'Co ' + (i % customers),
        snapshot_date: '2026-09-0' + ((i % 9) + 1), engine: 'Claude', prompt_id: 'Q1', run_type: 'diagnostic' };
    }
    return S;
  }
  const open = (S) => codes(new Request(
    `https://x/api/intake-codes?session=${encodeURIComponent(S)}&directory=1`), {});

  console.log('The front page, by size of platform:\n');
  const costs = {};
  for (const n of [1, 40, 400, 2000]) {
    const S = await platform(n, 500);
    await open(S);                      // the one build
    resetOps();
    await open(S);
    costs[n] = ops().get + ops().list;
    check(`${String(n).padStart(4)} customers: ${costs[n]} operations`, costs[n] <= 4, String(costs[n]));
  }
  check('and the cost does not grow with the number of customers',
    costs[1] === costs[2000], `${costs[1]} at one customer, ${costs[2000]} at two thousand`);

  console.log('\nNor after the things that change what it shows:\n');
  {
    const S = await platform(400, 500);
    await open(S);

    // A customer is edited. The directory used to be discarded here, which handed the rebuild —
    // every customer record on the platform — to whoever opened the portal next.
    await codes(new Request('https://x/api/intake-codes', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: S, company: 'Co 7', monitoringEnabled: true, monitoringCadence: 'monthly' })
    }), {});
    resetOps(); await open(S);
    const afterEdit = ops().get + ops().list;
    check('after a customer is edited', afterEdit <= 4, String(afterEdit) + ' ops');

    // And the edit itself is bounded too: it rewrites one entry, not the list.
    resetOps();
    await codes(new Request('https://x/api/intake-codes', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: S, company: 'Co 8', monitoringEnabled: true, monitoringCadence: 'monthly' })
    }), {});
    const editCost = ops().get + ops().list;
    check('and editing a customer does not read every other one', editCost <= 8, String(editCost) + ' ops');

    // Prompts approved.
    await prompts(new Request('https://x/api/prompts', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: S, company: 'Co 9', internalApprove: true })
    }), {});
    resetOps(); await open(S);
    const afterPrompts = ops().get + ops().list;
    check('after prompts are approved', afterPrompts <= 4, String(afterPrompts) + ' ops');

    // A run finishes.
    await cache.rebuildResultsCache();
    resetOps(); await open(S);
    const afterRun = ops().get + ops().list;
    check('after an audit finishes', afterRun <= 4, String(afterRun) + ' ops');
  }

  console.log('\nAnd it still says the true thing:\n');
  {
    const S = await platform(3, 60);
    await cache.rebuildResultsCache();
    const body = await (await open(S)).json();
    check('every customer is listed', body.items.length === 3, String(body.items.length));

    const one = body.items.find(i => i.company === 'Co 1');
    check('with the badge for their prompts', one.promptsApprovedAt === '2026-09-01', String(one.promptsApprovedAt));
    check('and the badge for their runs', one.runCount > 0, String(one.runCount));

    // Changing something must actually show, or a fast list is just a wrong one.
    await codes(new Request('https://x/api/intake-codes', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: S, company: 'Co 1', monitoringEnabled: true, monitoringCadence: 'monthly' })
    }), {});
    const after = await (await open(S)).json();
    check('an edit is visible on the very next load',
      after.items.find(i => i.company === 'Co 1').monitoringEnabled === true,
      JSON.stringify(after.items.find(i => i.company === 'Co 1').monitoringEnabled));
    check('and it did not lose the badges while doing it',
      after.items.find(i => i.company === 'Co 1').runCount > 0,
      String(after.items.find(i => i.company === 'Co 1').runCount));
    check('nor the other customers', after.items.length === 3, String(after.items.length));
  }

  console.log('\nIt is staff-only, like the listing it replaces:\n');
  {
    const S = await platform(2, 10);
    const { createClientSession } = await import(pathToFileURL(path.resolve('netlify/functions/lib/session.js')).href);
    const cust = await createClientSession('co-0', 'Co 0');
    const asCustomer = await codes(new Request(
      `https://x/api/intake-codes?session=${encodeURIComponent(cust)}&directory=1`), {});
    check('a customer cannot read the directory', asCustomer.status === 403, String(asCustomer.status));
    const anon = await codes(new Request('https://x/api/intake-codes?directory=1'), {});
    check('nor can anyone without a session', anon.status === 401, String(anon.status));
    const staff = await open(S);
    check('staff can', staff.status === 200, String(staff.status));
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
