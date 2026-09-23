// The audit loop, run for real against stubbed engines.
//
// It used to process prompts in batches of twelve with a barrier between them: nothing in the next
// batch could start until the slowest prompt in the current one finished, and `completed` was only
// written at batch boundaries. One slow call held eleven finished prompts hostage, wall-clock was
// the sum of each batch's slowest prompt rather than the average, and the progress number parked on
// a figure for minutes and then jumped by twelve.
//
// These cases assert the properties that fixes: work overlaps, one slow prompt does not block the
// rest, progress moves per prompt, and nothing is skipped.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const S = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = n => (S[n] = S[n] || {});
const load = async f => (await import(pathToFileURL(path.resolve('netlify/functions/' + f)).href)).default;

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const POST = (fn, body) => fn(new Request('https://x/api/run-audit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), {});

(async () => {
  const { createStaffSession } = await import(pathToFileURL(path.resolve('netlify/functions/lib/session.js')).href);
  const runAudit = await load('run-audit-background.js');

  // Engines answer after a delay we control, so overlap is observable.
  let inFlight = 0, peakInFlight = 0, callCount = 0;
  let slowFor = null, slowMs = 0;
  let started = [], slowEndedAt = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    const isGrade = JSON.stringify(body).includes('services_correct');
    const prompt = JSON.stringify(body);
    callCount++;
    inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
    const idx = (prompt.match(/Question number (\d+)/) || [])[1];
    if (idx !== undefined) started.push({ idx: Number(idx), at: Date.now() });
    const isSlow = slowFor && prompt.includes(slowFor);
    const delay = isSlow ? slowMs : 30;
    await new Promise(r => setTimeout(r, delay));
    if (isSlow) slowEndedAt = Date.now();
    inFlight--;
    // The grader's real schema — a short stub here produced an unparseable response, every row was
    // written as an error, and the run correctly reported itself as failed. That was the stub, not
    // the loop, and it is exactly the kind of thing a looser assertion would have hidden.
    const judgment = {
      engine: 'Claude', query_intent: 'evaluation', brand_mentioned: false, brand_cited: false,
      brands_cited_list: [], linked_to_site: false, sentiment: 'not_mentioned',
      claims_about_brand: 0, incorrect_claims: 0, ranking_note: '',
      services_correct: null, location_correct: null, contact_correct: null
    };
    const payload = isGrade
      ? { content: [{ type: 'text', text: JSON.stringify({ engines: [judgment] }) }] }
      : { content: [{ type: 'text', text: 'An answer.' }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const seed = (nPrompts) => {
    Object.keys(S).forEach(k => delete S[k]);
    const prompts = Array.from({ length: nPrompts }, (_, i) => `Question number ${i} about pumps?`);
    store('hieronymus-prompts')['acme'] = { promptsText: prompts.join('\n'), company: 'Acme' };
    store('hieronymus-intake')['acme'] = { intake: { general: { industry: 'pumps', website: 'a.test' } } };
    store('hieronymus-customer-keys')['acme'] = { claude: 'sk-test' };
  };

  const sessionFor = async () => {
    const s = await createStaffSession('tester', 'admin');
    return s;
  };

  console.log('Running 24 prompts on one engine:\n');
  seed(24);
  let session = await sessionFor();
  peakInFlight = 0; callCount = 0;
  const t0 = Date.now();
  await POST(runAudit, { company: 'Acme', engines: ['claude'], session });
  const elapsed = Date.now() - t0;
  const job = store('hieronymus-audit-jobs')['acme'];

  check('every prompt was processed', job && job.completed === 24, JSON.stringify(job && job.completed));
  check('the run is marked done', job && job.status === 'done', (job && job.status) + ' :: ' + (job && job.message));
  check('a row exists for each prompt', Object.keys(store('hieronymus-results-rows')).length === 24,
    String(Object.keys(store('hieronymus-results-rows')).length));
  check('work actually overlapped rather than running one at a time', peakInFlight > 1,
    'peak concurrent calls: ' + peakInFlight);

  console.log('\nOne prompt far slower than the rest:\n');
  seed(24);
  session = await sessionFor();
  slowFor = 'number 0 '; slowMs = 900; started = []; slowEndedAt = 0;          // one prompt takes ~90x as long
  peakInFlight = 0;
  const t1 = Date.now();
  await POST(runAudit, { company: 'Acme', engines: ['claude'], session });
  const withSlow = Date.now() - t1;
  slowFor = null;
  const job2 = store('hieronymus-audit-jobs')['acme'];

  check('the run still completes every prompt', job2 && job2.completed === 24, String(job2 && job2.completed));
  // Under the old batch barrier the slow prompt stalled its whole batch AND delayed every later
  // batch. With a pool it costs one slot, so the run should finish close to the slow call itself.
  // The discriminator. Under a barrier, no prompt at index >= CONCURRENCY can begin until the
  // whole first batch — including the straggler at index 0 — has finished. Under a pool, a worker
  // that finishes early moves straight on, so later prompts start while the straggler is still
  // running. Counting writes did not distinguish the two (progress was already written per prompt),
  // and asserting on total runtime passed under both. This is the property that differs.
  const crossedBoundary = started.filter(x => x.idx >= 12 && x.at < slowEndedAt).length;
  check('later prompts start while the slow one is still running',
    crossedBoundary > 0,
    'no prompt past index 12 began before the straggler finished — the batch barrier is still there');
  console.log('         [24 prompts, one 900ms straggler: ' + withSlow + 'ms]');
  check('and the run is not paced by the straggler repeatedly', withSlow < 900 * 3,
    'run took ' + withSlow + 'ms');

  console.log('\nProgress reporting:\n');
  seed(12);
  session = await sessionFor();

  // Count the progress writes directly. seq turned out to be a poor proxy — it climbs for reasons
  // other than progress — and an assertion that passes against the code it is meant to reject is
  // worse than no assertion. A Proxy over the job store records every write, so "once per prompt"
  // versus "once per batch of twelve" is simply a number.
  const writes = [];
  const realBucket = store('hieronymus-audit-jobs');
  S['hieronymus-audit-jobs'] = new Proxy(realBucket, {
    set(target, key, value) {
      if (key === 'acme' && value && Number.isFinite(value.completed)) writes.push(value.completed);
      target[key] = value;
      return true;
    }
  });

  await POST(runAudit, { company: 'Acme', engines: ['claude'], session });
  const jobs = store('hieronymus-audit-jobs');

  // 12 prompts under one batch wrote progress once. A pool writes as each prompt lands.
  // Not a claim about the pool — processPrompt has always written as each prompt lands. Kept so
  // that stays true, because the panel's smoothness depends on it.
  const progressWrites = writes.filter(n => n > 0 && n < 12).length;
  check('progress is written as each prompt lands',
    progressWrites >= 8, 'only ' + progressWrites + ' intermediate writes: [' + writes.join(',') + ']');
  check('every step is forward', writes.every((v, i) => i === 0 || v >= writes[i - 1]), writes.join(','));
  check('the run finished', jobs['acme'].status === 'done' && jobs['acme'].completed === 12,
    jobs['acme'].status + ' ' + jobs['acme'].completed);

  console.log('\nResuming part-way through:\n');
  seed(24);
  session = await sessionFor();
  const resumeWrites = [];
  const bucket = store('hieronymus-audit-jobs');
  S['hieronymus-audit-jobs'] = new Proxy(bucket, {
    set(target, key, value) {
      if (key === 'acme' && value && Number.isFinite(value.completed)) resumeWrites.push(value.completed);
      target[key] = value; return true;
    }
  });
  await POST(runAudit, { company: 'Acme', engines: ['claude'], session, startIndex: 18 });
  const resumed = store('hieronymus-audit-jobs')['acme'];

  // The first thing a resumed run reports must already include the work behind it. Reporting 0 for
  // the window before the first prompt lands is indistinguishable from starting over, and that is
  // what it looked like.
  check('a resumed run never reports less than it started with',
    resumeWrites.every(n => n >= 18), 'wrote ' + resumeWrites.slice(0, 4).join(',') + ' after resuming at prompt 18');
  check('it only runs the prompts that were left',
    Object.keys(store('hieronymus-results-rows')).length === 6,
    Object.keys(store('hieronymus-results-rows')).length + ' rows written for 6 remaining prompts');
  check('and finishes at the full count', resumed.completed === 24, String(resumed.completed));

  console.log('\nWhen one prompt blows up, and when a resume carries finished work:\n');
  seed(24);
  session = await sessionFor();
  // A prompt whose job-record write throws — the one path processPrompt does not guard, and the
  // one that used to take every other in-flight worker down with it through Promise.all.
  const jobBucket = store('hieronymus-audit-jobs');
  let boom = 0;
  S['hieronymus-audit-jobs'] = new Proxy(jobBucket, {
    set(target, key, value) {
      if (key === 'acme' && value && value.completed === 6 && boom++ === 0) throw new Error('blob write failed');
      target[key] = value; return true;
    }
  });
  await POST(runAudit, { company: 'Acme', engines: ['claude'], session });
  const survived = Object.keys(store('hieronymus-results-rows')).length;
  check('one prompt failing does not abort the other workers', survived >= 20,
    'only ' + survived + ' of 24 rows written after a single failed write');

  // A continuation that already has finished prompts above its resume point.
  seed(24);
  session = await sessionFor();
  const calls0 = callCount;
  await POST(runAudit, { company: 'Acme', engines: ['claude'], session,
    startIndex: 10, skip: [11, 12, 13, 14], continuation: true });
  const rows = Object.keys(store('hieronymus-results-rows')).length;
  // 24 prompts, resuming at 10, with 11-14 already done: 10, then 15..23 = 10 prompts.
  check('a resumed run skips prompts the previous invocation finished', rows === 10,
    rows + ' rows written; expected 10 (prompt 10, plus 15 through 23)');
  const resumedJob = store('hieronymus-audit-jobs')['acme'];
  check('and still reports the full count including the skipped ones',
    resumedJob.completed === 24, String(resumedJob.completed));

  globalThis.fetch = realFetch;
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
