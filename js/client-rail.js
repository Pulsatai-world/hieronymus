/* The sidebar every client-facing page wears.
 *
 * client-portal.html had one and nobody else did, so the prompt review page a customer reaches
 * — from a button in that very sidebar — dropped them onto a page with a different header and
 * no route back into their own portal. One implementation, injected at runtime, the same way
 * the staff console's rail works.
 *
 * The portal is one page with views, so there the items call that page's own router. Everywhere
 * else the same items are links into it. The caller says which item is current; nothing here
 * guesses, and nothing here decides what a page is allowed to show.
 */
(function () {
  'use strict';

  const CSS = `
.shell { display: none; height: 100vh; }
body.app-mode .shell { display: flex; }

/* The rail. Collapsed it is an icon strip; expanded it overlays the content rather than
   pushing it, so the main view never reflows and nothing jumps while you read. */
.rail {
  position: relative; z-index: 40; flex: 0 0 var(--rail-w, 68px);
  background: #0f1117; color: #c9c2e8;
  display: flex; flex-direction: column;
  transition: flex-basis .18s var(--ease-standard, cubic-bezier(.2,.6,.2,1));
}
.rail-inner {
  position: absolute; inset: 0 auto 0 0; width: var(--rail-w, 68px);
  background: #0f1117; display: flex; flex-direction: column; overflow: hidden;
  transition: width .18s var(--ease-standard, cubic-bezier(.2,.6,.2,1));
  box-shadow: 0 0 0 rgba(0,0,0,0);
}
.rail:hover .rail-inner,
.rail.pinned .rail-inner,
.rail:focus-within .rail-inner { width: 248px; box-shadow: 14px 0 34px rgba(8,9,12,.28); }

.rail-top { display: flex; align-items: center; gap: 12px; padding: 18px 16px 22px; min-height: 64px; }
.rail-mark { width: 36px; height: 36px; flex: 0 0 36px; border-radius: 9px; background: transparent; padding: 0;
  display: flex; align-items: center; justify-content: center; font-family: var(--font-display, sans-serif);
  font-weight: 800; color: #fff; font-size: 17px; }
.rail-mark img { width: 36px; height: 36px; display: block; border-radius: 9px; }
.rail-co { font-family: var(--font-display, sans-serif); font-weight: 700; font-size: 14px; color: #fff;
  white-space: nowrap; overflow: hidden; }

.rail-nav { display: flex; flex-direction: column; gap: 2px; padding: 0 10px; }
.rail-item {
  display: flex; align-items: center; gap: 14px; padding: 11px 10px; border-radius: 10px;
  color: #c9c2e8; background: none; border: 0; width: 100%; cursor: pointer; text-align: left;
  font-family: inherit; font-size: 14px; white-space: nowrap; position: relative;
}
.rail-item:hover { background: rgba(255,255,255,.07); color: #fff; }
.rail-item.active { background: var(--violet-600, #6d4fe0); color: #fff; font-weight: 600; }
.rail-item:focus-visible { outline: 2px solid var(--emerald-400, #34c592); outline-offset: 2px; }
.rail-ico { flex: 0 0 24px; display: flex; align-items: center; justify-content: center; }
.rail-ico svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round; }
.rail-label { overflow: hidden; }
/* A count of things waiting on the client. Shown on the collapsed rail too — the whole point
   is to be visible before anyone opens the menu. */
.rail-dot { position: absolute; left: 30px; top: 7px; min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 9px; background: var(--emerald-500, #1ea97c); color: #06231a; font-size: 11px;
  font-weight: 800; display: flex; align-items: center; justify-content: center; }
.rail-foot { margin-top: auto; padding: 12px 10px 16px; display: flex; flex-direction: column; gap: 2px; }

`;

  const ICON = {
  home:'<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.8"/></svg>',
  dashboards:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  prompts:'<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.4A8.3 8.3 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/></svg>',
  messages:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>',
  intake:'<svg viewBox="0 0 24 24"><path d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7Z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
  settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.4 7l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0 1.2 2.9H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  out:'<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
  };

  // The order a client meets them in, on every page.
  const ITEMS = [
    { id: 'home',       key: 'navHome' },
    { id: 'dashboards', key: 'navDashboards' },
    { id: 'prompts',    key: 'navPrompts' },
    { id: 'intake',     key: 'navIntake' },
    { id: 'messages',   key: 'navMessages' },
    { id: 'settings',   key: 'navSettings' }
  ];

  function styles() {
    if (document.getElementById('akore-client-rail-css')) return;
    const st = document.createElement('style');
    st.id = 'akore-client-rail-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /**
   * mount({ mountPoint, company, current, t, esc, badges, onNavigate })
   *
   *   mountPoint  the <nav class="rail"> to fill, or an element to append one to
   *   current     which item is active ('prompts', 'home', …) or null
   *   t, esc      the host page's translator and escaper — the rail has no dictionary of its own
   *   badges      { prompts: '!' } or {}
   *   onNavigate  called with an item id. Return true if handled; otherwise the rail follows
   *               the link into client-portal.html itself.
   */
  function mount(opts) {
    const o = opts || {};
    const t = o.t || function (k) { return k; };
    const esc = o.esc || function (s) { return String(s == null ? '' : s); };
    const badges = o.badges || {};
    styles();

    let rail = o.mountPoint;
    if (!rail) return null;
    if (!rail.classList.contains('rail')) {
      const nav = document.createElement('nav');
      nav.className = 'rail';
      nav.setAttribute('aria-label', 'Secciones');
      rail.appendChild(nav);
      rail = nav;
    }

    const href = id => '/client-portal.html#/' + id;
    const row = it => {
      const label = esc(t(it.key));
      const badge = badges[it.id] ? '<span class="rail-dot">' + esc(badges[it.id]) + '</span>' : '';
      return '<a class="rail-item' + (o.current === it.id ? ' active' : '') + '" href="' + href(it.id) +
             '" data-rail="' + it.id + '" title="' + label + '">' +
             '<span class="rail-ico">' + ICON[it.id] + '</span>' +
             '<span class="rail-label">' + label + '</span>' + badge + '</a>';
    };

    // Staff looking at a customer's page belong back on that customer's internal page, not in
    // the customer's own portal and not signed out of the platform — the log-out button here
    // holds the STAFF session, so for them it is replaced rather than relabelled.
    const viaStaff = window.akoreIsStaffBypass && window.akoreIsStaffBypass();
    const foot = viaStaff
      ? '<a class="rail-item" href="' + (window.homeHref ? window.homeHref(o.company || '') : '/portal.html') + '">' +
        '<span class="rail-ico">' + ICON.out + '</span><span class="rail-label">' + esc(t('navBackStaff')) + '</span></a>'
      : '<button class="rail-item" type="button" data-rail-logout>' +
        '<span class="rail-ico">' + ICON.out + '</span><span class="rail-label">' + esc(t('navLogout')) + '</span></button>';

    rail.innerHTML =
      '<div class="rail-inner">' +
        '<div class="rail-top"><div class="rail-mark"><img src="/brand/logo-mark.png" alt="Akore Labs"></div>' +
          '<div class="rail-co">' + esc(o.company || '') + '</div></div>' +
        '<div class="rail-nav">' + ITEMS.map(row).join('') + '</div>' +
        '<div class="rail-foot">' + foot + '</div>' +
      '</div>';

    rail.querySelectorAll('[data-rail]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (o.onNavigate && o.onNavigate(a.dataset.rail) === true) e.preventDefault();
      });
    });
    const outBtn = rail.querySelector('[data-rail-logout]');
    if (outBtn) outBtn.onclick = function () {
      if (o.onLogout) o.onLogout();
      else if (window.akoreAuth && window.akoreAuth.signOut) window.akoreAuth.signOut();
    };

    wire(rail);
    return rail;
  }

  /* Touch has no hover, so the rail would sit permanently collapsed on a phone. A tap pins it
     open, a tap elsewhere closes it, and keyboard users get the same through :focus-within. */
  function wire(rail) {
    if (rail.__wired) return;
    rail.__wired = true;
    rail.addEventListener('click', function (e) {
      if (window.matchMedia('(hover: hover)').matches) return;
      if (e.target.closest('.rail-item')) return;
      rail.classList.toggle('pinned');
    });
    document.addEventListener('click', function (e) {
      if (!rail.contains(e.target)) rail.classList.remove('pinned');
    });
  }

  window.AkoreClientRail = { mount: mount, ITEMS: ITEMS, ICON: ICON };
})();
