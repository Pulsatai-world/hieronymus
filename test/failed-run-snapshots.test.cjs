// A monitoring run where every row failed was recorded as a completed run and landed on the trend as
// a month of zero visibility — a failed measurement rendered as a real result. Covers both halves of
// the fix: the run reports the failure rather than 'done', and the dashboard leaves such a snapshot
// out of the trend while keeping partly-failed runs, whose successful rows are real data.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

// ── The dashboard's snapshot filter, lifted from the shipped file ──
const dash = fs.readFileSync('dashboard-monitoring.html', 'utf8');
const start = dash.indexOf('  const allSnapshots = [...new Set(TAPE.map(r => r.snapshot_date))].sort();');
const end = dash.indexOf('  DATES = allSnapshots.filter', start);
const filterSrc = dash.slice(start, end) + '  DATES = allSnapshots.filter(d => !failedSnapshots.includes(d));';

function runFilter(rows) {
  const ctx = { TAPE: rows, DATES: [], window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(filterSrc, ctx);
  return { dates: ctx.DATES, tape: ctx.TAPE, failed: ctx.window.__failedSnapshots };
}

const ok = (d) => ({ snapshot_date: d, sentiment: 'positive', brand_cited: 1 });
const bad = (d) => ({ snapshot_date: d, sentiment: 'error', brand_cited: 0 });

// FIACSA's case: one good month, then a run that collected nothing.
let r = runFilter([ok('2026-06-01'), ok('2026-06-01'), bad('2026-07-01'), bad('2026-07-01')]);
check('a wholly failed snapshot is left out of the trend', !r.dates.includes('2026-07-01'), JSON.stringify(r.dates));
check('the good snapshot survives', r.dates.includes('2026-06-01'), JSON.stringify(r.dates));
check('its rows are dropped so tallies cannot see them', r.tape.every(x => x.snapshot_date !== '2026-07-01'));
check('the excluded date is reported so the viewer can be told', Array.isArray(r.failed) && r.failed.includes('2026-07-01'));

// A partial failure is real data and must be kept.
r = runFilter([ok('2026-08-01'), bad('2026-08-01')]);
check('a partly failed snapshot is KEPT', r.dates.includes('2026-08-01'), JSON.stringify(r.dates));
check('nothing is reported as excluded for a partial failure', r.failed.length === 0);

// No failures at all.
r = runFilter([ok('2026-09-01')]);
check('a clean run is untouched', r.dates.length === 1 && r.failed.length === 0);

// Empty input must not throw or invent a date.
r = runFilter([]);
check('no rows yields no dates', r.dates.length === 0);

// ── The run must not call a total failure 'done' ──
const audit = fs.readFileSync('netlify/functions/run-audit-background.js', 'utf8');
check('the run counts failed rows', /erroredCount\+\+/.test(audit));
check('a wholly failed run reports error rather than done',
  /status: allFailed \? 'error' : 'done'/.test(audit), 'status assignment not found');
check('the failure count is recorded on the job either way', /errored: erroredCount/.test(audit));

// ── Deletion can target one snapshot without wiping the history ──
const results = fs.readFileSync('netlify/functions/results.js', 'utf8');
check('delete accepts a snapshot_date', /snapshot_date/.test(results));
check('delete still filters by company as well',
  /r\.data\.brand === company\s*\n?\s*&& \(!snapshot \|\| r\.data\.snapshot_date === snapshot\)/.test(results),
  'company+snapshot filter not found');

console.log(failures ? '\n' + failures + ' FAILING' : '\nall green');
process.exit(failures ? 1 : 0);
