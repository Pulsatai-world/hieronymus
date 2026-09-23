// The run handing off to itself has to get past its own front door.
//
// /api/run-audit is staff-only. The run re-invokes itself at the platform's time limit by POSTing
// to that same path — so the moment the guard went on, every run longer than ~11 minutes died at
// the handoff. It died silently, too: fetch only throws on a transport failure, so a 401 sailed
// past the catch and the job record sat at "running" with no invocation behind it.
//
// Two things are asserted, because fixing only the first would leave the second failure silent:
// the handoff carries a credential, and a refused handoff is recorded as an error.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

console.log('A run that continues past the time limit:\n');

const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/run-audit-background.js'), 'utf8');
const handoff = src.slice(src.indexOf('if (handedOffAt !== null)'), src.indexOf('return new Response(JSON.stringify({ status: \'continued\''));

check('the endpoint is staff-only', /requireStaff/.test(src), 'no guard at all');
check('the handoff signs itself in', /createStaffSession/.test(handoff),
  'it POSTs to a staff-only endpoint with no session — every long run dies here');
check('and sends that session with the request', /session:\s*relaySession/.test(handoff),
  'a session is minted but not sent');
check('a refused handoff is not mistaken for a successful one', /res\.ok/.test(handoff),
  'fetch only throws on transport failure, so a 401 leaves the job "running" forever');
check('and is recorded as an error on the job', /status:\s*'error'/.test(handoff), 'the failure is swallowed');

// The same class of caller, already fixed once — kept here so both stay honest.
const cron = fs.readFileSync(path.join(ROOT, 'netlify/functions/monthly-audit-cron.js'), 'utf8');
check('the monthly cron signs itself in too', /createStaffSession/.test(cron), 'the cron cannot trigger a run');
check('and sends its session', /session:\s*cronSession/.test(cron), 'minted but not sent');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
