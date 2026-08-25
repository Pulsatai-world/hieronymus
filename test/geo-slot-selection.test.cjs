// Pulls the actual slot-selection expressions out of geo-scan-job.js and runs them against
// realistic key lists. Asserting on the real source rather than a copy, because a copy would
// keep passing after the source changed.
const fs = require('fs');
const src = fs.readFileSync('netlify/functions/geo-scan-job.js', 'utf8').replace(/\r\n/g, '\n');

const block = src.match(/const latest = keys\.length[\s\S]*?const second = keys\.length > 1 \? latest : null;/);
if (!block) { console.log('could not find the selection block'); process.exit(1); }

function select(keys) {
  const loaded = Object.fromEntries(keys.map(k => [k, { stamp: k }]));
  // eslint-disable-next-line no-new-func
  return new Function('keys', 'loaded', block[0] + '\nreturn { first: first ? first.stamp : null, second: second ? second.stamp : null };')(keys, loaded);
}

let fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   got ' + JSON.stringify(got) + '  want ' + JSON.stringify(want)));
  if (!ok) fail++;
};

t('no runs',      select([]),                                  { first: null, second: null });
t('one run',      select(['c/r1']),                            { first: 'c/r1', second: null });
t('two runs',     select(['c/r1', 'c/r2']),                    { first: 'c/r1', second: 'c/r2' });
t('three runs',   select(['c/r1', 'c/r2', 'c/r3']),            { first: 'c/r2', second: 'c/r3' });
t('five runs',    select(['c/r1', 'c/r2', 'c/r3', 'c/r4', 'c/r5']), { first: 'c/r4', second: 'c/r5' });

console.log('\nAfter a new scan, what was in slot 2 must appear in slot 1:');
const before = select(['c/r1', 'c/r2']);
const after = select(['c/r1', 'c/r2', 'c/r3']);
t('slot 2 moves up to slot 1', after.first, before.second);
t('slot 2 holds the new run', after.second, 'c/r3');

console.log('\n' + (fail ? fail + ' FAILURE(S)' : 'all assertions passed'));
process.exit(fail ? 1 : 0);
