// Logging out of a client page did not log you out. Each page cleared only its OWN session keys, so
// opening another client link walked back into an authenticated session; and with a staff login in
// localStorage the staff bypass re-authenticated on the next page load, making logout impossible.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('js/results-auth.js', 'utf8');

function load(session, local) {
  const sess = { ...session }, loc = { ...local };
  const ctx = {
    sessionStorage: { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => sess[k] = String(v), removeItem: k => delete sess[k] },
    localStorage: { getItem: k => (k in loc ? loc[k] : null), setItem: (k, v) => loc[k] = String(v), removeItem: k => delete loc[k] },
    location: { pathname: '/client-portal.html', search: '?username=acme', href: '/client-portal.html?username=acme' },
    URLSearchParams, document: { querySelectorAll: () => [] }, fetch: async () => ({ ok: false }), console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, sess };
}

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '   -> ' + d)); if (!c) failures++; };

const ALL = {
  geo_portal_username: 'acme', geo_portal_password: 'p',
  geo_review_username: 'acme', geo_review_password: 'p',
  geo_intake_username: 'acme', geo_intake_password: 'p',
};

// Logging out of one page must end every client session, not just that page's.
let { ctx, sess } = load(ALL, {});
ctx.clientLogoutAll();
check('portal session cleared', !sess.geo_portal_username && !sess.geo_portal_password);
check('review session cleared too', !sess.geo_review_username && !sess.geo_review_password, JSON.stringify(sess));
check('intake session cleared too', !sess.geo_intake_username && !sess.geo_intake_password, JSON.stringify(sess));

// The staff bypass must not sign a logged-out visitor straight back in.
check('logout records that the bypass must not re-authenticate', sess.geo_bypass_suppressed === '1', JSON.stringify(sess));
check('clientBypassSuppressed reports it', ctx.clientBypassSuppressed() === true);

// ?username= must be dropped so a reload cannot re-seed the session from the URL.
check('the URL username is dropped on logout', ctx.location.href === '/client-portal.html', ctx.location.href);

// A deliberate login afterwards must work again — the suppression cannot be sticky.
ctx.clearBypassSuppression();
check('a deliberate login clears the suppression', ctx.clientBypassSuppressed() === false);

// A fresh visitor is not suppressed.
({ ctx } = load({}, {}));
check('a visitor who never logged out is not suppressed', ctx.clientBypassSuppressed() === false);

// Every client page must actually honour the flag, or the fix is cosmetic.
for (const page of ['client-portal.html', 'prompt-review.html', 'intake.html']) {
  const s = fs.readFileSync(page, 'utf8');
  check(page + ' bypass checks the suppression flag', /clientBypassSuppressed/.test(s), 'flag not consulted');
  check(page + ' logout delegates to the shared clearer', /clientLogoutAll/.test(s), 'still page-local');
}

console.log(failures ? '\n' + failures + ' FAILING' : '\nall green');
process.exit(failures ? 1 : 0);
