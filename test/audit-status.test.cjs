// What the audit panel decides, fed the kind of responses production actually returns.
//
// The panel flapped between "running", "no progress" and "hasn't started" during a single run. Not
// because any one branch was wrong, but because it re-decided everything from each response in
// isolation, and Netlify Blobs hands back stale and field-dropped reads as a matter of course.
// These cases are that sequence, replayed.
const { classify } = require('../js/audit-status.js');

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const T0 = Date.parse('2026-09-23T12:00:00Z');
const at = mins => T0 + mins * 60000;
const beat = mins => new Date(at(mins)).toISOString();

console.log('Reading a run that is genuinely in progress:\n');
{
  let view = {};
  const r1 = classify({ seq: 5, status: 'running', total: 180, completed: 36, engineCount: 3,
    promptsTotal: 60, startedAt: beat(0), lastProgressAt: beat(1) }, view, { now: at(2) });
  view = r1.view;
  check('it is running', r1.state === 'running', r1.state);
  check('progress is counted in PROMPTS, not rows', r1.promptsDone === 12 && r1.promptsTotal === 60,
    r1.promptsDone + '/' + r1.promptsTotal);
  check('and the bar matches the prompts', r1.pct === 20, r1.pct + '%');
  check('rows are still available underneath', r1.completed === 36 && r1.total === 180, '');

  // The exact read that used to repaint a healthy run as dead: Blobs drops fields.
  const r2 = classify({ seq: 6 }, view, { now: at(2) });
  check('a read with no status and no shape is ignored, not rendered',
    r2.action === 'ignore' && r2.reason === 'partial-read', JSON.stringify(r2));

  // And the one that used to rewind it: an older version of the record.
  const r3 = classify({ seq: 4, status: 'running', total: 180, completed: 12, engineCount: 3,
    promptsTotal: 60, startedAt: beat(0) }, view, { now: at(2) });
  check('a read older than one already shown is discarded',
    r3.action === 'ignore' && r3.reason === 'stale-seq', JSON.stringify(r3));

  // What matters is that it is never rendered, not which rule caught it.
  const r4 = classify({ seq: 7, total: 0, completed: 0 }, view, { now: at(2), pending: false, graceLeft: 0 });
  check('a running run can never become "hasn\'t started"', r4.action === 'ignore', JSON.stringify(r4));
  // The same, from a read that carries a status — so it reaches the forward-only rule itself
  // rather than being caught earlier as a dropped read.
  const r5 = classify({ seq: 8, status: 'none', total: 0 }, view, { now: at(2), pending: false, graceLeft: 0 });
  check('nor via a record that claims there is no run', r5.action === 'ignore', JSON.stringify(r5));
}

console.log('\nQuiet, but not dead:\n');
{
  let view = { seq: 1, rank: 2 };
  const quiet = { seq: 9, status: 'running', total: 180, completed: 36, engineCount: 3,
    promptsTotal: 60, startedAt: beat(0), lastProgressAt: beat(5) };
  const a = classify(quiet, { ...view }, { now: at(7) });
  check('two minutes without a write is still running', a.state === 'running', a.state);
  const b = classify(quiet, { ...view }, { now: at(12) });
  check('seven minutes without one is stalled', b.state === 'stalled', b.state);
  check('and the stall is measured from the server heartbeat',
    Math.round(b.idleFor / 60000) === 7, Math.round(b.idleFor / 60000) + ' min');
}

console.log('\nFinishing:\n');
{
  let view = { seq: 1, rank: 2 };
  const done = classify({ seq: 20, status: 'done', total: 180, completed: 180, engineCount: 3,
    promptsTotal: 60, cited: 44, startedAt: beat(0), finishedAt: beat(9) }, view, { now: at(9) });
  check('a completed run is terminal', done.state === 'done' && done.terminal === true, done.state);
  check('and reads 100%', done.pct === 100, done.pct + '%');

  const cut = classify({ seq: 21, total: 180, completed: 96, engineCount: 3, promptsTotal: 60,
    startedAt: beat(0), finishedAt: beat(11) }, { seq: 1, rank: 2 }, { now: at(12) });
  check('a run that stopped short is "ended incomplete", not "done"',
    cut.state === 'incomplete' && cut.terminal === true, cut.state);
  check('and reports the prompts it did reach', cut.promptsDone === 32, String(cut.promptsDone));
}

