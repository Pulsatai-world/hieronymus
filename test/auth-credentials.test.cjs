// Runs the real results-auth.js against stubbed browser storage and asserts what actually ends up
// on the wire. The 403 came from a credential being dropped between two functions that each
// looked correct on their own, so the assertion has to be about the final URL.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('js/results-auth.js', 'utf8');

function run(store, session) {
  const local = { ...store }, sess = { ...session };
  const ctx = {
    localStorage: { getItem: k => (k in local ? local[k] : null), setItem: (k, v) => local[k] = String(v), removeItem: k => delete local[k] },
    sessionStorage: { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => sess[k] = String(v), removeItem: k => delete sess[k] },
    URLSearchParams, document: { querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, json: async () => ({ token: 'MINTED_TOKEN' }) }),
    console
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, local };
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

(async () => {
  console.log('A staff session holding a token:');
  {
    const { ctx } = run({ hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene', hieronymus_staff_token: 'TOK123' }, {});
    const url = await ctx.window.apiQuery('/api/geo-scan', {});
    check('apiQuery carries staffToken', url.includes('staffToken=TOK123'), url);
    check('no password on the wire', !url.includes('staffPassword'), url);
    const jobUrl = await ctx.window.apiQuery('/api/geo-scan-job', { company: 'Jeeves-Solutions' });
    check('company survives alongside it', jobUrl.includes('company=Jeeves-Solutions') && jobUrl.includes('staffToken=TOK123'), jobUrl);
  }

  console.log('\nA session with only a cached password (pre-token sign-in):');
  {
    const { ctx, local } = run({ hieronymus_internal_auth: 'true', hieronymus_internal_user: 'akore-rene' }, { geo_staff_password: 'hunter2' });
    const url = await ctx.window.apiQuery('/api/geo-scan', {});
    check('mints a token instead of sending the password', url.includes('staffToken=MINTED_TOKEN'), url);
    check('token was stored for next time', local.hieronymus_staff_token === 'MINTED_TOKEN', JSON.stringify(local));
  }

  console.log('\nA customer session (must be untouched):');
  {
    const { ctx } = run({}, { geo_portal_username: 'client-co', geo_portal_password: 'pw' });
    const url = await ctx.window.apiQuery('/api/results', { company: 'Client-Co' });
    check('client credentials still sent', url.includes('username=client-co') && url.includes('password=pw'), url);
    check('no staff credentials leak in', !url.includes('staff'), url);
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all assertions passed'));
  process.exit(failures ? 1 : 0);
})();
