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
  function writeLocal(k, v) {
    try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ }
  }

  const TOKEN_KEY = 'hieronymus_staff_token';
  let mintTried = false;

  // Exchanges a verified username and password for a session token, so the password itself never
  // has to be kept anywhere. Called wherever staff prove who they are — the portal login form and
  // the just-in-time password dialog both mint one, and from then on nothing asks again.
  window.staffSignIn = async function (username, password) {
    try {
      const res = await fetch('/api/staff-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !data.token) return false;
      writeLocal(TOKEN_KEY, data.token);
      return true;
    } catch (e) { return false; }
  };

  // Ends the session server-side as well, which a stored password could never do.
  window.staffSignOut = async function () {
    const token = readLocal(TOKEN_KEY);
    writeLocal(TOKEN_KEY, '');
    if (token) {
      try { await fetch('/api/staff-session?staffToken=' + encodeURIComponent(token), { method: 'DELETE' }); } catch (e) { /* offline */ }
    }
  };

  // Async because a persistent staff login (localStorage) can outlive the password cached for the
  // session (sessionStorage) — a browser restart leaves someone logged in with nothing to send. That
  // used to be invisible; now it would mean a blank dashboard, so ask for it just in time instead.
  window.resultsQuery = async function (company) {
    const params = new URLSearchParams();
    if (company) params.set('company', company);

    if (readLocal('hieronymus_internal_auth') === 'true') {
      const staffUser = readLocal('hieronymus_internal_user');

      // A token outlives the tab that minted it, so a staff member who is signed in is simply
      // signed in — no dialog in the middle of a task because sessionStorage happened to be empty.
      const staffToken = readLocal(TOKEN_KEY);
      if (staffToken) {
        if (staffUser) params.set('staffUsername', staffUser);
        params.set('staffToken', staffToken);
        return '/api/results?' + params.toString();
      }

      let staffPass = readSession(['geo_staff_password']);
      if (staffUser && !staffPass && window.__resultsAuthNoPrompt !== true && typeof window.requirePassword === 'function') {
        await window.requirePassword({
          title: 'Confirm your password',
          message: 'Your session needs your password again to load audit results.',
          username: staffUser
        });
        staffPass = readSession(['geo_staff_password']);
      }

      // Upgrade a password-only session in place. Tried once per page: a failed mint must not
      // turn a three-second poller into three requests a second.
      if (staffUser && staffPass && !mintTried) {
        mintTried = true;
        await window.staffSignIn(staffUser, staffPass);
        const minted = readLocal(TOKEN_KEY);
        if (minted) {
          params.set('staffUsername', staffUser);
          params.set('staffToken', minted);
          return '/api/results?' + params.toString();
        }
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

  // "Home" differs by who is looking: staff belong in the internal portal, a customer in their own.
  // Client-facing pages had no route home at all — the logo was inert and the intake form had no way
  // back — so a customer who opened a link was stranded on it.
  window.homeHref = function (company) {
    try {
      if (localStorage.getItem('hieronymus_internal_auth') === 'true') return '/portal.html';
    } catch (e) { /* private mode */ }
    let user = '';
    for (const k of ['geo_portal_username', 'geo_review_username', 'geo_intake_username']) {
      try { user = user || sessionStorage.getItem(k) || ''; } catch (e) { /* ignore */ }
    }
    if (!user && company) {
      user = String(company).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
    }
    return user ? '/client-portal.html?username=' + encodeURIComponent(user) : '/client-portal.html';
  };

  // Makes the logo a route home on every page that includes this script.
  window.wireLogoHome = function (company) {
    document.querySelectorAll('.logo').forEach(el => {
      if (el.dataset.homeWired) return;
      el.dataset.homeWired = '1';
      el.style.cursor = 'pointer';
      el.title = 'Akore Labs — Home';
      el.addEventListener('click', () => { location.href = window.homeHref(company); });
    });
  };
})();