console.log('\nStarting, and continuing:\n');
{
  const q = classify({ total: 0 }, {}, { now: at(0), pending: true, graceLeft: 40 });
  check('a just-triggered run shows as queued', q.state === 'queued', q.state);

  const fresh = classify({ seq: 1, status: 'running', total: 180, completed: 0, engineCount: 3,
    promptsTotal: 60, startedAt: beat(0), lastProgressAt: beat(0) }, q.view, { now: at(0) });
  check('and moves to running when the run reports', fresh.state === 'running', fresh.state);

  const part2 = classify({ seq: 40, status: 'running', total: 180, completed: 120, engineCount: 3,
    promptsTotal: 60, continuations: 1, startedAt: beat(0), lastProgressAt: beat(11) }, { seq: 1, rank: 2 }, { now: at(11) });
  check('a continuation is reported as a part, not a crash',
    part2.state === 'running' && part2.continuations === 1, part2.state + ' cont=' + part2.continuations);

  const none = classify({ status: 'none' }, {}, { now: at(0), pending: false, graceLeft: 0 });
  check('a customer with no run shows nothing rather than guessing', none.state === 'none', none.state);
}


console.log('\nThe status endpoint itself failing:\n');
{
  // /api/audit-job answers its refusals as JSON with a 4xx, and pollJobStatus reads the body
  // regardless of status. That body used to fall through every branch to "no audit yet" — so one
  // bad poll in the middle of a live run replaced the progress bar with a badge saying no run had
  // ever happened. An endpoint we could not read is not a run that never started.
  const denied = classify({ error: 'Sign in to continue.', needsSignIn: true }, { seq: 9, rank: 2 }, { now: at(3) });
  check('a refused status read is its own state, not "no audit yet"',
    denied.action === 'render' && denied.state === 'unavailable', denied.state);
  check('and it carries the reason and the sign-in flag through',
    denied.message === 'Sign in to continue.' && denied.needsSignIn === true, JSON.stringify(denied));
  check('it is not terminal, so polling keeps going and a blip heals itself',
    denied.terminal === false, String(denied.terminal));

  // A real record that merely happens to carry a message must not be mistaken for one.
  const real = classify({ seq: 10, status: 'running', total: 180, completed: 36, engineCount: 3,
    promptsTotal: 60, error: '', startedAt: beat(0), lastProgressAt: beat(1) }, { seq: 9, rank: 2 }, { now: at(2) });
  check('a real running record is still running', real.state === 'running', real.state);
}

console.log('\nEvery state the classifier can return is drawn by the page:\n');
{
  // This is the check that the bug above needed. audit-status.js gained "unavailable" and
  // index.html was never taught to draw it, so the classifier said "render this" and the page
  // silently rendered the fallback instead. A state with no branch is invisible by construction.
  const fs = require('fs'), path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const RANK = require('../js/audit-status.js').RANK;
  const classifier = fs.readFileSync(path.join(__dirname, '..', 'js', 'audit-status.js'), 'utf8');

  // Every state name the classifier can emit: the ranked ones, plus any state: 'x' it returns.
  const emitted = new Set(Object.keys(RANK));
  for (const m of classifier.matchAll(/state:\s*'([a-z]+)'/g)) emitted.add(m[1]);
  emitted.delete('none');   // deliberately the page's fallback, not a branch

  for (const state of [...emitted].sort()) {
    check('index.html draws "' + state + '"',
      page.includes("state === '" + state + "'"), 'no branch for it');
  }
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
