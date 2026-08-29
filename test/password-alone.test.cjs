// Two-factor guarded the login pages but not the endpoints behind them: every scoped endpoint
// accepted a raw username+password, so a stolen password still read and wrote everything over plain
// HTTP and the code only stopped someone using the UI.
//
// This suite is the attack, run against every scoped endpoint: correct password, no two-factor
// ticket. All of it must be refused, and everything a real signed-in session does must still work.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const STORES = {};
const store = name => (STORES[name] = STORES[name] || {});
const getStore = name => ({
  get: async (k, o) => (k in store(name) ? (o && o.type === 'json' ? JSON.parse(JSON.stringify(store(name)[k])) : store(name)[k]) : null),
  setJSON: async (k, v) => { store(name)[k] = JSON.parse(JSON.stringify(v)); },
  set: async (k, v) => { store(name)[k] = v; },
  delete: async k => { delete store(name)[k]; },
  list: async () => ({ blobs: Object.keys(store(name)).map(key => ({ key })) })
});

function libSourceRaw(file) {
  const raw = fs.readFileSync('netlify/functions/' + file, 'utf8');
  return [...raw.matchAll(/^import \{[^}]+\} from '\.\/(lib\/[\w.-]+)';$/gm)]
    .map(m => fs.readFileSync('netlify/functions/' + m[1], 'utf8')).join('\n');
}

