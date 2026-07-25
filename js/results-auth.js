// Shared credential builder for /api/results, which is scoped server-side. Staff pages send staff
// credentials; client pages send that customer's own login. A dashboard can be opened by either, so
// it tries staff first and falls back to the client session — whichever the visitor actually has.
// Nothing here grants access: the server verifies whatever is sent and refuses anything else.
(function () {
  function readSession(keys) {
    for (const k of keys) {
      try { const v = sessionStorage.getItem(k); if (v) return v; } catch (e) { /* private mode */ }
    }
    return '';
  }
  function readLocal(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }

  // Async because a persistent staff login (localStorage) can outlive the password cached for the
  // session (sessionStorage) — a browser restart leaves someone logged in with nothing to send. That
  // used to be invisible; now it would mean a blank dashboard, so ask for it just in time instead.
  window.resultsQuery = async function (company) {
    const params = new URLSearchParams();
    if (company) params.set('company', company);

    if (readLocal('hieronymus_internal_auth') === 'true') {
      const staffUser = readLocal('hieronymus_internal_user');
      let staffPass = readSession(['geo_staff_password']);
      if (staffUser && !staffPass && window.__resultsAuthNoPrompt !== true && typeof window.requirePassword === 'function') {
        await window.requirePassword({
          title: 'Confirm your password',
          message: 'Your session needs your password again to load audit results.',
          username: staffUser
        });
        staffPass = readSession(['geo_staff_password']);
      }
      if (staffUser && staffPass) {
        params.set('staffUsername', staffUser);
        params.set('staffPassword', staffPass);
        return '/api/results?' + params.toString();
      }
    }

    // Client session, from whichever client-facing page they logged in through.
    const user = readSession(['geo_portal_username', 'geo_review_username', 'geo_intake_username']);
    const pass = readSession(['geo_portal_password', 'geo_review_password', 'geo_intake_password']);
    if (user && pass) {
      params.set('username', user);
      params.set('password', pass);
    }
    return '/api/results?' + params.toString();
  };

  // Same credential resolution, for the intake endpoint. Kept alongside resultsQuery rather than
  // duplicated per page: both endpoints are scoped the same way and answer to the same sessions.
  window.intakeQuery = async function (company) {
    const url = await window.resultsQuery(company);
    return url.replace('/api/results?', '/api/intake?');
  };

  // Generic form: append whatever credentials this session has to any scoped endpoint. `prompt:false`
  // suppresses the just-in-time password dialog, which matters for pollers — a dialog every three
  // seconds would be unusable.
  window.apiQuery = async function (endpoint, params, opts) {
    const p = new URLSearchParams(params || {});
    const base = await window.resultsQuery('');
    const creds = new URLSearchParams(base.split('?')[1] || '');
    ['staffUsername', 'staffPassword', 'username', 'password'].forEach(k => {
      if (creds.get(k)) p.set(k, creds.get(k));
    });
    return endpoint + (p.toString() ? '?' + p.toString() : '');
  };
})();
