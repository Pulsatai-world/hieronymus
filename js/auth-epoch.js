// One-time forced sign-out, deliberately the FIRST script on every page.
//
// Two-factor is now required at every login. Existing sessions predate that, so leaving them alive
// would let everyone keep working — for up to 30 days on a staff token — without ever enrolling.
// This clears every stored session in the browser exactly once, then records that it has done so.
//
// It cannot live in results-auth.js: portal.html, index.html and intake-view.html read their session
// in an inline script that runs BEFORE results-auth.js loads, so the wipe would land one page load
// late on precisely the pages where staff are already signed in. Bump AUTH_EPOCH to force everyone
// out again in future.
(function () {
  const AUTH_EPOCH = '2026-08-28-2fa';
  const LOCAL = [
    'hieronymus_internal_auth', 'hieronymus_internal_user', 'hieronymus_internal_role',
    'hieronymus_staff_token', 'hieronymus_staff_tfa'
  ];
  const SESSION = [
    'geo_staff_password',
    'geo_portal_username', 'geo_portal_password',
    'geo_review_username', 'geo_review_password',
    'geo_intake_username', 'geo_intake_password',
    'geo_2fa_token'
  ];
  function mark(store) {
    try { store.setItem('hieronymus_auth_epoch', AUTH_EPOCH); return true; } catch (e) { return false; }
  }
  function marked(store) {
    try { return store.getItem('hieronymus_auth_epoch') === AUTH_EPOCH; } catch (e) { return false; }
  }
  try {
    // Either marker counts. Some browsers (private windows, storage blocked by a setting) allow
    // reads but throw on WRITING localStorage. With only the localStorage marker the wipe would
    // never record that it had run, so it fired on every page load — clearing the session the
    // customer had just used a code to establish, and logging them out on every navigation. The
    // sessionStorage fallback keeps it to at most once per tab.
    if (marked(localStorage) || marked(sessionStorage)) return;
    LOCAL.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    SESSION.forEach(function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } });
    if (!mark(localStorage)) mark(sessionStorage);
  } catch (e) { /* nothing readable or writable: the gate just asks again */ }
})();