function load(file) {
  const src = libSourceRaw(file).replace(/^import .*?;$/gm, '').replace(/^export (function|const|async function) /gm, '$1 ')
    + '\n' + fs.readFileSync('netlify/functions/' + file, 'utf8')
      .replace(/^import .*?;$/gm, '')
      .replace(/^export default /m, 'EXPORTS.handler = ');
  const ctx = { getStore, crypto, URL, URLSearchParams, Response, Request, Buffer, console, EXPORTS: {},
                fetch: async () => ({ ok: true, json: async () => ({}) }), process: { env: {} } };
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

const PW = 'known-password';
function scrypt(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
const GET = (fn, qs) => fn(new Request('https://x/api/x?' + qs), {});
const send = (fn, method, qs, body) => fn(new Request('https://x/api/x' + (qs ? '?' + qs : ''), {
  method, headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
}), {});

(async () => {
  const results = load('results.js');
  const intake = load('intake.js');
  const prompts = load('prompts.js');
  const intakeCodes = load('intake-codes.js');
  const customerKeys = load('customer-keys.js');
  const auditJob = load('audit-job.js');
  const generateJob = load('generate-job.js');

  const TICKET = 'ticket-abc';
  const setup = () => {
    Object.keys(STORES).forEach(k => delete STORES[k]);
    store('hieronymus-staff-users')['akore-rene'] = {
      username: 'akore-rene', role: 'admin', passwordHash: scrypt(PW),
      totp: { secret: 'JBSWY3DPEHPK3PXP', enabledAt: '2026-08-01T00:00:00Z' }
    };
    store('hieronymus-intake-codes')['fiacsa'] = {
      company: 'FIACSA', submittedAt: '2026-02-01T00:00:00Z',
      members: [{ username: 'fiacsa', role: 'full', passwordHash: scrypt(PW),
                  totp: { secret: 'JBSWY3DPEHPK3PXP', enabledAt: '2026-08-01T00:00:00Z' } }]
    };
    store('hieronymus-intake')['fiacsa'] = { company: 'FIACSA', intake: { general: { company: 'FIACSA' } } };
    store('hieronymus-prompts')['fiacsa'] = { company: 'FIACSA', promptsText: 'Q1\nQ2', internalApprovedAt: '2026-03-01T00:00:00Z' };
    store('hieronymus-results-rows')['r1'] = { run_id: 'r1', company: 'FIACSA', prompt_id: 'Q01', snapshot_date: '2026-03-01' };
    store('hieronymus-customer-keys')['fiacsa'] = { company: 'FIACSA', claude: 'sk-secret' };
    store('hieronymus-audit-jobs')['fiacsa'] = { company: 'FIACSA', status: 'done' };
    store('hieronymus-generate-jobs')['fiacsa'] = { company: 'FIACSA', status: 'done' };
    // A live ticket, as a real login would have issued.
    store('hieronymus-2fa-sessions')[TICKET] = {
      username: 'fiacsa', expiresAt: new Date(Date.now() + 11 * 3600 * 1000).toISOString()
    };
    store('hieronymus-2fa-sessions')['staff-ticket'] = {
      username: 'akore-rene', expiresAt: new Date(Date.now() + 11 * 3600 * 1000).toISOString()
    };
    store('hieronymus-staff-sessions')['STOK'] = {
      username: 'akore-rene', createdAt: new Date().toISOString(), expiresAt: '2030-01-01T00:00:00Z'
    };
  };

  const cust = 'company=FIACSA&username=fiacsa&password=' + encodeURIComponent(PW);
  const staffPw = 'company=FIACSA&staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW);

  // ── The attack: a correct password, no ticket ──
  console.log("A stolen CUSTOMER password, straight at the API:");
  setup();
  for (const [label, fn] of [['/api/results', results], ['/api/intake', intake], ['/api/prompts', prompts], ['/api/intake-codes', intakeCodes]]) {
    const res = await GET(fn, cust);
    const text = await res.text();
    check(label + ' refuses it', res.status === 401, 'status ' + res.status);
    check(label + ' returns none of the data', !/sk-secret|Q01|promptsText|"intake"/.test(text), text.slice(0, 120));
  }

  console.log("\nA stolen STAFF password, straight at the API:");
  setup();
  for (const [label, fn] of [['/api/results', results], ['/api/intake', intake], ['/api/prompts', prompts],
                             ['/api/intake-codes', intakeCodes], ['/api/customer-keys', customerKeys],
                             ['/api/audit-job', auditJob], ['/api/generate-job', generateJob]]) {
    const res = await GET(fn, staffPw);
    check(label + ' refuses it', res.status === 401, 'status ' + res.status);
  }

  console.log("\nWriting with a stolen password:");
  setup();
  {
    const save = await send(intake, 'POST', '', { company: 'FIACSA', intake: { x: 1 }, requestingUsername: 'fiacsa', requestingPassword: PW });
    check('overwriting the intake is refused', save.status === 401, 'status ' + save.status);
    check('the stored intake is untouched', !!STORES['hieronymus-intake']['fiacsa'].intake.general, 'overwritten');

    const approve = await send(prompts, 'PATCH', '', { company: 'FIACSA', requestingUsername: 'fiacsa', requestingPassword: PW });
    check('approving the prompts is refused', approve.status === 401, 'status ' + approve.status);
    check('the prompt set is not marked approved', !STORES['hieronymus-prompts']['fiacsa'].approvedAt, 'approved');

    const wipe = await send(results, 'DELETE', 'company=FIACSA&requestingUsername=akore-rene&requestingPassword=' + encodeURIComponent(PW));
    check('wiping the results is refused', wipe.status === 401, 'status ' + wipe.status);
    check('the result row survives', !!STORES['hieronymus-results-rows']['r1'], 'deleted');

    const keys = await send(customerKeys, 'POST', '', { company: 'FIACSA', claude: 'sk-attacker', staffUsername: 'akore-rene', staffPassword: PW });
    check('replacing an engine key is refused', keys.status === 401, 'status ' + keys.status);
    check('the real key survives', STORES['hieronymus-customer-keys']['fiacsa'].claude === 'sk-secret',
      STORES['hieronymus-customer-keys']['fiacsa'].claude);
  }

  // ── A real session must still work, or the fix is just an outage ──
  console.log("\nA real customer session (password + the ticket from their login):");
  setup();
  {
    const q = cust + '&tfToken=' + TICKET;
    check('reads their own results', (await GET(results, q)).status === 200, '');
    check('reads their own intake', (await GET(intake, q)).status === 200, '');
    check('reads their own prompts', (await GET(prompts, q)).status === 200, '');
    check('reads their own record', (await GET(intakeCodes, q)).status === 200, '');

    const save = await send(intake, 'POST', '', { company: 'FIACSA', intake: { general: { company: 'FIACSA' } }, requestingUsername: 'fiacsa', requestingPassword: PW, tfToken: TICKET });
    check('can still save their intake', save.status === 200 || save.status === 409, 'status ' + save.status);

    // And still only their own data.
    const other = 'company=OtherCo&username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=' + TICKET;
    const res = await GET(results, other);
    check("still cannot read another customer's data", res.status === 403 || res.status === 404, 'status ' + res.status);
  }

  console.log("\nA real staff session (a session token, which only exists after a code):");
  setup();
  {
    const q = 'company=FIACSA&staffUsername=akore-rene&staffToken=STOK';
    check('reads results', (await GET(results, q)).status === 200, '');
    check('reads the intake', (await GET(intake, q)).status === 200, '');
    check('reads prompts', (await GET(prompts, q)).status === 200, '');
    check('reads key status', (await GET(customerKeys, q)).status === 200, '');
    check('reads the audit job', (await GET(auditJob, q)).status === 200, '');

    // A staff password still works when the browser also holds its two-factor ticket.
    const withTicket = 'company=FIACSA&staffUsername=akore-rene&staffPassword=' + encodeURIComponent(PW) + '&tfToken=staff-ticket';
    check('password plus ticket also works', (await GET(results, withTicket)).status === 200, '');
  }

  console.log("\nTickets cannot be borrowed or outlived:");
  setup();
  {
    const q = c => 'company=FIACSA&username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=' + c;
    store('hieronymus-2fa-sessions')['someone-else'] = { username: 'other-user', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
    check("another account's ticket is refused", (await GET(results, q('someone-else'))).status === 401, '');
    store('hieronymus-2fa-sessions')['stale'] = { username: 'fiacsa', expiresAt: '2020-01-01T00:00:00Z' };
    check('an expired ticket is refused', (await GET(results, q('stale'))).status === 401, '');
    check('an invented ticket is refused', (await GET(results, q('made-up'))).status === 401, '');
    store('hieronymus-2fa-sessions')['no-expiry'] = { username: 'fiacsa' };
    check('a ticket with no expiry is refused', (await GET(results, q('no-expiry'))).status === 401, '');
  }

  console.log("\nA ticket in active use is extended rather than expiring mid-task:");
  setup();
  {
    store('hieronymus-2fa-sessions')['nearly'] = {
      username: 'fiacsa', expiresAt: new Date(Date.now() + 60 * 1000).toISOString()
    };
    const before = STORES['hieronymus-2fa-sessions']['nearly'].expiresAt;
    const res = await GET(results, 'company=FIACSA&username=fiacsa&password=' + encodeURIComponent(PW) + '&tfToken=nearly');
    check('the request succeeds', res.status === 200, 'status ' + res.status);
    check('and the ticket was extended', STORES['hieronymus-2fa-sessions']['nearly'].expiresAt > before,
      before + ' -> ' + STORES['hieronymus-2fa-sessions']['nearly'].expiresAt);
  }

  // ── The login itself must stay reachable, or nobody can ever get a ticket ──
  console.log("\nThe login and the password-confirm gate must stay reachable:");
  setup();
  {
    const login = await GET(intakeCodes, 'username=fiacsa&password=' + encodeURIComponent(PW));
    check('the customer login still answers (asks for a code)', login.status === 401 && (await login.json()).needsCode === true, 'status ' + login.status);
    const staffUsers = load('staff-users.js');
    const verify = await GET(staffUsers, 'verifyOnly=1&username=akore-rene&password=' + encodeURIComponent(PW));
    check('the in-app password confirm still answers', verify.status === 200 && (await verify.json()).ok === true, 'status ' + verify.status);
    const probe = await GET(staffUsers, 'bootstrap=1');
    check('the first-run probe still answers', probe.status === 200, 'status ' + probe.status);
  }

  // ── The end-to-end bypass: an admin password was enough to mint a new way in ──
  console.log("\nAn admin password alone must not be able to mint a new way in:");
  setup();
  {
    const staffUsers = load('staff-users.js');
    const twoFactor = load('two-factor.js');
    const asAdmin = { requestingUsername: 'akore-rene', requestingPassword: PW };

    // The attack: create a second admin account, log in as it, enroll your own authenticator.
    const create = await send(staffUsers, 'POST', '', { username: 'evil', password: 'chosen-pw', role: 'admin', ...asAdmin });
    check('creating a staff account is refused', create.status === 401, 'status ' + create.status);
    check('no account was created', !STORES['hieronymus-staff-users']['evil'], 'created');

    // The other route: clear a real account's two-factor, then walk in.
    const clear = await send(twoFactor, 'POST', '', { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW });
    check("clearing someone's two-factor is refused", clear.status === 401, 'status ' + clear.status);
    check('their authenticator survives', !!STORES['hieronymus-intake-codes']['fiacsa'].members[0].totp.enabledAt, 'cleared');

    // And resetting a password to take the account over.
    const reset = await send(staffUsers, 'PATCH', '', { username: 'akore-rene', newPassword: 'attacker-pw', ...asAdmin });
    check("resetting an account's password is refused", reset.status === 401, 'status ' + reset.status);

    const del = await send(staffUsers, 'DELETE', 'username=akore-rene&requestingUsername=akore-rene&requestingPassword=' + encodeURIComponent(PW));
    check('deleting a staff account is refused', del.status === 401, 'status ' + del.status);

    // Releasing a dashboard and resetting a customer password are the same class of action.
    const release = await send(intakeCodes, 'PATCH', '', { company: 'FIACSA', diagnosisReleased: true, requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW });
    check('releasing a dashboard is refused', release.status === 401, 'status ' + release.status);

    // With the ticket, an admin can still do all of it.
    const ok = await send(staffUsers, 'POST', '', { username: 'newstaff', password: 'good-pw', role: 'user', ...asAdmin, tfToken: 'staff-ticket' });
    check('an admin holding their ticket can still create an account', ok.status === 200, 'status ' + ok.status);
    const okClear = await send(twoFactor, 'POST', '', { action: 'reset', username: 'fiacsa', requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW, tfToken: 'staff-ticket' });
    check('and can still reset a lost authenticator', okClear.status === 200, 'status ' + okClear.status);
  }

  console.log("\nDeleting a customer had no authorisation at all:");
  setup();
  {
    const anon = await send(intakeCodes, 'DELETE', 'username=fiacsa');
    check('an anonymous delete is refused', anon.status === 401 || anon.status === 403, 'status ' + anon.status);
    check('the customer still exists', !!STORES['hieronymus-intake-codes']['fiacsa'], 'deleted');

    const noTicket = await send(intakeCodes, 'DELETE', 'username=fiacsa&requestingStaffUsername=akore-rene&requestingStaffPassword=' + encodeURIComponent(PW));
    check('a staff password without the ticket is refused', noTicket.status === 401, 'status ' + noTicket.status);
    check('the customer still exists', !!STORES['hieronymus-intake-codes']['fiacsa'], 'deleted');

    const member = await send(intakeCodes, 'DELETE', 'username=fiacsa&memberOnly=true');
    check('an anonymous member removal is refused', member.status === 401 || member.status === 403, 'status ' + member.status);

    const real = await send(intakeCodes, 'DELETE', 'username=fiacsa&requestingStaffUsername=akore-rene&requestingStaffPassword=' + encodeURIComponent(PW) + '&tfToken=staff-ticket');
    check('a staff admin with their ticket can still delete', real.status === 200, 'status ' + real.status);
    check('and the customer is gone', !STORES['hieronymus-intake-codes']['fiacsa'], 'still there');
  }

  // ── The empty-handed request ──
  // "No member credentials means staff" made a request carrying NOTHING the most privileged kind,
  // and anyone can send one. Worst of all was adding a user: the attacker got a real account on a
  // real customer, and because enrollment is mandatory for a new account the app then walked them
  // through setting up their own authenticator. A full takeover starting from nothing.
  console.log("\nA request carrying no credentials at all:");
  setup();
  {
    const bare = await send(intakeCodes, 'POST', '', {
      addMember: true, company: 'FIACSA', username: 'attacker', password: 'chosen-pw', role: 'full'
    });
    check('adding a user to a customer is refused', bare.status === 403 || bare.status === 401, 'status ' + bare.status);
    check('no such user exists', !STORES['hieronymus-intake-codes']['fiacsa'].members.some(m => m.username === 'attacker'),
      JSON.stringify(STORES['hieronymus-intake-codes']['fiacsa'].members.map(m => m.username)));

    const create = await send(intakeCodes, 'POST', '', { company: 'Brand New Co' });
    check('creating a customer is refused', create.status === 403 || create.status === 401, 'status ' + create.status);
    check('no record was created', !STORES['hieronymus-intake-codes']['brand-new-co'], 'created');

    const overwrite = await send(intake, 'POST', '', { company: 'FIACSA', intake: { general: { company: 'FIACSA' }, wiped: true } });
    check("overwriting a customer's intake is refused", overwrite.status === 403, 'status ' + overwrite.status);
    check('their answers are untouched', !STORES['hieronymus-intake']['fiacsa'].intake.wiped, 'overwritten');

    const approve = await send(prompts, 'PATCH', '', { company: 'FIACSA', promptsText: 'REPLACED' });
    check('approving/rewriting a prompt set is refused', approve.status === 403, 'status ' + approve.status);
    check('the prompt text is untouched', STORES['hieronymus-prompts']['fiacsa'].promptsText !== 'REPLACED',
      STORES['hieronymus-prompts']['fiacsa'].promptsText);
    check('and it is not marked approved', !STORES['hieronymus-prompts']['fiacsa'].approvedAt, 'approved');

    const mon = await send(intakeCodes, 'PATCH', '', { username: 'fiacsa', monitoringEnabled: true });
    check('turning on monthly monitoring is refused', mon.status === 403, 'status ' + mon.status);
    check('monitoring stayed off', !STORES['hieronymus-intake-codes']['fiacsa'].monitoringEnabled, 'enabled');

    const sub = await send(intakeCodes, 'PATCH', '', { username: 'fiacsa', markSubmitted: true });
    check('marking an intake submitted is refused', sub.status === 403, 'status ' + sub.status);

    // A stolen password could otherwise change the password and lock the real customer out.
    const pwChange = await send(intakeCodes, 'PATCH', '', { username: 'fiacsa', currentPassword: PW, newPassword: 'attacker-pw' });
    check('changing the password with no ticket is refused', pwChange.status === 401, 'status ' + pwChange.status);
    const withTicket = await send(intakeCodes, 'PATCH', '', { username: 'fiacsa', currentPassword: PW, newPassword: 'their-new-pw', tfToken: TICKET });
    check('the real customer can still change their own password', withTicket.status === 200, 'status ' + withTicket.status);
  }

  console.log("\nBut the people who should be able to do those things still can:");
  setup();
  {
    const staffAdmin = { requestingStaffUsername: 'akore-rene', requestingStaffPassword: PW, tfToken: 'staff-ticket' };

    const addUser = await send(intakeCodes, 'POST', '', { addMember: true, company: 'FIACSA', username: 'newperson', password: 'good-pw', role: 'full', ...staffAdmin });
    check('a staff admin can add a user', addUser.status === 200, 'status ' + addUser.status);

    const create = await send(intakeCodes, 'POST', '', { company: 'Brand New Co', ...staffAdmin });
    check('a staff admin can create a customer', create.status === 200, 'status ' + create.status);

    // The customer saving their own answers.
    const own = await send(intake, 'POST', '', { company: 'FIACSA', intake: { general: { company: 'FIACSA' } }, requestingUsername: 'fiacsa', requestingPassword: PW, tfToken: TICKET });
    check('a customer can save their own intake', own.status === 200 || own.status === 409, 'status ' + own.status);

    // Staff correcting it on the customer's behalf — now with credentials, via the query string.
    const byStaff = await send(intake, 'POST', 'staffUsername=akore-rene&staffToken=STOK', { company: 'FIACSA', intake: { general: { company: 'FIACSA' }, fixed: true } });
    check('staff can still correct a customer intake', byStaff.status === 200, 'status ' + byStaff.status);
    check('and the correction was saved', STORES['hieronymus-intake']['fiacsa'].intake.fixed === true, 'not saved');

    const approve = await send(prompts, 'PATCH', '', { company: 'FIACSA', requestingUsername: 'fiacsa', requestingPassword: PW, tfToken: TICKET });
    check('a customer can approve their own prompts', approve.status === 200, 'status ' + approve.status);

    const staffApprove = await send(prompts, 'PATCH', 'staffUsername=akore-rene&staffToken=STOK', { company: 'FIACSA', promptsText: 'Revised Q1' });
    check('staff can still revise on their behalf', staffApprove.status === 200, 'status ' + staffApprove.status);

    const mon = await send(intakeCodes, 'PATCH', '', { company: 'FIACSA', monitoringCadence: 'monthly', monitoringEnabled: true, ...staffAdmin });
    check('a staff admin can turn monitoring on', mon.status === 200, 'status ' + mon.status);

    const sub = await send(intakeCodes, 'PATCH', '', { username: 'fiacsa', markSubmitted: true, requestingPassword: PW, tfToken: TICKET });
    check('a customer can mark their own intake submitted', sub.status === 200, 'status ' + sub.status);
  }

  // ── Every page must actually send the ticket, or the fix is an outage ──
  console.log("\nThe browser sends the ticket everywhere credentials go:");
  {
    const auth = fs.readFileSync('js/results-auth.js', 'utf8');
    check('resultsQuery attaches it for customers', /params\.set\('username'[\s\S]{0,400}tfToken/.test(auth), 'not attached');
    check('resultsQuery attaches it on the staff password path', /staffPassword[\s\S]{0,300}tfToken/.test(auth), 'not attached');
    check('one accessor exists for body credentials', auth.includes('window.twoFactorTicket'), 'missing');
    ['index.html', 'intake.html', 'prompt-review.html'].forEach(f => {
      const src = fs.readFileSync(f, 'utf8');
      const sites = (src.match(/requestingPassword/g) || []).length;
      const tickets = (src.match(/twoFactorTicket/g) || []).length;
      check(f + ' sends a ticket with every password it puts in a request', tickets >= sites, tickets + ' tickets for ' + sites + ' credential sites');
    });
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
