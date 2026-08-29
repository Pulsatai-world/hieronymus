// The authenticator setup dialog: install an app, scan a QR, type the code.
//
//   window.akoreEnroll(username, password, lang)  ->  the who-payload (signed in), or false
//
// Shared by every login in the platform. Rules learned the hard way, each of which is now structural
// rather than a matter of care:
//
//   * One dialog at a time. Two dialogs meant two setup secrets and two identical-looking entries in
//     the authenticator app, of which only one worked.
//   * Once the server says the account is set up, nothing afterwards may show a failure. Storing a
//     token or tearing down the dialog used to sit inside the request's own error handling, so a
//     completed setup could be reported as broken.
//   * Never a dead end. A failed start says why, in one language, and offers to try again.
//   * No message pastes the server's wording into a sentence. The server speaks English; doing that
//     produced half-Spanish, half-English text in front of a customer.

(function () {
  const T = {
    title:      { en: 'Set up two-step verification', es: 'Activa la verificación en dos pasos' },
    intro:      { en: 'Your account needs a code from an authenticator app as well as your password. This takes about a minute and you only do it once.',
                  es: 'Tu cuenta necesita un código de una app de autenticación, además de tu contraseña. Toma menos de un minuto y solo se hace una vez.' },
    step1:      { en: '1. Install an authenticator app', es: '1. Instala una app de autenticación' },
    step1body:  { en: "If you don't have one, Google Authenticator and Microsoft Authenticator are free. A password manager like 1Password works too.",
                  es: 'Si no tienes una, Google Authenticator y Microsoft Authenticator son gratuitas. Un gestor de contraseñas como 1Password también sirve.' },
    step2:      { en: '2. Scan this code with the app', es: '2. Escanea este código con la app' },
    step2body:  { en: 'Choose "Add account", then "Scan a QR code", and point your camera here.',
                  es: 'Elige «Agregar cuenta», luego «Escanear código QR», y apunta la cámara aquí.' },
    manual:     { en: "Can't scan it? Type the key instead", es: '¿No puedes escanear el código? Escribe la clave' },
    manualBody: { en: 'Choose "Enter a setup key" instead, and use this:',
                  es: 'En la app elige «Ingresar una clave de configuración» y escribe esta:' },
    copy:       { en: 'Copy key', es: 'Copiar clave' },
    copied:     { en: 'Copied', es: 'Copiada' },
    step3:      { en: '3. Enter the 6-digit code the app shows', es: '3. Escribe el código de 6 dígitos que muestra la app' },
    enable:     { en: 'Turn on and continue', es: 'Activar y continuar' },
    working:    { en: 'Checking…', es: 'Verificando…' },
    retry:      { en: 'Try again', es: 'Intentar de nuevo' },
    cancel:     { en: 'Cancel', es: 'Cancelar' },
    needSix:    { en: 'Enter all 6 digits.', es: 'Escribe los 6 dígitos.' },
    badCode:    { en: "That code didn't match. Check that your phone's clock is set automatically, then try the next code the app shows.",
                  es: 'El código no coincide. Revisa que la hora de tu teléfono esté en automático e intenta con el siguiente código que muestre la app.' },
    tooMany:    { en: 'Too many incorrect codes. Wait a few minutes and try again.',
                  es: 'Demasiados códigos incorrectos. Espera unos minutos e intenta de nuevo.' },
    expired:    { en: 'This setup timed out. Press "Try again" to start over.',
                  es: 'Esta configuración expiró. Presiona «Intentar de nuevo» para empezar otra vez.' },
    alreadySet: { en: 'This account is already set up. Reload the page and sign in with a code from your app.',
                  es: 'Esta cuenta ya está configurada. Recarga la página e inicia sesión con un código de tu app.' },
    wrongPass:  { en: 'That password is not correct.', es: 'La contraseña no es correcta.' },
    noConnect:  { en: 'Could not reach the server. Check your connection and try again.',
                  es: 'No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.' },
    serverSaid: { en: 'Something failed on our side ({code}). Try again, and if it keeps happening let us know and mention that number.',
                  es: 'Algo falló de nuestro lado ({code}). Intenta de nuevo y, si sigue pasando, avísanos y menciona ese número.' },
    clockOff:   { en: 'This device\'s clock is about {mins} minutes off. Codes are based on the time, so set the clock automatically before continuing.',
                  es: 'El reloj de este dispositivo tiene unos {mins} minutos de diferencia. Los códigos se basan en la hora, así que pon el reloj en automático antes de continuar.' },
    doneTitle:  { en: "You're all set", es: 'Todo listo' },
    doneBody:   { en: 'Two-step verification is on. From now on your password and a code from the app get you in.',
                  es: 'La verificación en dos pasos está activada. A partir de ahora entras con tu contraseña y un código de la app.' },
    recovTitle: { en: 'Save your recovery codes', es: 'Guarda tus códigos de recuperación' },
    recovBody:  { en: 'If you ever lose the phone, each of these signs you in once, in place of a code. This is the only time they are shown.',
                  es: 'Si algún día pierdes el teléfono, cada uno de estos te permite entrar una vez, en lugar de un código. Esta es la única vez que se muestran.' },
    copyCodes:  { en: 'Copy codes', es: 'Copiar códigos' },
    download:   { en: 'Download', es: 'Descargar' },
    savedIt:    { en: 'I have saved these somewhere safe', es: 'Ya los guardé en un lugar seguro' },
    continue:   { en: 'Continue', es: 'Continuar' }
  };

  function styles() {
    if (document.getElementById('akore-enroll-styles')) return;
    const el = document.createElement('style');
    el.id = 'akore-enroll-styles';
    el.textContent = [
      '.ae-back{position:fixed;inset:0;background:rgba(8,9,12,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;}',
      '.ae-card{background:#fff;color:#08090c;border-radius:14px;max-width:460px;width:100%;padding:26px 26px 22px;box-shadow:0 18px 50px rgba(8,9,12,.28);margin:auto;font-family:inherit;}',
      '.ae-card h3{margin:0 0 8px;font-size:19px;font-weight:650;letter-spacing:-.2px;}',
      '.ae-intro{font-size:13.5px;line-height:1.55;color:#3d4653;margin:0 0 20px;}',
      '.ae-step{margin-bottom:18px;}',
      '.ae-h{font-size:13px;font-weight:650;margin-bottom:5px;}',
      '.ae-b{font-size:12.5px;line-height:1.5;color:#757f8f;}',
      // The QR gets its own white plate: a code inverted by a dark-mode background will not scan.
      '.ae-qr{margin-top:11px;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px;display:flex;justify-content:center;}',
      '.ae-qr svg{display:block;width:100%;height:auto;max-width:210px;shape-rendering:crispEdges;}',
      '.ae-manual{margin-top:12px;}',
      '.ae-manual summary{font-size:12.5px;color:#6d4fe0;cursor:pointer;list-style:none;}',
      '.ae-manual summary::-webkit-details-marker{display:none;}',
      '.ae-manual summary::before{content:"+ ";}',
      '.ae-manual[open] summary::before{content:"\\2212 ";}',
      '.ae-key{display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap;}',
      '.ae-key code{flex:1 1 220px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.5px;background:#f4f2fb;border:1px solid #e3e6ea;border-radius:8px;padding:10px 11px;word-break:break-all;line-height:1.4;}',
      '.ae-copy{flex:0 0 auto;border:1px solid #e3e6ea;background:#fff;border-radius:8px;padding:9px 13px;font-size:12px;font-weight:600;cursor:pointer;color:#3d4653;font-family:inherit;}',
      '.ae-code{width:100%;box-sizing:border-box;margin-top:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;letter-spacing:7px;text-align:center;padding:12px;border:1px solid #e3e6ea;border-radius:9px;background:#fff;color:#08090c;}',
      '.ae-code:focus{outline:none;border-color:#6d4fe0;box-shadow:0 0 0 3px rgba(109,79,224,.14);}',
      '.ae-err{font-size:12.5px;line-height:1.5;color:#b03a3a;min-height:17px;margin-top:10px;}',
      '.ae-actions{display:flex;gap:9px;margin-top:14px;flex-wrap:wrap;}',
      '.ae-go{flex:1 1 180px;border:none;background:#6d4fe0;color:#fff;border-radius:9px;padding:12px;font-size:13.5px;font-weight:650;cursor:pointer;font-family:inherit;}',
      '.ae-go[disabled]{opacity:.55;cursor:default;}',
      '.ae-x{flex:0 0 auto;border:1px solid #e3e6ea;background:#fff;color:#757f8f;border-radius:9px;padding:12px 16px;font-size:13px;cursor:pointer;font-family:inherit;}',
      '.ae-tick{width:44px;height:44px;border-radius:50%;background:#eefaf4;color:#0f7d5b;display:flex;align-items:center;justify-content:center;font-size:23px;margin-bottom:12px;}',
      '.ae-rec{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px;background:#f4f2fb;border:1px solid #e3e6ea;border-radius:10px;padding:13px;}',
      '.ae-rec span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;letter-spacing:.4px;color:#08090c;text-align:center;padding:3px 0;}',
      '.ae-rec span.spent{text-decoration:line-through;opacity:.45;}',
      '.ae-save{display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:12.5px;line-height:1.45;color:#3d4653;cursor:pointer;}',
      '.ae-save input{margin-top:2px;flex:0 0 auto;width:15px;height:15px;accent-color:#6d4fe0;cursor:pointer;}',
      '@media (max-width:520px){.ae-card{padding:20px 18px 18px;}.ae-code{font-size:19px;letter-spacing:5px;}.ae-rec{grid-template-columns:1fr;}}'
    ].join('');
    document.head.appendChild(el);
  }

  let open = null;

  window.akoreEnroll = function (username, password, lang) {
    if (open) return open;                    // one dialog, however many callers ask
    open = run(username, password, lang === 'es' ? 'es' : 'en');
    const clear = function () { open = null; };
    open.then(clear, clear);
    return open;
  };

  function run(username, password, lang) {
    const t = k => T[k][lang];
    styles();

    return new Promise(function (resolve) {
      const back = document.createElement('div');
      back.className = 'ae-back';
      back.innerHTML = '<div class="ae-card" role="dialog" aria-modal="true">'
        + '<h3></h3><p class="ae-intro"></p>'
        + '<div class="ae-step"><div class="ae-h" data-k="step1"></div><div class="ae-b" data-k="step1body"></div></div>'
        + '<div class="ae-step"><div class="ae-h" data-k="step2"></div><div class="ae-b" data-k="step2body"></div>'
        + '<div class="ae-qr" id="ae-qr"></div>'
        + '<details class="ae-manual"><summary></summary>'
        + '<div class="ae-b" data-k="manualBody"></div>'
        + '<div class="ae-key"><code id="ae-secret"></code><button type="button" class="ae-copy"></button></div>'
        + '</details></div>'
        + '<div class="ae-step"><div class="ae-h" data-k="step3"></div>'
        + '<input class="ae-code" id="ae-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" spellcheck="false"></div>'
        + '<div class="ae-err" id="ae-err"></div>'
        + '<div class="ae-actions"><button type="button" class="ae-go"></button><button type="button" class="ae-x"></button></div>'
        + '</div>';
      document.body.appendChild(back);

      const q = sel => back.querySelector(sel);
      q('h3').textContent = t('title');
      q('.ae-intro').textContent = t('intro');
      back.querySelectorAll('[data-k]').forEach(el => { el.textContent = t(el.getAttribute('data-k')); });
      q('.ae-manual summary').textContent = t('manual');
      q('.ae-copy').textContent = t('copy');
      q('.ae-x').textContent = t('cancel');
      q('#ae-code').placeholder = '000000';

      const errEl = q('#ae-err'), goBtn = q('.ae-go'), codeEl = q('#ae-code');
      let secret = '';

      // Resolve first, tear down second: a DOM error while removing the dialog must not strand the
      // page on a promise that never settles.
      function close(result) {
        resolve(result);
        try { back.remove(); } catch (e) { /* already detached */ }
      }
      q('.ae-x').onclick = function () { close(false); };

      async function start() {
        let res, data;
        try {
          res = await fetch('/api/enroll', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
          });
          data = await res.json().catch(function () { return {}; });
        } catch (e) {
          return { error: t('noConnect') };
        }
        if (!res.ok || !data.secret) {
          if (data && data.needsCurrentCode) return { error: t('alreadySet') };
          if (res.status === 401) return { error: t('wrongPass') };
          return { error: t('serverSaid').replace('{code}', String(res.status)) };
        }
        return { secret: data.secret, qrSvg: data.qrSvg || '', serverTime: data.serverTime };
      }

      function failed(message) {
        errEl.textContent = message;
        goBtn.textContent = t('retry');
        goBtn.disabled = false;
        goBtn.onclick = async function () {
          goBtn.disabled = true;
          goBtn.textContent = t('working');
          const again = await start();
          if (again.error) { failed(again.error); return; }
          apply(again);
        };
      }

      function apply(started) {
        secret = started.secret;
        // Grouped in fours: this gets typed by hand on a phone.
        q('#ae-secret').textContent = secret.replace(/(.{4})/g, '$1 ').trim();

        const qrBox = q('#ae-qr');
        if (typeof started.qrSvg === 'string' && started.qrSvg.trim().indexOf('<svg') === 0) {
          qrBox.innerHTML = started.qrSvg;
          qrBox.setAttribute('role', 'img');
          qrBox.setAttribute('aria-label', t('step2'));
          qrBox.style.display = '';
        } else {
          // No image: open the typed key instead rather than blocking setup on it.
          qrBox.style.display = 'none';
          const manual = back.querySelector('.ae-manual');
          if (manual) manual.open = true;
        }

        // Codes are derived from the clock. If this device is far enough out that every code will
        // look wrong, say so now instead of leaving someone retyping correct numbers.
        errEl.textContent = '';
        if (started.serverTime) {
          const offMs = Math.abs(Date.now() - started.serverTime);
          if (offMs > 90 * 1000) {
            errEl.textContent = t('clockOff').replace('{mins}', String(Math.round(offMs / 60000)));
          }
        }

        goBtn.textContent = t('enable');
        goBtn.disabled = false;
        goBtn.onclick = finish;
      }

      let finishing = false;
      async function finish() {
        if (finishing) return;                 // a double press must not submit twice
        const code = codeEl.value.replace(/\D/g, '');
        if (code.length !== 6) { errEl.textContent = t('needSix'); return; }
        finishing = true;
        goBtn.disabled = true;
        const label = goBtn.textContent;
        goBtn.textContent = t('working');

        let res, data;
        try {
          res = await fetch('/api/enroll', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password, code: code })
          });
          data = await res.json().catch(function () { return {}; });
        } catch (e) {
          errEl.textContent = t('noConnect');
          finishing = false; goBtn.disabled = false; goBtn.textContent = label;
          return;
        }

        // Everything below is outside that try on purpose. Once the server says the account is set
        // up, nothing that happens afterwards may report a failure.
        if (!res.ok) {
          if (res.status === 429) errEl.textContent = t('tooMany');
          else if (res.status === 409) { failed(t('expired')); finishing = false; return; }
          else if (res.status === 403) errEl.textContent = t('badCode');
          else errEl.textContent = t('serverSaid').replace('{code}', String(res.status));
          codeEl.value = '';
          try { codeEl.focus(); } catch (e) { /* ignore */ }
          finishing = false; goBtn.disabled = false; goBtn.textContent = label;
          return;
        }

        // Set up, and signed in: the endpoint returns a session because a password and a live code
        // were both just proved. The dialog does NOT close here — it used to, and the page reloaded
        // straight into a sign-in form with nothing having said the setup worked. It also has the
        // recovery codes to hand over, and this is the only moment they exist to be shown.
        succeeded(data);
      }

      // ── Set up: what the person sees when it worked ──
      // Everything from here on is display. Nothing can fail in a way that reports the setup as
      // broken — by this point the server has already saved it.
      function succeeded(data) {
        const codes = Array.isArray(data && data.recoveryCodes) ? data.recoveryCodes : [];
        const card = back.querySelector('.ae-card');
        card.innerHTML = '';

        const tick = document.createElement('div');
        tick.className = 'ae-tick'; tick.textContent = '✓';
        const h = document.createElement('h3'); h.textContent = t('doneTitle');
        const p1 = document.createElement('p'); p1.className = 'ae-intro'; p1.textContent = t('doneBody');
        card.appendChild(tick); card.appendChild(h); card.appendChild(p1);

        let tickbox = null;
        if (codes.length) {
          const h2 = document.createElement('div');
          h2.className = 'ae-h'; h2.textContent = t('recovTitle');
          const b2 = document.createElement('div');
          b2.className = 'ae-b'; b2.textContent = t('recovBody');
          const grid = document.createElement('div');
          grid.className = 'ae-rec';
          codes.forEach(function (c) {
            const el = document.createElement('span'); el.textContent = c; grid.appendChild(el);
          });
          const row = document.createElement('div');
          row.className = 'ae-key'; row.style.marginTop = '11px';
          const copy = document.createElement('button');
          copy.type = 'button'; copy.className = 'ae-copy'; copy.textContent = t('copyCodes');
          copy.style.flex = '1 1 auto';
          copy.onclick = async function () {
            const text = codes.join('\n');
            try { await navigator.clipboard.writeText(text); } catch (e) {
              try {
                const r = document.createRange(); r.selectNode(grid);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
              } catch (e2) { /* ignore */ }
            }
            copy.textContent = t('copied');
            setTimeout(function () { copy.textContent = t('copyCodes'); }, 1800);
          };
          const dl = document.createElement('button');
          dl.type = 'button'; dl.className = 'ae-copy'; dl.textContent = t('download');
          dl.onclick = function () {
            try {
              const blob = new Blob(['Akore Labs — ' + username + '\n\n' + codes.join('\n') + '\n'],
                { type: 'text/plain' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'akore-recovery-codes-' + username + '.txt';
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
            } catch (e) { /* copying still works */ }
          };
          row.appendChild(copy); row.appendChild(dl);

          const label = document.createElement('label');
          label.className = 'ae-save';
          tickbox = document.createElement('input');
          tickbox.type = 'checkbox';
          const span = document.createElement('span'); span.textContent = t('savedIt');
          label.appendChild(tickbox); label.appendChild(span);

          const step = document.createElement('div');
          step.className = 'ae-step';
          step.appendChild(h2); step.appendChild(b2); step.appendChild(grid); step.appendChild(row);
          card.appendChild(step); card.appendChild(label);
        }

        const actions = document.createElement('div');
        actions.className = 'ae-actions';
        const go = document.createElement('button');
        go.type = 'button'; go.className = 'ae-go'; go.textContent = t('continue');
        // Gated on the tick only when there is something to lose by clicking past it.
        go.disabled = !!tickbox;
        if (tickbox) tickbox.onchange = function () { go.disabled = !tickbox.checked; };
        go.onclick = function () { close(data); };
        actions.appendChild(go);
        card.appendChild(actions);
        try { go.focus(); } catch (e) { /* ignore */ }
      }

      q('.ae-copy').onclick = async function () {
        try { await navigator.clipboard.writeText(secret); } catch (e) {
          try {
            const r = document.createRange(); r.selectNode(q('#ae-secret'));
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          } catch (e2) { /* ignore */ }
        }
        this.textContent = t('copied');
        const self = this;
        setTimeout(function () { self.textContent = t('copy'); }, 1800);
      };

      codeEl.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
      });
      codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') finish(); });
      setTimeout(function () { try { codeEl.focus(); } catch (e) { /* ignore */ } }, 60);

      goBtn.textContent = t('working');
      goBtn.disabled = true;
      start().then(function (started) {
        if (started.error) failed(started.error); else apply(started);
      });
    });
  }
})();
