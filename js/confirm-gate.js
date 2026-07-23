// Shared password-confirmation gate for important staff actions — run audit, regenerate prompts,
// enable monitoring (index.html) and delete customer (portal.html). Verifies the current staff
// user's password against /api/staff-users (the single server-side source of truth for auth)
// before resolving true. Styling is fully inline so it has no dependency on either page's CSS —
// this is the one implementation both pages use, rather than each keeping its own copy.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // opts: { title, message (already-safe HTML), username, labels:{enter,confirm,cancel,wrong} }
  // Resolves true only on a correct password; false on cancel / backdrop dismiss.
  window.requirePassword = function (opts) {
    opts = opts || {};
    const L = opts.labels || {};
    const enterLabel = L.enter || 'Enter your password to confirm';
    const confirmLabel = L.confirm || 'Confirm';
    const cancelLabel = L.cancel || 'Cancel';
    const wrongLabel = L.wrong || 'Incorrect password.';
    const username = opts.username || '';
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.setAttribute('role', 'dialog');
      back.style.cssText = 'position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;background:rgba(8,9,12,.5);padding:20px;';
      back.innerHTML =
        '<div style="background:#fff;border-radius:16px;max-width:400px;width:100%;padding:24px;box-shadow:0 24px 60px rgba(8,9,12,.28);font-family:inherit;">' +
          '<div style="font-family:inherit;font-size:19px;font-weight:700;color:#08090c;margin-bottom:8px;">' + esc(opts.title || '') + '</div>' +
          '<div style="font-size:13px;color:#4a4f57;line-height:1.5;margin-bottom:16px;">' + (opts.message || '') + '</div>' +
          '<label style="display:block;font-size:12px;color:#4a4f57;margin-bottom:6px;">' + esc(enterLabel) + '</label>' +
          '<input type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7dae0;border-radius:9px;font-size:14px;font-family:inherit;color:#08090c;">' +
          '<div class="__pwerr" style="display:none;color:#c02626;font-size:12px;margin-top:8px;"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">' +
            '<button type="button" class="__pwcancel" style="font-family:inherit;font-size:14px;font-weight:600;padding:9px 16px;border-radius:9px;border:1px solid #d7dae0;background:#fff;color:#08090c;cursor:pointer;">' + esc(cancelLabel) + '</button>' +
            '<button type="button" class="__pwok" style="font-family:inherit;font-size:14px;font-weight:600;padding:9px 16px;border-radius:9px;border:none;background:#1ea97c;color:#fff;cursor:pointer;">' + esc(confirmLabel) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);
      const input = back.querySelector('input');
      const err = back.querySelector('.__pwerr');
      const okBtn = back.querySelector('.__pwok');
      const done = v => { back.remove(); resolve(v); };
      back.querySelector('.__pwcancel').onclick = () => done(false);
      back.addEventListener('mousedown', e => { if (e.target === back) done(false); });
      async function submit() {
        const pw = input.value;
        if (!pw) { input.focus(); return; }
        if (!username) { err.textContent = wrongLabel; err.style.display = 'block'; return; }
        err.style.display = 'none'; okBtn.disabled = true;
        try {
          const res = await fetch('/api/staff-users?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(pw));
          const data = await res.json().catch(() => ({}));
          // A valid single-user check returns that user's record (has `username`); the no-username
          // path returns an { items } list with HTTP 200 — that must NOT be accepted as a pass.
          if (!res.ok || !data || !data.username) throw new Error('bad');
          try { sessionStorage.setItem('geo_staff_password', pw); } catch (e) { /* private mode */ }
          done(true);
        } catch (e) {
          err.textContent = wrongLabel; err.style.display = 'block';
          okBtn.disabled = false; input.value = ''; input.focus();
        }
      }
      okBtn.onclick = submit;
      input.onkeydown = e => { if (e.key === 'Enter') submit(); };
      setTimeout(() => input.focus(), 50);
    });
  };
})();
