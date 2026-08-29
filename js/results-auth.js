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
  const STAFF_TFA_KEY = 'hieronymus_staff_tfa';
  window.rememberStaffTfaToken = function (token) { if (token) writeLocal(STAFF_TFA_KEY, token); };

  let mintTried = false;

  // Exchanges a verified username and password for a session token, so the password itself never
  // has to be kept anywhere. Called wherever staff prove who they are — the portal login form and
  // the just-in-time password dialog both mint one, and from then on nothing asks again.
  // Returns true on success. When the account has an authenticator enrolled and no code was given
  // (or the code was wrong), returns a descriptive object instead so the caller can ask for one —
  // callers that only test truthiness still correctly treat that as "not signed in".
  window.staffSignIn = async function (username, password, code) {
    try {
      const res = await fetch('/api/staff-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username, password: password, code: code || '',
          // A two-factor token from this browser's earlier login means no second code is needed.
          tfToken: readLocal(STAFF_TFA_KEY) || ''
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        if (data && data.needsCode) return { needsCode: true, error: data.error || '', locked: res.status === 429 };
        return false;
      }
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

  // ── The internal staff gate login ──
  // portal.html, index.html and intake-view.html all showed the same gate and carried three
  // byte-identical copies of this logic. Two-factor would have made that three copies of a security
  // decision, so it lives here once. Returns a plain result; the pages only decide where to go next.
  //
  //   { ok: true, data }                  signed in
  //   { needsCode: true, locked, error }  correct password, waiting on a 6-digit code
  //   { cancelled: true }                 enrollment dialog dismissed
  //   { ok: false }                       wrong username or password
  window.staffGateLogin = async function (username, password, code, lang) {
    function loginUrl() {
      let u = '/api/staff-users?username=' + encodeURIComponent(username)
        + '&password=' + encodeURIComponent(password);
      const held = readLocal(STAFF_TFA_KEY);
      if (held) u += '&tfToken=' + encodeURIComponent(held);
      if (code) u += '&code=' + encodeURIComponent(String(code).replace(/\D/g, ''));
      return u;
    }

    let res = await fetch(loginUrl());
    let body = res.ok ? null : await res.json().catch(function () { return {}; });

    // First visit to a brand-new install: no staff accounts exist at all, so the first person to
    // arrive becomes the founding admin rather than being told their password is wrong. Only
    // attempted when the account genuinely does not exist — a two-factor refusal means it does.
    if (!res.ok && !(body && (body.needsEnrollment || body.needsCode))) {
      const listData = await fetch('/api/staff-users').then(function (r) { return r.json(); }).catch(function () { return { items: [] }; });
      if ((listData.items || []).length === 0) {
        const createRes = await fetch('/api/staff-users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username, password: password, role: 'admin' })
        });
        if (!createRes.ok) {
          const createData = await createRes.json().catch(function () { return {}; });
          return { ok: false, error: createData.error || '' };
        }
        res = await fetch(loginUrl());
        body = res.ok ? null : await res.json().catch(function () { return {}; });
      }
    }

    // Two-factor is required for every staff login, so a fresh account — including the founding
    // admin just created above — is sent through setup before it can get in.
    if (!res.ok && body && body.needsEnrollment) {
      if (typeof window.startTwoFactorSetup !== 'function') return { ok: false };
      const done = await window.startTwoFactorSetup({ username: username, password: password, lang: lang, audience: 'staff' });
      if (!done) return { cancelled: true };
      return await window.staffGateLogin(username, password, '', lang);   // the new token gets it in
    }
    if (!res.ok && body && (body.needsCode || res.status === 429)) {
      return { needsCode: true, locked: res.status === 429, error: body.error || '' };
    }
    if (!res.ok) return { ok: false };

    const data = await res.json().catch(function () { return null; });
    if (!data) return { ok: false };
    if (data.tfToken) writeLocal(STAFF_TFA_KEY, data.tfToken);
    return { ok: true, data: data };
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
    // Copy every credential resultsQuery produced. This used to be an allow-list of four names,
    // which silently dropped the staffToken when tokens were introduced and sent a username with
    // no credential behind it. resultsQuery returns credentials and the company only, and company
    // is passed empty here, so there is nothing to filter out.
    creds.forEach((value, key) => { if (value) p.set(key, value); });
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

  // Logout was per-page and therefore broken. Each client page cleared only its OWN key pair, so
  // signing out of the portal left the review and intake sessions intact — opening another client
  // link walked straight back into an authenticated session. And for anyone with a staff login in
  // localStorage, the staff bypass re-authenticated on the very next page load, making logout
  // impossible. Both are fixed here: every client session key is cleared, and a suppression flag
  // stops the bypass from silently signing them back in until they deliberately log in again.
  const CLIENT_SESSION_KEYS = [
    'geo_portal_username', 'geo_portal_password',
    'geo_review_username', 'geo_review_password',
    'geo_intake_username', 'geo_intake_password',
    // Logging out has to surrender the two-factor session too, or the next visitor in the same tab
    // reaches the account with a password alone.
    'geo_2fa_token',
  ];
  window.clientLogoutAll = function () {
    CLIENT_SESSION_KEYS.forEach(k => { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } });
    try { sessionStorage.setItem('geo_bypass_suppressed', '1'); } catch (e) { /* ignore */ }
    // Drop ?username= so a reload cannot re-seed the session from the URL.
    location.href = location.pathname;
  };

  // The single customer login call. All three client-facing pages re-validate through the same
  // endpoint on load, so the two-factor token is held here and replayed automatically — otherwise a
  // customer would type a fresh code walking from the intake form to their dashboard.
  const TFA_TOKEN_KEY = 'geo_2fa_token';
  window.clientLogin = async function (username, password, code) {
    let url = '/api/intake-codes?username=' + encodeURIComponent(username)
      + '&password=' + encodeURIComponent(password);
    const held = readSession([TFA_TOKEN_KEY]);
    if (held) url += '&tfToken=' + encodeURIComponent(held);
    if (code) url += '&code=' + encodeURIComponent(String(code).replace(/\D/g, ''));
    let res, data;
    try {
      res = await fetch(url);
      data = await res.json().catch(function () { return {}; });
    } catch (e) {
      return { ok: false, error: '' };
    }
    if (res.ok) {
      if (data && data.tfToken) { try { sessionStorage.setItem(TFA_TOKEN_KEY, data.tfToken); } catch (e) { /* private mode */ } }
      return { ok: true, data: data || {} };
    }
    return {
      ok: false,
      needsCode: !!(data && data.needsCode),
      locked: res.status === 429,
      error: (data && data.error) || ''
    };
  };

  // Reveals the six-digit field on a client gate and returns the message to show beside it. All
  // three client pages use the same markup, so this lives here once rather than three times. The
  // wording is built locally instead of echoing the server's English so both languages read right.
  window.showGateCode = function (attempt, lang, hadCode) {
    const el = document.getElementById('gate-code-input');
    if (el) {
      el.style.display = '';
      el.value = '';
      setTimeout(function () { try { el.focus(); } catch (e) { /* ignore */ } }, 0);
    }
    const es = lang === 'es';
    if (attempt && attempt.locked) {
      const m = /(\d+)/.exec(attempt.error || '');
      const mins = m ? m[1] : '15';
      return es
        ? 'Demasiados códigos incorrectos. Intenta de nuevo en ' + mins + ' minutos.'
        : 'Too many incorrect codes. Try again in ' + mins + ' minutes.';
    }
    if (hadCode) {
      return es
        ? 'Código incorrecto. Verifica la hora de tu teléfono e intenta con el siguiente código.'
        : 'Incorrect code. Check your phone\u2019s clock and try the next code.';
    }
    return es
      ? 'Ingresa el código de 6 dígitos de tu app de autenticación.'
      : 'Enter the 6-digit code from your authenticator app.';
  };

  // True when the visitor has just logged out of a client page. The staff bypass must honour this or
  // logout does nothing for staff.
  window.clientBypassSuppressed = function () {
    try { return sessionStorage.getItem('geo_bypass_suppressed') === '1'; } catch (e) { return false; }
  };
  window.clearBypassSuppression = function () {
    try { sessionStorage.removeItem('geo_bypass_suppressed'); } catch (e) { /* ignore */ }
  };
})();
