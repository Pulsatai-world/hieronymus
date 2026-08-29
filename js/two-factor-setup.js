// Two-factor enrollment, shared by every login in the platform: the internal Portal and all three
// client-facing pages. One implementation on purpose — four bespoke copies of a security dialog is
// how they drift apart.
//
// Called when a login answers `needsEnrollment`. It walks the person through adding the account to
// an authenticator app, confirms a live code, and resolves once two-factor is on. The token the
// server issues on confirmation is stored where that page's login will find it, so finishing setup
// drops them straight in instead of asking for a second code.
//
// The QR is drawn by our own endpoint and delivered in the enrollment response, never fetched from a
// QR service — the usual shortcut of an external image URL would hand the shared secret to whoever
// runs that service. The typed setup key is still there underneath, because a QR is no use on a
// desktop password manager, to someone without a working camera, or when the image fails to load.
(function () {
  const T = {
    title:      { en: 'Set up two-step verification', es: 'Activa la verificación en dos pasos' },
    intro:      { en: 'From now on your account needs a code from an authenticator app as well as your password. This takes about a minute and you only do it once.',
                  es: 'A partir de ahora tu cuenta necesita un código de una app de autenticación, además de tu contraseña. Toma menos de un minuto y solo se hace una vez.' },
    step1:      { en: '1. Install an authenticator app', es: '1. Instala una app de autenticación' },
    step1body:  { en: "If you don't have one, Google Authenticator or Microsoft Authenticator are free and work fine. If you use a password manager like 1Password, it can do this too.",
                  es: 'Si no tienes una, Google Authenticator o Microsoft Authenticator son gratuitas y funcionan bien. Si usas un gestor de contraseñas como 1Password, también sirve.' },
    step2:      { en: '2. Scan this with the app', es: '2. Escanea esto con la app' },
    step2body:  { en: 'In the app choose "Add account", then "Scan a QR code", and point your camera here.',
                  es: 'En la app elige «Agregar cuenta» y luego «Escanear código QR», y apunta la cámara aquí.' },
    manualToggle: { en: "Can't scan it? Enter the key by hand", es: '¿No puedes escanearla? Ingresa la clave a mano' },
    manualBody: { en: 'In the app choose "Enter a setup key" instead, and use this:',
                  es: 'En la app elige «Ingresar una clave de configuración» y usa esta:' },
    copy:       { en: 'Copy key', es: 'Copiar clave' },
    copied:     { en: 'Copied', es: 'Copiada' },
    keep:       { en: 'This code is only shown while you set it up. If you lose your phone, ask us to reset it for you.',
                  es: 'Este código solo se muestra durante la configuración. Si pierdes tu teléfono, pídenos que lo restablezcamos.' },
    step3:      { en: '3. Enter the 6-digit code the app shows', es: '3. Escribe el código de 6 dígitos que muestra la app' },
    codePlace:  { en: '000000', es: '000000' },
    enable:     { en: 'Turn on and continue', es: 'Activar y continuar' },
    working:    { en: 'Checking…', es: 'Verificando…' },
    cancel:     { en: 'Cancel', es: 'Cancelar' },
    badCode:    { en: "That code didn't match. Check that your phone's clock is set automatically, then try the next code the app shows.",
                  es: 'El código no coincide. Revisa que la hora de tu teléfono esté en automático e intenta con el siguiente código que muestre la app.' },
    needSix:    { en: 'Enter all 6 digits.', es: 'Escribe los 6 dígitos.' },
    // Every message here is written in both languages. Nothing pastes the server's own wording into
    // a sentence: the server speaks English, so doing that produced half-Spanish half-English text
    // in front of a customer. Conditions are translated; only a status number is ever interpolated,
    // because a number reads the same in both.
    // Reaching this during setup means the account became enrolled while this dialog was open — the
    // setup very likely already completed. Telling them to ask an admin is unhelpful when reloading
    // and signing in is what actually resolves it.
    alreadySet: { en: 'This setup is out of date — the account is already set up. Close this, reload the page and sign in again.',
                  es: 'Esta configuración quedó desactualizada — la cuenta ya está configurada. Cierra esto, recarga la página e inicia sesión de nuevo.' },
    wrongPass:  { en: 'That password is not correct.', es: 'La contraseña no es correcta.' },
    expiredSet: { en: 'This setup timed out. Press "Try again" to start over.',
                  es: 'Esta configuración expiró. Presiona «Intentar de nuevo» para empezar otra vez.' },
    noConnect:  { en: 'Could not reach the server. Check your connection and try again.',
                  es: 'No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.' },
    serverSaid: { en: 'The server could not do this ({code}). Try again — if it keeps happening, send us that number.',
                  es: 'El servidor no pudo hacer esto ({code}). Intenta de nuevo — si sigue pasando, envíanos ese número.' },
    retry:      { en: 'Try again', es: 'Intentar de nuevo' },
    tooMany:    { en: 'Too many incorrect codes. Wait a few minutes and try again.', es: 'Demasiados códigos incorrectos. Espera unos minutos e intenta de nuevo.' }
  };

  function injectStyles() {
    if (document.getElementById('tfa-setup-styles')) return;
    const el = document.createElement('style');
    el.id = 'tfa-setup-styles';
    el.textContent = [
      '.tfa-backdrop{position:fixed;inset:0;background:rgba(8,9,12,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;}',
      '.tfa-card{background:#fff;color:#08090c;border-radius:14px;max-width:460px;width:100%;padding:26px 26px 22px;box-shadow:0 18px 50px rgba(8,9,12,.28);font-family:inherit;margin:auto;}',
      '.tfa-card h3{margin:0 0 8px;font-size:19px;font-weight:650;letter-spacing:-.2px;}',
      '.tfa-intro{font-size:13.5px;line-height:1.55;color:#3d4653;margin:0 0 20px;}',
      '.tfa-step{margin-bottom:18px;}',
      '.tfa-step-h{font-size:13px;font-weight:650;margin-bottom:5px;color:#08090c;}',
      '.tfa-step-b{font-size:12.5px;line-height:1.5;color:#757f8f;}',
      // The QR sits on its own white plate with a quiet zone, so it still scans when the page is
      // being viewed in dark mode — a QR inverted by a dark background will not read.
      '.tfa-qr{margin-top:11px;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px;display:flex;justify-content:center;}',
      '.tfa-qr svg{display:block;width:100%;height:auto;max-width:210px;shape-rendering:crispEdges;}',
      '.tfa-manual{margin-top:12px;}',
      '.tfa-manual summary{font-size:12.5px;color:#6d4fe0;cursor:pointer;list-style:none;}',
      '.tfa-manual summary::-webkit-details-marker{display:none;}',
      '.tfa-manual summary::before{content:"+ ";}',
      '.tfa-manual[open] summary::before{content:"\\2212 ";}',
      '.tfa-manual-body{font-size:12.5px;line-height:1.5;color:#757f8f;margin-top:8px;}',
      '.tfa-key{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap;}',
      '.tfa-key code{flex:1 1 220px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.5px;background:#f4f2fb;border:1px solid #e3e6ea;border-radius:8px;padding:10px 11px;word-break:break-all;line-height:1.4;}',
      '.tfa-copy{flex:0 0 auto;border:1px solid #e3e6ea;background:#fff;border-radius:8px;padding:9px 13px;font-size:12px;font-weight:600;cursor:pointer;color:#3d4653;font-family:inherit;}',
      '.tfa-copy:hover{background:#f4f6f8;}',
      '.tfa-keep{font-size:11.5px;line-height:1.5;color:#8a6d1f;background:#fdf6e3;border:1px solid #f0e3bd;border-radius:8px;padding:9px 11px;margin-top:10px;}',
      '.tfa-code{width:100%;box-sizing:border-box;margin-top:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;letter-spacing:7px;text-align:center;padding:12px;border:1px solid #e3e6ea;border-radius:9px;background:#fff;color:#08090c;}',
      '.tfa-code:focus{outline:none;border-color:#6d4fe0;box-shadow:0 0 0 3px rgba(109,79,224,.14);}',
      '.tfa-err{font-size:12.5px;line-height:1.5;color:#b03a3a;min-height:17px;margin-top:10px;}',
      '.tfa-actions{display:flex;gap:9px;margin-top:14px;flex-wrap:wrap;}',
      '.tfa-go{flex:1 1 180px;border:none;background:#6d4fe0;color:#fff;border-radius:9px;padding:12px;font-size:13.5px;font-weight:650;cursor:pointer;font-family:inherit;}',
      '.tfa-go[disabled]{opacity:.55;cursor:default;}',
      '.tfa-x{flex:0 0 auto;border:1px solid #e3e6ea;background:#fff;color:#757f8f;border-radius:9px;padding:12px 16px;font-size:13px;cursor:pointer;font-family:inherit;}',
      '@media (max-width:520px){.tfa-card{padding:20px 18px 18px;}.tfa-code{font-size:19px;letter-spacing:5px;}}'
    ].join('');
    document.head.appendChild(el);
  }

  // audience: 'staff' | 'client' — decides only where the resulting token is remembered.
  // One dialog at a time, and one setup per person.
  //
  // Nothing prevented this from being entered twice: pressing Enter in the password field and
  // clicking the button both call the page's login, each login asked for setup, and each asked the
  // server for a NEW secret. Two QR codes, two entries in the authenticator under an identical
  // label, and only one of them stored. Whichever the person scanned, they had a coin-flip chance of
  // being told the code was wrong — which is exactly what kept happening.
  //
  // A second call now joins the dialog already on screen instead of opening another.
  let openSetup = null;

  window.startTwoFactorSetup = function (opts) {
    if (openSetup) return openSetup;
    openSetup = startSetup(opts);
    openSetup.then(function () { openSetup = null; }, function () { openSetup = null; });
    return openSetup;
  };

  function startSetup(opts) {
    const lang = opts.lang === 'es' ? 'es' : 'en';
    const t = k => T[k][lang];
    injectStyles();

    return new Promise(async function (resolve) {
      const back = document.createElement('div');
      back.className = 'tfa-backdrop';
      back.innerHTML = '<div class="tfa-card" role="dialog" aria-modal="true">'
        + '<h3></h3><p class="tfa-intro"></p>'
        + '<div class="tfa-step"><div class="tfa-step-h" data-k="step1"></div><div class="tfa-step-b" data-k="step1body"></div></div>'
        + '<div class="tfa-step"><div class="tfa-step-h" data-k="step2"></div><div class="tfa-step-b" data-k="step2body"></div>'
        + '<div class="tfa-qr" id="tfa-qr"></div>'
        + '<details class="tfa-manual"><summary></summary>'
        + '<div class="tfa-manual-body" data-k="manualBody"></div>'
        + '<div class="tfa-key"><code id="tfa-secret"></code><button type="button" class="tfa-copy"></button></div>'
        + '</details>'
        + '<div class="tfa-keep"></div></div>'
        + '<div class="tfa-step"><div class="tfa-step-h" data-k="step3"></div>'
        + '<input class="tfa-code" id="tfa-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" spellcheck="false"></div>'
        + '<div class="tfa-err" id="tfa-err"></div>'
        + '<div class="tfa-actions"><button type="button" class="tfa-go"></button><button type="button" class="tfa-x"></button></div>'
        + '</div>';
      document.body.appendChild(back);

      const q = sel => back.querySelector(sel);
      q('h3').textContent = t('title');
      q('.tfa-intro').textContent = t('intro');
      back.querySelectorAll('[data-k]').forEach(el => { el.textContent = t(el.getAttribute('data-k')); });
      q('.tfa-keep').textContent = t('keep');
      q('.tfa-copy').textContent = t('copy');
      q('.tfa-manual summary').textContent = t('manualToggle');
      q('.tfa-go').textContent = t('enable');
      q('.tfa-x').textContent = t('cancel');
      q('#tfa-code').placeholder = t('codePlace');

      const errEl = q('#tfa-err');
      const goBtn = q('.tfa-go');
      const codeEl = q('#tfa-code');

      // Resolve FIRST, then tidy up. The other order meant a DOM error while removing the dialog
      // would strand the calling page waiting on a promise that never settled — the person would sit
      // on a dialog that had already done its job.
      function close(result) {
        resolve(result);
        try { back.remove(); } catch (e) { /* already detached */ }
      }
      q('.tfa-x').onclick = () => close(false);

      // Ask the server for a secret. It is held as pending until a live code proves the app has it.
      //
      // If this fails the dialog must not become a dead end. It used to return from inside the
      // promise without resolving it, so the caller awaited forever and the page sat on an error it
      // could not leave — the only way out was Cancel. Now the reason is shown and a retry offered.
      let secret = '', qrSvg = '';
      async function begin() {
        try {
          const res = await fetch('/api/two-factor', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'begin', username: opts.username, password: opts.password })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.secret) {
            // Translate the condition; never echo the server's English. The only thing interpolated
            // is a status number, which reads the same in both languages.
            if (data && data.needsCurrentCode) return { error: t('alreadySet') };
            if (res.status === 403) return { error: t('wrongPass') };
            return { error: t('serverSaid').replace('{code}', String(res.status)) };
          }
          return { secret: data.secret, qrSvg: data.qrSvg || '' };
        } catch (e) {
          return { error: t('noConnect') };
        }
      }

      function beginFailed(why) {
        errEl.textContent = why;
        goBtn.textContent = t('retry');
        goBtn.disabled = false;
        goBtn.onclick = async function () {
          goBtn.disabled = true;
          goBtn.textContent = t('working');
          const again = await begin();
          if (again.error) { beginFailed(again.error); return; }
          secret = again.secret;
          qrSvg = again.qrSvg;
          render();
        };
      }

      const started = await begin();
      if (started.error) { beginFailed(started.error); return; }
      secret = started.secret;
      qrSvg = started.qrSvg;
      // Puts the dialog into its ready state. It must re-enable the button as well as re-bind it:
      // the retry path disables it while it is working, and nothing else turns it back on — so
      // after a retry a person could scan the QR, type their code, and find the button dead.
      function render() {
        goBtn.textContent = t('enable');
        goBtn.onclick = confirmCode;
        goBtn.disabled = false;
        errEl.textContent = '';
      // Grouped in fours for the fallback, where it gets typed by hand on a phone.
      q('#tfa-secret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();

      // The QR comes from our own endpoint, drawn by a QR encoder — it contains nothing but path and
      // rect elements. Checked for the opening tag rather than trusted blindly, and if it is missing
      // the manual key opens instead so setup is never blocked on it.
      const qrBox = q('#tfa-qr');
      if (typeof qrSvg === 'string' && qrSvg.trim().startsWith('<svg')) {
        qrBox.innerHTML = qrSvg;
        qrBox.setAttribute('role', 'img');
        qrBox.setAttribute('aria-label', t('step2'));
      } else {
        qrBox.remove();
        const manual = back.querySelector('.tfa-manual');
        if (manual) manual.open = true;
      }

      q('.tfa-copy').onclick = async function () {
        try { await navigator.clipboard.writeText(secret); } catch (e) {
          const r = document.createRange(); r.selectNode(q('#tfa-secret'));
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        }
        this.textContent = t('copied');
        setTimeout(() => { this.textContent = t('copy'); }, 1800);
      };

      }

      codeEl.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
        errEl.textContent = '';
      });
      codeEl.addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });
      setTimeout(() => { try { codeEl.focus(); } catch (e) { /* ignore */ } }, 60);

      async function confirmCode() {
        const code = codeEl.value.replace(/\D/g, '');
        if (code.length !== 6) { errEl.textContent = t('needSix'); return; }
        goBtn.disabled = true;
        const label = goBtn.textContent;
        goBtn.textContent = t('working');
        // Only the request itself is allowed to fail here. Everything after a successful response
        // is outside this try on purpose: the account is enrolled the moment the server says so, and
        // no later hiccup — storing a token, touching the DOM — may render that as a failure. That
        // is what happened in production: enrollment had completed, and the dialog said it had not.
        let res, data;
        try {
          res = await fetch('/api/two-factor', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'confirm', username: opts.username, password: opts.password, code: code })
          });
          data = await res.json().catch(() => ({}));
        } catch (e) {
          errEl.textContent = t('noConnect');
          goBtn.disabled = false;
          goBtn.textContent = label;
          return;
        }

        {
          if (!res.ok) {
            // A wrong code is the ordinary case and gets the plain explanation. Anything else — the
            // endpoint missing, the enrollment having expired, a server error — says what it was,
            // because "something went wrong" cannot be acted on by the person reading it.
            if (res.status === 429) errEl.textContent = t('tooMany');
            else if (res.status === 403) errEl.textContent = t('badCode');
            else if (res.status === 409) {
              // The pending secret is gone and the submitted code does not match a live one, so this
              // setup is stale. Offer a fresh start rather than leaving them on a code that can
              // never work.
              beginFailed(t('expiredSet'));
              return;
            } else errEl.textContent = t('serverSaid').replace('{code}', String(res.status));
            codeEl.value = '';
            codeEl.focus();
            goBtn.disabled = false;
            goBtn.textContent = label;
            return;
          }

          // Enrolled. From here the only job is to let them through.
          // Remembering the token is a convenience — if storage refuses it, the login that follows
          // simply asks for a code, which is a working outcome, not an error.
          try {
            if (data && data.tfToken) {
              if (opts.audience === 'staff') {
                if (window.rememberStaffTfaToken) window.rememberStaffTfaToken(data.tfToken);
              } else {
                sessionStorage.setItem('geo_2fa_token', data.tfToken);
              }
            }
          } catch (e) { /* storage unavailable — the next step asks for a code instead */ }

          close(true);
        }
      }

      render();
    });
  };
})();
