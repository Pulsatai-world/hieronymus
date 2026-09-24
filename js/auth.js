// Everything the browser knows about being signed in.
//
// One stored value: a session token. No password is kept, no flag stands in for being signed in, no
// second token exists alongside it. Every previous shape of this file accumulated another concept —
// a cached password, a "two-factor ticket", a localStorage boolean that granted access on its own —
// and each new rule had to be taught all of them.
//
//   window.akoreAuth.restore()                     am I signed in? -> who, or null
//   window.akoreAuth.login(user, pass, code)       sign in
//   window.akoreAuth.logout(destination)           sign out, everywhere
//   window.akoreAuth.who()                         the last payload, in memory
//   window.akoreAuth.apiUrl(endpoint, params)      a URL carrying the session
//   window.akoreAuth.confirmPassword(opts)         re-confirm a password mid-session
//   window.akoreAuth.enroll(user, pass, lang)      the setup dialog (QR), resolves to who
//
// Staff keep their session in localStorage so opening a customer page in a new tab does not ask
// again. Customers keep theirs in sessionStorage so closing the browser ends it — a shared or
// borrowed machine should not stay signed in to somebody's audit.

(function () {
  const STAFF_KEY = 'akore_staff_session';
  const CLIENT_KEY = 'akore_client_session';

  // Which store a page uses. Internal pages set this to 'staff' before calling anything; the
  // client-facing pages leave it alone.
  let audience = 'client';
  let current = null;                  // the last who-payload, in memory only

  function readStore(key, session) {
    try { return (session ? sessionStorage : localStorage).getItem(key) || ''; } catch (e) { return ''; }
  }
  function writeStore(key, value, session) {
    try {
      const s = session ? sessionStorage : localStorage;
      if (value) s.setItem(key, value); else s.removeItem(key);
    } catch (e) { /* storage unavailable: the gate simply asks again */ }
  }

  function token() {
    return audience === 'staff' ? readStore(STAFF_KEY, false) : readStore(CLIENT_KEY, true);
  }
  function setToken(value) {
    if (audience === 'staff') writeStore(STAFF_KEY, value, false);
    else writeStore(CLIENT_KEY, value, true);
  }

  async function postJson(endpoint, payload) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(function () { return {}; });
      return { res: res, data: data || {} };
    } catch (e) {
      return { res: null, data: {} };
    }
  }

  // One login at a time. The gates fire from three places — the button, Enter in the password field,
  // Enter in the code field — and two logins running together used to mean two setups started, two
  // QR codes issued, and only one of them usable.
  let loginInFlight = null;

  const api = {
    /** Called by internal pages before anything else. */
    useStaffSession: function () { audience = 'staff'; },

    who: function () { return current; },
    session: token,
    isSignedIn: function () { return !!current; },

    /**
     * Is this browser signed in? Asks the server, because a value in storage proves nothing — a
     * stored flag once granted access to the internal pages indefinitely, with no code ever asked
     * for again.
     *
     * Resolves to the who-payload, or null. Clears a session the server no longer recognises.
     */
    restore: async function () {
      const held = token();
      if (!held) { current = null; return null; }
      let res, data;
      try {
        res = await fetch('/api/login?session=' + encodeURIComponent(held));
        data = await res.json().catch(function () { return {}; });
      } catch (e) {
        // Offline. Report not-signed-in rather than guessing; every endpoint checks the session
        // itself, so nothing is protected by this answer alone.
        current = null;
        return null;
      }
      if (res.ok && data && data.username) { current = data; return current; }
      setToken('');
      current = null;
      return null;
    },

    /**
     * Sign in. Always requires a code once the account has an authenticator.
     *
     * Returns one of:
     *   { ok: true, who }
     *   { needsCode: true, locked, error }        password right, code required
     *   { needsEnrollment: true }                 no authenticator yet — call enroll()
     *   { ok: false, error }                      wrong username or password
     */
    login: function (username, password, code) {
      const key = String(username) + '\x00' + String(code || '');
      if (loginInFlight && loginInFlight.key === key) return loginInFlight.promise;
      const promise = (async function () {
        const { res, data } = await postJson('/api/login', {
          username: username, password: password, code: code || ''
        });
        if (!res) return { ok: false, offline: true, error: '' };
        if (res.ok && data.session) {
          setToken(data.session);
          current = data;
          return { ok: true, who: data };
        }
        return {
          ok: false,
          needsEnrollment: !!data.needsEnrollment,
          needsCode: !!data.needsCode,
          locked: res.status === 429,
          error: data.error || ''
        };
      })();
      loginInFlight = { key: key, promise: promise };
      const clear = function () { if (loginInFlight && loginInFlight.key === key) loginInFlight = null; };
      promise.then(clear, clear);
      return promise;
    },

    /** Ends the session on the server as well, so signing out really signs out. */
    logout: async function (destination) {
      const held = token();
      setToken('');
      current = null;
      if (held) {
        try { await fetch('/api/login?session=' + encodeURIComponent(held), { method: 'DELETE' }); } catch (e) { /* offline */ }
      }
      if (destination === false) return;
      if (destination === 'reload') location.reload();
      else location.href = destination || '/portal.html';
    },

    /** Appends the session to any endpoint. The only credential a data request ever carries. */
    apiUrl: function (endpoint, params) {
      const p = new URLSearchParams(params || {});
      const held = token();
      if (held) p.set('session', held);
      const qs = p.toString();
      return endpoint + (qs ? '?' + qs : '');
    },

    /**
     * Re-confirms the password of the person already signed in, for a destructive action. Password
     * only — no code. Resolves true or false.
     */
    confirmPassword: async function (password) {
      const { res, data } = await postJson('/api/confirm-password', {
        session: token(), password: password
      });
      return !!(res && res.ok && data && data.ok === true);
    }
  };

  // ── What the pages call ──
  // These are the browser-facing API. They used to be spread over three files that each held their
  // own idea of what a credential was; they are all one thing now, expressed once.

  /** Any scoped endpoint, carrying the session. The only credential a data request ever sends. */
  window.apiQuery = async function (endpoint, params) { return api.apiUrl(endpoint, params); };
  window.resultsQuery = async function (company) { return api.apiUrl('/api/results', company ? { company } : {}); };
  window.intakeQuery = async function (company) { return api.apiUrl('/api/intake', company ? { company } : {}); };

  /** Signing out, from anywhere. Ends the session on the server too. */
  window.staffLogoutAll = function (destination) { return api.logout(destination || 'reload'); };
  window.clientLogoutAll = function () {
    // Under a staff bypass there is no customer session to end; the token in play is the staff one.
    // Ending it here would sign the staff member out everywhere, from a page they were only
    // inspecting. Leaving the view is the only thing this can honestly mean.
    const who = api.who();
    if (who && who.staffBypass) {
      const href = '/index.html?company=' + encodeURIComponent(who.company || '');
      current = null;
      // Returns the destination it chose, the same way akoreLand does, so the decision can be
      // checked without a real navigation.
      try { location.href = href; } catch (e) { /* a browser that refused; the answer stands */ }
      return Promise.resolve(href);
    }
    return api.logout(location.pathname);
  };

  /**
   * "Home" differs by who is looking: staff belong in the internal portal, a customer in their own.
   * Anyone we cannot place gets no link rather than a guess, and a customer is never shown a route
   * into an internal page.
   */
  window.homeHref = function (company) {
    const who = api.who();
    // Staff viewing a customer's page belong back on that customer's internal page, not in the
    // customer's own portal, which is somewhere they have no business being sent.
    if (who && who.staffBypass) {
      return '/index.html?company=' + encodeURIComponent(who.company || company || '');
    }
    if (who && who.kind === 'staff') return '/portal.html';
    if (who && who.kind === 'customer' && who.username) {
      return '/client-portal.html?username=' + encodeURIComponent(who.username);
    }
    return '';
  };
  // The one sign-in page. Every other page sends people here rather than growing a form of its
  // own — there were six, each with its own strings, its own markup and its own idea of what to do
  // with the answer, which is how one of them ended up filing a customer under the staff key.
  const LOGIN_PAGE = '/login.html';

  // Internal pages. A customer sent to one of these by ?next= would only be bounced straight back
  // out, so it is ignored for them rather than obeyed and then undone.
  const INTERNAL_PAGES = ['/portal.html', '/index.html', '/intake-view.html', '/geo-report.html'];

  /**
   * A destination is only honoured if it is a path on this site. "/portal.html" yes; "//evil.test"
   * and "https://evil.test" no — a ?next= that can point anywhere turns the sign-in into an open
   * redirect, where a link that genuinely starts on our domain lands on someone else's.
   */
  function safeNext(value) {
    const v = String(value || '');
    // Tabs, newlines and carriage returns are removed by the URL parser BEFORE it parses, so
    // "/\t/evil.test" is checked here as a path and then resolved as "//evil.test" — a scheme-
    // relative URL to someone else's host. Checking only the first character missed it, and the
    // test that covered this used "/\tevil", which happens to stay on-site. Reject any control
    // character or backslash anywhere, then require a single leading slash.
    if (/[\u0000-\u001f\u007f\\]/.test(v)) return '';
    return /^\/[^/]/.test(v) ? v : '';
  }

  /** Send someone to the sign-in page, remembering where they were trying to get to. */
  window.akoreGoToLogin = function () {
    const here = location.pathname + location.search;
    location.replace(LOGIN_PAGE + '?next=' + encodeURIComponent(here));
  };

  /**
   * Files a session under the key that matches who owns it, then sends them where they belong.
   *
   * Which store a session goes in is a property of the person, not of the page they happened to
   * sign in on. The internal pages call useStaffSession() before anything else, so a customer who
   * signed in on one had their session written to the STAFF key. The internal pages then saw a live
   * session and rendered the staff shell, every data call was refused for not being staff, and the
   * customer's own portal could not find them at all — it reads a different key. That is what the
   * website's "log in" button did to every customer who used it: not a broken portal, the wrong
   * door, with the session filed in the wrong drawer on the way through.
   */
  window.akoreLand = function (who, next) {
    const person = who || current;
    if (!person) { location.reload(); return ''; }
    const session = token();              // read before the audience moves
    writeStore(STAFF_KEY, '', false);
    writeStore(CLIENT_KEY, '', true);
    audience = person.kind === 'staff' ? 'staff' : 'client';
    current = person;
    setToken(session);

    const home = window.homeHref();
    // Where they were headed, if they may go there; otherwise where they belong.
    const wanted = safeNext(next);
    const page = wanted.split('?')[0];
    const mayGo = wanted && (person.kind === 'staff' || INTERNAL_PAGES.indexOf(page) === -1);
    const href = mayGo ? wanted : home;

    // Returns the destination it chose, so the decision can be checked without a real navigation.
    if (!href) { location.reload(); return location.pathname; }
    try {
      if (href.split('?')[0] === location.pathname) location.reload();
      else location.href = href;
    } catch (e) { /* a browser that refused the navigation; the answer is still the answer */ }
    return href;
  };

  /**
   * The gate on an internal page — answers for staff and nobody else.
   *
   * A customer's credentials are perfectly valid; they are valid for somewhere else. Returns
   * { ok } when a staff session is live, { redirecting } when someone signed in who belongs
   * elsewhere and is being sent there, and neither when the page should show its sign-in form.
   */
  window.akoreRequireStaff = async function () {
    const who = await api.restore();
    if (who && who.kind === 'staff') return { ok: true, who: who };
    if (who) { window.akoreLand(who); return { ok: false, redirecting: true }; }
    return { ok: false, redirecting: false };
  };

  window.wireLogoHome = function (company) {
    const href = window.homeHref(company);
    if (!href) return;
    document.querySelectorAll('[data-logo-home], .logo, .logo-wrap').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () { location.href = href; });
    });
  };

  // ── The password confirmation dialog ──
  // Shown before a destructive or outward-facing staff action: run an audit, release a dashboard,
  // clear results, delete a customer, replace an engine key. It asks for a password and nothing
  // else — the code belongs at the door, not on every step behind it.
  function dialogStyles() {
    if (document.getElementById('akore-pw-styles')) return;
    const el = document.createElement('style');
    el.id = 'akore-pw-styles';
    el.textContent = [
      '.apw-back{position:fixed;inset:0;background:rgba(8,9,12,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px 16px;}',
      '.apw-card{background:#fff;color:#08090c;border-radius:14px;max-width:400px;width:100%;padding:24px;box-shadow:0 18px 50px rgba(8,9,12,.28);font-family:inherit;}',
      '.apw-card h4{margin:0 0 8px;font-size:17px;font-weight:650;}',
      '.apw-msg{font-size:13px;line-height:1.55;color:#3d4653;margin:0 0 16px;}',
      '.apw-in{width:100%;box-sizing:border-box;padding:11px;border:1px solid #e3e6ea;border-radius:9px;font-size:14px;font-family:inherit;}',
      '.apw-in:focus{outline:none;border-color:#6d4fe0;box-shadow:0 0 0 3px rgba(109,79,224,.14);}',
      '.apw-err{font-size:12.5px;color:#b03a3a;min-height:17px;margin-top:8px;}',
      '.apw-row{display:flex;gap:9px;margin-top:12px;}',
      '.apw-go{flex:1;border:none;background:#6d4fe0;color:#fff;border-radius:9px;padding:11px;font-size:13.5px;font-weight:650;cursor:pointer;font-family:inherit;}',
      '.apw-go[disabled]{opacity:.55;cursor:default;}',
      '.apw-x{border:1px solid #e3e6ea;background:#fff;color:#757f8f;border-radius:9px;padding:11px 15px;font-size:13px;cursor:pointer;font-family:inherit;}'
    ].join('');
    document.head.appendChild(el);
  }

  window.requirePassword = function (opts) {
    const o = opts || {};
    const es = (function () {
      try { return (localStorage.getItem('hieronymus_lang') || 'es') === 'es'; } catch (e) { return true; }
    })();
    const labels = o.labels || {};
    const L = {
      enter: labels.enter || (es ? 'Tu contraseña' : 'Your password'),
      confirm: labels.confirm || (es ? 'Confirmar' : 'Confirm'),
      cancel: labels.cancel || (es ? 'Cancelar' : 'Cancel'),
      wrong: labels.wrong || (es ? 'La contraseña no es correcta.' : 'That password is not correct.'),
      signedOut: es ? 'Tu sesión terminó. Inicia sesión de nuevo.' : 'Your session has ended. Sign in again.'
    };
    dialogStyles();

    return new Promise(function (resolve) {
      const back = document.createElement('div');
      back.className = 'apw-back';
      back.innerHTML = '<div class="apw-card" role="dialog" aria-modal="true">'
        + '<h4></h4><p class="apw-msg"></p>'
        + '<input class="apw-in" type="password" autocomplete="current-password">'
        + '<div class="apw-err"></div>'
        + '<div class="apw-row"><button type="button" class="apw-go"></button><button type="button" class="apw-x"></button></div>'
        + '</div>';
      document.body.appendChild(back);
      const q = sel => back.querySelector(sel);
      q('h4').textContent = o.title || L.confirm;
      q('.apw-msg').textContent = o.message || '';
      q('.apw-in').placeholder = L.enter;
      q('.apw-go').textContent = L.confirm;
      q('.apw-x').textContent = L.cancel;

      function done(v) { try { back.remove(); } catch (e) {} resolve(v); }
      q('.apw-x').onclick = function () { done(false); };

      let busy = false;
      async function submit() {
        if (busy) return;
        const pw = q('.apw-in').value;
        if (!pw) { q('.apw-in').focus(); return; }
        busy = true;
        q('.apw-go').disabled = true;
        const ok = await api.confirmPassword(pw);
        if (ok) { done(true); return; }
        // A refusal here is either a wrong password or a session that has ended; say which.
        q('.apw-err').textContent = api.session() ? L.wrong : L.signedOut;
        q('.apw-in').value = '';
        q('.apw-in').focus();
        busy = false;
        q('.apw-go').disabled = false;
      }
      q('.apw-go').onclick = submit;
      q('.apw-in').onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      setTimeout(function () { try { q('.apw-in').focus(); } catch (e) {} }, 50);
    });
  };

  // ── The gate ──
  // Every page's sign-in form calls this. It handles the three answers a login can give: in,
  // needs a code, or needs an authenticator set up first.
  //
  // Returns { ok, who } | { needsCode, locked, error } | { cancelled } | { ok: false, error }
  window.akoreSignIn = async function (username, password, code, lang) {
    const attempt = await api.login(username, password, code);
    if (attempt.ok) return attempt;
    if (attempt.needsEnrollment) {
      if (typeof window.akoreEnroll !== 'function') return { ok: false, error: '' };
      const who = await window.akoreEnroll(username, password, lang);
      if (!who) return { cancelled: true };
      // Enrolling ends signed in: the endpoint returned a session because a password and a live code
      // were both just proved. No second round trip, and nothing to get wrong in between.
      setToken(who.session);
      current = who;
      return { ok: true, who: who };
    }
    return attempt;
  };

  /**
   * Reads whatever was typed into a gate's code field: six digits from the app, or a recovery code.
   *
   * Every gate used to do `value.replace(/\D/g, '')` for itself. That is correct for an
   * authenticator code and destroys a recovery code, which has letters — it would have arrived at
   * the server as a handful of stray digits and been refused, on the one credential someone falls
   * back on when they have nothing else.
   */
  window.akoreCodeValue = function (el) {
    if (!el) return '';
    const raw = String(el.value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length <= 6 && !/[A-Za-z]/.test(raw)) return digits;   // an authenticator code
    return raw.toUpperCase().replace(/[^0-9A-Z-]/g, '');              // a recovery code
  };

  /** Reveals a page's 6-digit field and returns the message to show beside it, in both languages. */
  window.showGateCode = function (attempt, lang, hadCode) {
    const el = document.getElementById('gate-code-input') || document.getElementById('code-input');
    if (el) {
      el.style.display = '';
      el.value = '';
      setTimeout(function () { try { el.focus(); } catch (e) {} }, 0);
    }
    const es = lang === 'es';
    if (attempt && attempt.locked) {
      const m = /(\d+)/.exec(attempt.error || '');
      const mins = m ? m[1] : '15';
      return es ? 'Demasiados códigos incorrectos. Intenta de nuevo en ' + mins + ' minutos.'
                : 'Too many incorrect codes. Try again in ' + mins + ' minutes.';
    }
    if (hadCode) {
      return es ? 'Código incorrecto. Intenta con el siguiente código que muestre la app, o usa un código de recuperación.'
                : 'Incorrect code. Try the next code the app shows, or use a recovery code.';
    }
    return es ? 'Ingresa el código de 6 dígitos de tu app de autenticación, o uno de tus códigos de recuperación.'
              : 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.';
  };

  /**
   * The bar shown when staff are looking at a customer's page.
   *
   * Without it the page is indistinguishable from the customer's own: same chrome, same buttons,
   * their company name in the corner. A staff member pressed "preview as client", landed on a page
   * offering "my portal" and "log out", and had no way to tell whose portal or whose session those
   * meant. It is drawn here rather than in each of the three client pages so it cannot be added to
   * two of them and forgotten on the third.
   */
  function showBypassBar(who) {
    try {
      if (document.getElementById('akore-bypass-bar')) return;
      const es = (function () {
        try { return (localStorage.getItem('hieronymus_lang') || 'es') === 'es'; } catch (e) { return true; }
      })();
      const preview = new URLSearchParams(location.search).get('preview') === 'draft';

      const bar = document.createElement('div');
      bar.id = 'akore-bypass-bar';
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;display:flex;align-items:center;gap:12px;'
        + 'flex-wrap:wrap;padding:9px 16px;background:#2b2440;color:#fff;font-size:13px;'
        + 'font-family:inherit;line-height:1.45;box-shadow:0 1px 6px rgba(0,0,0,.18);';

      const text = document.createElement('span');
      text.style.cssText = 'flex:1;min-width:200px;';
      const company = who && who.company ? who.company : '';
      text.textContent = preview
        ? (es ? 'Vista previa del formulario de ' + company + '. Así lo verá el cliente. Todavía no está publicado y aquí no se guarda nada.'
              : 'Preview of ' + company + "'s form. This is what the client will see. It is not published yet, and nothing is saved here.")
        : (es ? 'Estás viendo la página de ' + company + ' como personal de Akore.'
              : "You are viewing " + company + "'s page as Akore staff.");
      bar.appendChild(text);

      const back = document.createElement('a');
      back.href = '/index.html?company=' + encodeURIComponent(company);
      back.textContent = es ? 'Volver al cliente' : 'Back to the customer';
      back.style.cssText = 'color:#fff;background:rgba(255,255,255,.14);border-radius:999px;'
        + 'padding:5px 12px;text-decoration:none;white-space:nowrap;font-weight:600;';
      bar.appendChild(back);

      const put = () => document.body && document.body.insertBefore(bar, document.body.firstChild);
      if (document.body) put();
      else document.addEventListener('DOMContentLoaded', put);
    } catch (e) { /* the bar is a courtesy; never let it stop the page */ }
  }

  /** True when this page is being viewed by staff standing in for a customer. */
  window.akoreIsStaffBypass = function () {
    const who = api.who();
    return !!(who && who.staffBypass);
  };

  /**
   * Staff opening a customer's page. Uses the staff session already in this browser and asks the
   * server for that customer's payload; nothing is issued, and the staff session stays the
   * credential for every request the page then makes.
   */
  window.akoreStaffBypass = async function (username) {
    const staff = readStore(STAFF_KEY, false);
    if (!staff || !username) return null;
    try {
      const res = await fetch('/api/login?session=' + encodeURIComponent(staff)
        + '&as=' + encodeURIComponent(username));
      if (!res.ok) return null;
      const who = await res.json();
      if (!who || !who.company) return null;
      // Read the staff session from now on, not the (absent) customer one.
      audience = 'staff';
      current = Object.assign({}, who, { staffBypass: true });
      // Every page this can open is a CLIENT page, drawn for the person whose data it shows. Left
      // unmarked, a staff member is handed a customer's chrome: "my portal" takes them to that
      // customer's portal, and "log out" is far worse than it looks — the session being held here is
      // the STAFF one, so the button revokes it on the server and signs them out of the whole
      // platform, in every tab, from a page they only meant to look at.
      showBypassBar(current);
      return current;
    } catch (e) { return null; }
  };

  /**
   * For pages either kind of person can open — the dashboards. Tries a staff session first, then a
   * customer one, and leaves `audience` pointing at whichever answered so every later request uses
   * the right session.
   */
  window.akoreRestoreEither = async function () {
    audience = 'staff';
    let who = await api.restore();
    if (who) return who;
    audience = 'client';
    who = await api.restore();
    return who;
  };

  window.akoreAuth = api;
})();
