// The progress bar reads stored rows when the job record is not keeping up, and it has to know
// which of those rows belong to the run in flight.
//
// That used to be `rows.length !== rowsAtTrigger`, and it worked only by accident of something
// else: a diagnostic run deleted the customer's entire previous set before writing a single row,
// so the count dropped the moment the run began and that drop WAS the signal. When the up-front
// delete was removed — a run that failed after it left the customer with no data at all — and
// rows became keyed per customer+date+prompt+engine, a same-day re-run started overwriting its
// predecessor in place. The count never changed, `live` never turned true, and the bar sat at 0%
// through an entire five-minute run while the rows piled up behind it. The audit was fine; only
// the bar was lying.
const assert = require('node:assert');
const { test } = require('node:test');
const { classifyRows } = require('../js/audit-status.js');

const TRIGGER = '2026-10-07T12:00:00.000Z';
const before = n => Array.from({ length: n }, (_, i) => ({
  snapshot_date: '2026-10-07', brand_cited: '1', written_at: '2026-10-07T11:00:00.000Z',
  prompt_id: 'Q' + i
}));
const after = n => Array.from({ length: n }, (_, i) => ({
  snapshot_date: '2026-10-07', brand_cited: '1', written_at: '2026-10-07T12:00:30.000Z',
  prompt_id: 'Q' + i
}));

test('a same-day re-run that overwrites rows in place still reports progress', () => {
  // 40 rows from this morning's run; the new run has rewritten 20 of them at the same keys, so
  // the total is unchanged. This is the case that showed 0% for five minutes.
  const rows = after(20).concat(before(20));
  const seen = classifyRows(rows, { rowsAtTrigger: 40, triggeredAt: TRIGGER });
  assert.strictEqual(seen.live, true, 'the run was not recognised as live — the bar stays at 0%');
  assert.strictEqual(seen.completed, 20, 'counted the old rows too, or none of them');
});

test('and it counts only this run, not every row sharing the date', () => {
  const rows = after(5).concat(before(35));
  const seen = classifyRows(rows, { rowsAtTrigger: 40, triggeredAt: TRIGGER });
  assert.strictEqual(seen.completed, 5,
    'the bar would jump to the previous run\'s position the moment this one started');
});

test('rows that predate the trigger alone are not this run', () => {
  const seen = classifyRows(before(40), { rowsAtTrigger: 40, triggeredAt: TRIGGER });
  assert.strictEqual(seen.live, false, 'last run\'s rows were read as progress on this one');
  assert.strictEqual(seen.completed, 0);
});

test('rows written before written_at existed still work, by the old count comparison', () => {
  const legacy = n => Array.from({ length: n }, () => ({ snapshot_date: '2026-10-07', brand_cited: '1' }));
  const grew = classifyRows(legacy(12), { rowsAtTrigger: 0, triggeredAt: TRIGGER });
  assert.strictEqual(grew.live, true, 'a run writing its first rows was not detected');
  assert.strictEqual(grew.completed, 12);
  const flat = classifyRows(legacy(12), { rowsAtTrigger: 12, triggeredAt: TRIGGER });
  assert.strictEqual(flat.live, false);
});

test('a first-ever run, with nothing before it, reports progress', () => {
  const seen = classifyRows(after(7), { rowsAtTrigger: 0, triggeredAt: TRIGGER });
  assert.strictEqual(seen.live, true);
  assert.strictEqual(seen.completed, 7);
});

test('no trigger record means no claim either way', () => {
  assert.deepStrictEqual(classifyRows(after(9), null), { live: false, completed: 0, cited: 0 });
  assert.deepStrictEqual(classifyRows(after(9), {}), { live: false, completed: 0, cited: 0 });
});

test('cited counts come from this run too', () => {
  const rows = after(4).concat([{ snapshot_date: '2026-10-07', brand_cited: '0', written_at: '2026-10-07T12:00:31.000Z' }]);
  const seen = classifyRows(rows, { rowsAtTrigger: 5, triggeredAt: TRIGGER });
  assert.strictEqual(seen.completed, 5);
  assert.strictEqual(seen.cited, 4);
});
