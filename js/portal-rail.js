/* The sidebar, mounted by every page in the console.
 *
 * One implementation, injected at runtime, rather than markup pasted into each page — that is
 * why it kept vanishing on whichever page nobody had remembered to paste it into. It positions
 * itself fixed and indents the document, so a page needs no layout of its own to host it and
 * the dashboards can carry it without their stylesheets changing.
 *
 * It renders only for a signed-in staff session. The dashboards and the review page are also
 * client-facing; a client loading the same file gets nothing.
 */
(function () {
  'use strict';
  if (window.__akoreRail) return;
  window.__akoreRail = true;

  /* One console vocabulary. The role map lived only in the users table, so the customer page
     printed the raw stored key ("full") beside the same person the table called "Acceso
     completo". Defined above the staff guard on purpose — the label is needed on pages that
     render it whether or not the rail itself is drawn. */
  window.akoreRoleLabel = function (role) {
    return ({ admin: 'Administrador', staff: 'Equipo', user: 'Equipo', full: 'Acceso completo',
              viewer: 'Solo lectura' })[role] || role || '';
  };

  const W = 68, OPEN = 244;

  const ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    clients: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 20V9"/></svg>',
    users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6.4 6.4 0 0 0-2.2-4.8"/></svg>',
    account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
  };

  const CSS = `
    #akore-rail{position:fixed;inset:0 auto 0 0;width:${W}px;z-index:9000;background:#0f1117;
      overflow:hidden;transition:width .18s cubic-bezier(.2,.6,.2,1);
      font-family:var(--font-body,"Manrope",system-ui,sans-serif);display:flex;flex-direction:column}
    #akore-rail:hover,#akore-rail.pinned{width:${OPEN}px;box-shadow:14px 0 34px rgba(8,9,12,.28)}
    #akore-rail .ar-top{display:flex;align-items:center;gap:12px;padding:18px 16px 22px;min-height:64px;
      text-decoration:none;border-radius:0;background:none}
    #akore-rail a.ar-top:hover{background:none}
    #akore-rail .ar-top img{width:36px;height:36px;border-radius:9px;display:block;flex:0 0 36px}
    #akore-rail .ar-nav,#akore-rail .ar-foot{display:flex;flex-direction:column;gap:2px;padding:0 10px}
    #akore-rail .ar-foot{margin-top:auto;padding-bottom:16px}
    #akore-rail a,#akore-rail button{display:flex;align-items:center;gap:14px;width:100%;
      padding:11px 10px;border:0;border-radius:10px;background:none;color:#c9c2e8;cursor:pointer;
      text-align:left;font:inherit;font-size:14px;white-space:nowrap;text-decoration:none}
    #akore-rail a:hover,#akore-rail button:hover{background:rgba(255,255,255,.07);color:#fff}
    #akore-rail a.on{background:#6d4fe0;color:#fff;font-weight:600}
    #akore-rail .ar-ico{flex:0 0 24px;display:flex;align-items:center;justify-content:center}
    #akore-rail .ar-ico svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;
      stroke-linecap:round;stroke-linejoin:round}
    /* Labels are laid out at full width, so at ${W}px they would be sliced mid-letter. They are
       hidden outright when the rail is closed rather than clipped. */
    #akore-rail .ar-t{opacity:0;transition:opacity .14s;overflow:hidden}
    #akore-rail:hover .ar-t,#akore-rail.pinned .ar-t{opacity:1}
    html.akore-railed body{padding-left:${W}px!important;box-sizing:border-box}
  `;

  function mount() {
    const who = (window.akoreAuth && window.akoreAuth.who && window.akoreAuth.who()) || null;
    if (!who || who.kind !== 'staff') return;          // clients see nothing
    if (document.getElementById('akore-rail')) return;

    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    const here = location.pathname;
    const on = p => here === p ? ' class="on"' : '';

    /* Every page that belongs to a customer offers the way back to that customer, from here, so
       no page has to remember to provide one of its own — which is how the dashboards ended up
       with a cross-link to each other and no route home. */
    const co = new URLSearchParams(location.search).get('company');
    const onCustomerPage = here === '/index.html';
    const backItem = (co && !onCustomerPage)
      ? `<a href="/index.html?company=${encodeURIComponent(co)}"><span class="ar-ico">${ICON.back}</span><span class="ar-t">Volver a ${co.replace(/[<>&]/g, '')}</span></a>`
      : '';
    const rail = document.createElement('nav');
    rail.id = 'akore-rail';
    rail.setAttribute('aria-label', 'Navegación');
    rail.innerHTML =
      `<a class="ar-top" href="/portal.html" title="Akore Labs — inicio"><img src="/brand/logo-mark.png" alt="Akore Labs"><span class="ar-t" style="color:#fff;font-weight:700">Akore Labs</span></a>
       <div class="ar-nav">
         ${backItem}
         <a href="/portal.html"${on('/portal.html')}><span class="ar-ico">${ICON.clients}</span><span class="ar-t">Clientes</span></a>
         <a href="/portal.html#/usuarios"><span class="ar-ico">${ICON.users}</span><span class="ar-t">Usuarios</span></a>
         <a href="/portal.html#/cuenta"><span class="ar-ico">${ICON.account}</span><span class="ar-t">Mi cuenta</span></a>
       </div>
       <div class="ar-foot">
         <button type="button" id="ar-out"><span class="ar-ico">${ICON.out}</span><span class="ar-t">Cerrar sesión</span></button>
       </div>`;
    document.body.appendChild(rail);
    document.documentElement.classList.add('akore-railed');

    document.getElementById('ar-out').onclick = () =>
      window.staffLogoutAll ? window.staffLogoutAll('/portal.html') : (sessionStorage.clear(), location.reload());

    // Touch has no hover, so the rail would stay shut on a tablet; a tap pins it open.
    rail.addEventListener('click', e => {
      if (e.target.closest('a,button')) return;
      if (!window.matchMedia('(hover: hover)').matches) rail.classList.toggle('pinned');
    });
    document.addEventListener('click', e => { if (!rail.contains(e.target)) rail.classList.remove('pinned'); });
  }

  /* The session is restored asynchronously, so wait for it rather than reading storage: the
     server decides whether this browser is signed in, and nothing else is proof. */
  function start() {
    const go = () => { try { mount(); } catch (e) { console.warn('[rail]', e); } };
    if (window.akoreAuth && window.akoreAuth.who && window.akoreAuth.who()) return go();
    if (window.akoreAuth && window.akoreAuth.restore) return window.akoreAuth.restore().then(go, go);
    go();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // Pages that sign in after load (the console's own gate) can ask for it again.
  window.akoreMountRail = mount;
})();
