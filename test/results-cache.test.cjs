// Reading results from a cache instead of from every row.
//
// The per-row blobs stay the source of truth — that is what stopped concurrent writers clobbering
// one another — and what is read now is derived from them. Which makes exactly one thing matter
// here, more than the speed: the derived answer has to equal the answer the rows would have given.
// A dashboard drawn from a stale cache is worse than a slow one. It is wrong, it looks right, and
// nobody can tell.
//
// So every case below compares the cached answer against the rows themselves, and every way rows
// can change is followed by a read that must see the change.
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

const row = (brand, date, prompt, engine, extra) => Object.assign({
  run_id: `${brand}-${date}-${prompt}-${engine}`, run_type: 'diagnostic', snapshot_date: date,
  engine, prompt_id: prompt, prompt_text: 'q', brand, sentiment: 'neutral', brand_cited: 1,
  answer_excerpt: 'some, text with "quotes"'
}, extra || {});

(async () => {
  const results = (await import(pathToFileURL(path.resolve('netlify/functions/results.js')).href)).default;
  const intake  = (await import(pathToFileURL(path.resolve('netlify/functions/intake.js')).href)).default;
  const cacheLib = await import(pathToFileURL(path.resolve('netlify/functions/lib/results-cache.js')).href);
  const { createStaffSession, createClientSession } = await import(pathToFileURL(
    path.resolve('netlify/functions/lib/session.js')).href);

  const seed = async () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    const S = await createStaffSession('akore-rene', 'admin');
    const rows = store('hieronymus-results-rows');
    rows['a1'] = row('Acme', '2026-09-01', 'Q01', 'Claude');
    rows['a2'] = row('Acme', '2026-09-01', 'Q02', 'ChatGPT');
    rows['a3'] = row('Acme', '2026-09-15', 'Q01', 'Claude', { run_type: 'monitoring' });
    rows['b1'] = row('Beta Co', '2026-09-02', 'Q01', 'Claude');
    store('hieronymus-intake')['acme'] = { company: 'Acme', intake: {} };
    store('hieronymus-intake')['newco'] = { company: 'NewCo', intake: {} };
    return S;
  };
  const get = (S, qs) => results(new Request(`https://x/api/results?session=${encodeURIComponent(S)}&${qs}`), {});

  console.log('The cached CSV is the CSV the rows would have produced:\n');
  {
    const S = await seed();
    const fresh = await (await get(S, 'company=Acme')).text();     // builds the cache
    const cached = await (await get(S, 'company=Acme')).text();    // reads it
    check('a second read returns exactly the same bytes', fresh === cached,
      `${fresh.length} vs ${cached.length}`);

    // Built independently from the rows, to catch the cache agreeing with itself.
    const expected = cacheLib.CSV_HEADER + [store('hieronymus-results-rows').a1,
      store('hieronymus-results-rows').a2, store('hieronymus-results-rows').a3]
      .sort((x, y) => x.snapshot_date.localeCompare(y.snapshot_date) || x.prompt_id.localeCompare(y.prompt_id))
      .map(cacheLib.rowToCsvLine).join('');
    check('and it matches the rows themselves', cached === expected,
      JSON.stringify(cached.slice(0, 120)) + ' vs ' + JSON.stringify(expected.slice(0, 120)));

    check('every one of that customer\'s rows is in it',
      (cached.match(/\n/g) || []).length === 4, String((cached.match(/\n/g) || []).length));
    check('and no other customer\'s row is', cached.indexOf('Beta Co') === -1, 'another customer leaked in');

    // A field containing a comma and quotes is where a hand-rolled CSV usually breaks.
    check('awkward values survive the round trip', cached.indexOf('"some, text with ""quotes"""') !== -1,
      'escaping is wrong');
  }

  console.log('\nA customer with no rows:\n');
  {
    const S = await seed();
    const csv = await (await get(S, 'company=NewCo')).text();
    check('gets the header and nothing else', csv === cacheLib.CSV_HEADER, JSON.stringify(csv));
  }

  console.log('\nEvery way rows change, the next read sees it:\n');
  {
    const S = await seed();
    await get(S, 'company=Acme');                        // warm

    // Written straight to the store, the way the audit writes them, then the cache dropped the way
    // the run drops it. This is the path that matters: a run ends, someone opens the dashboard.
    store('hieronymus-results-rows')['a4'] = row('Acme', '2026-09-20', 'Q09', 'Claude');
    await cacheLib.invalidateResultsCache();
    const after = await (await get(S, 'company=Acme')).text();
    check('a row the audit wrote appears', after.indexOf('Q09') !== -1, 'the new row is missing');

    // The staff import path drops it for itself.
    await results(new Request('https://x/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: S, run_id: 'imported-1', brand: 'Acme', snapshot_date: '2026-09-21',
                             engine: 'Gemini', prompt_id: 'Q77', sentiment: 'neutral' })
    }), {});
    const afterPost = await (await get(S, 'company=Acme')).text();
    check('an imported row appears without anyone clearing a cache',
      afterPost.indexOf('Q77') !== -1, 'the import is invisible');

    // And clearing really clears.
    await results(new Request(
      `https://x/api/results?session=${encodeURIComponent(S)}&company=Acme`, { method: 'DELETE' }), {});
    const afterDelete = await (await get(S, 'company=Acme')).text();
    check('cleared results really are gone', afterDelete === cacheLib.CSV_HEADER,
      JSON.stringify(afterDelete.slice(0, 80)));
    const betaStill = await (await get(S, 'company=Beta Co')).text();
    check('and clearing one customer leaves the other alone',
      betaStill.indexOf('Beta Co') !== -1, 'the other customer was wiped too');
  }

  console.log('\nThe summary the portal reads:\n');
  {
    const S = await seed();
    const body = await (await get(S, 'summary=1')).json();
    const acme = body.companies.acme;
    check('it names the customer', acme && acme.company === 'Acme', JSON.stringify(acme));
    check('counts their rows', acme.rows === 3, String(acme.rows));
    check('lists the dates they have run on', JSON.stringify(acme.dates) === '["2026-09-01","2026-09-15"]',
      JSON.stringify(acme.dates));
    check('knows the most recent', acme.lastRun === '2026-09-15', acme.lastRun);
    check('and tells diagnosis from monitoring',
      acme.hasDiagnostic === true && acme.hasMonitoring === true,
      JSON.stringify([acme.hasDiagnostic, acme.hasMonitoring]));
    check('it carries no row content, only counts',
      JSON.stringify(body).indexOf('answer_excerpt') === -1, 'the summary is shipping rows');
  }

  console.log('\nScoping still holds — a cache is not a way around it:\n');
  {
    const S = await seed();
    const cust = await createClientSession('acme-user', 'Acme');
    const rival = await createClientSession('beta-user', 'Beta Co');

    const own = await results(new Request(`https://x/api/results?session=${encodeURIComponent(cust)}&company=Acme`), {});
    check('a customer reads their own results', own.status === 200, String(own.status));
    const theirs = await results(new Request(`https://x/api/results?session=${encodeURIComponent(rival)}&company=Acme`), {});
    check("and not another customer's", theirs.status === 403, String(theirs.status));
    const none = await results(new Request('https://x/api/results?company=Acme'), {});
    check('an unauthenticated read is refused', none.status === 401, String(none.status));

    const listing = await results(new Request(`https://x/api/results?session=${encodeURIComponent(cust)}`), {});
    check('and a customer cannot ask for everything', listing.status === 403, String(listing.status));
    const summaryAsCustomer = await results(new Request(
      `https://x/api/results?session=${encodeURIComponent(cust)}&summary=1`), {});
    check('nor for the summary of everyone', summaryAsCustomer.status === 403, String(summaryAsCustomer.status));
  }

  console.log('\nWhat it costs, which is the point:\n');
  {
    const S = await seed();
    // A platform that has accumulated some history.
    for (let i = 0; i < 2000; i++) {
      store('hieronymus-results-rows')['bulk' + i] = row(i % 2 ? 'Acme' : 'Beta Co', '2026-09-01', 'Q' + i, 'Claude');
    }
    await cacheLib.invalidateResultsCache();
    await get(S, 'summary=1');                    // one rebuild, as after a run

    resetOps();
    await get(S, 'company=Acme');
    const read = ops().get + ops().list;
    check('a customer page reads results in a couple of operations, not two thousand',
      read <= 4, String(read) + ' ops');

    resetOps();
    await get(S, 'summary=1');
    const summary = ops().get + ops().list;
    check('the portal summary is one read', summary <= 2, String(summary) + ' ops');

    resetOps();
    await intake(new Request(`https://x/api/intake?company=NewCo&session=${encodeURIComponent(S)}`), {});
    const lock = ops().get + ops().list;
    check('the intake lock no longer walks every row one at a time', lock <= 6, String(lock) + ' ops');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
