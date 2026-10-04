/* Akore internal console.
 *
 * Written from scratch against the platform's existing HTTP API. It renders every screen itself
 * — nothing is embedded, framed or inherited from the previous portal — so the navigation model
 * is one model: a rail of destinations, a page per destination, and a customer's own screens
 * nested under that customer rather than scattered across modals.
 *
 * Structure, top to bottom:
 *   api      every request the console makes, in one place
 *   state    what has been loaded
 *   ui       the handful of primitives the screens are built from
 *   views    one function per screen
 *   router   hash -> view
 */
(function () {
  'use strict';

  const U = window.AkoreDashUtil;
  const esc = U.esc;

  // ── api ───────────────────────────────────────────────────────────────────────────────────
  const api = {
    async get(path, params) {
      const res = await fetch(await window.apiQuery(path, params || {}));
      if (!res.ok) throw new Error(await errText(res));
      return res.json();
    },
    async text(path, params) {
      const res = await fetch(await window.apiQuery(path, params || {}));
      if (!res.ok) throw new Error(await errText(res));
      return res.text();
    },
    async send(method, path, body) {
      const res = await fetch(await window.apiQuery(path, {}), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ session: window.akoreAuth.session() }, body || {}))
      });
      if (!res.ok) throw new Error(await errText(res));
      return res.json().catch(() => ({}));
    },
    async remove(path, params) {
      const res = await fetch(await window.apiQuery(path, params || {}), { method: 'DELETE' });
      if (!res.ok) throw new Error(await errText(res));
      return res.json().catch(() => ({}));
    }
  };
  async function errText(res) {
    const body = await res.json().catch(() => null);
    return (body && body.error) || ('HTTP ' + res.status);
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────
  const state = { customers: [], staff: [], me: null, loaded: false, staffLoaded: false };
  const slugify = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  const byCompany = co => state.customers.find(c => c.company === co);
  const isAdmin = () => (state.me || {}).role === 'admin';

  function fmtDate(v) {
    if (!v) return '—';
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── ui primitives ─────────────────────────────────────────────────────────────────────────
  const $ = sel => document.querySelector(sel);
  const content = () => document.getElementById('content');

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  const chip = (kind, text) => `<span class="chip ${kind}">${esc(text)}</span>`;

  /* One dialog implementation. Returns a promise of the collected values, or null if dismissed,
     so a caller reads as a single await rather than a pile of callbacks. */
  function dialog({ title, sub, fields = [], confirm = 'Guardar', danger = false, note = '' }) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'dlg-back';
      back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">
          <h2>${esc(title)}</h2>${sub ? `<p class="dlg-sub">${esc(sub)}</p>` : ''}
          <form id="dlg-form">
            ${fields.map(f => `<div class="field">
              <label for="f-${f.name}">${esc(f.label)}</label>
              ${f.type === 'select'
                ? `<select id="f-${f.name}" name="${f.name}">${f.options.map(o =>
                    `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
                : `<input id="f-${f.name}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}"
                     ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.required ? 'required' : ''}
                     autocomplete="off" spellcheck="false">`}
              ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
            </div>`).join('')}
            ${note ? `<div class="dlg-note">${note}</div>` : ''}
            <div class="dlg-err" id="dlg-err"></div>
            <div class="dlg-acts">
              <button type="button" class="btn" id="dlg-cancel">Cancelar</button>
              <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirm)}</button>
            </div>
          </form>
        </div>`;
      document.body.appendChild(back);
      const close = v => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
      back.querySelector('#dlg-cancel').onclick = () => close(null);
      back.querySelector('#dlg-form').onsubmit = e => {
        e.preventDefault();
        const out = {};
        fields.forEach(f => { out[f.name] = (back.querySelector('#f-' + f.name) || {}).value || ''; });
        close(out);
      };
      const first = back.querySelector('input, select');
      if (first) first.focus();
    });
  }

  /* Anything that changes what a customer sees, or removes an account, is re-authenticated.
     Matches the rule the rest of the platform already applies to destructive staff actions. */
  function confirmPassword(title, message) {
    if (!window.requirePassword) return Promise.resolve(true);
    return window.requirePassword({
      title, message,
      username: ((window.akoreAuth.who() || {}).username || ''),
      labels: { enter: 'Tu contraseña', confirm: 'Confirmar', cancel: 'Cancelar', wrong: 'Contraseña incorrecta' }
    });
  }

  /* Row actions live behind one control. Three naked buttons per row turns a table into a
     wall of verbs and makes the destructive one as prominent as the routine ones. */
  function rowMenu(items) {
    const id = 'm' + Math.random().toString(36).slice(2, 9);
    return `<span class="menu" id="${id}">
        <button class="menu-btn" aria-label="Acciones" data-menu-toggle="${id}">⋯</button>
        <span class="menu-pop">${items.map(i => i === '-' ? '<span class="menu-sep"></span>'
          : `<button class="${i.danger ? 'danger' : ''}" data-act="${esc(i.act)}" data-arg="${esc(i.arg || '')}">${esc(i.label)}</button>`).join('')}</span>
      </span>`;
  }
  document.addEventListener('click', e => {
    const tog = e.target.closest('[data-menu-toggle]');
    document.querySelectorAll('.menu.open').forEach(m => { if (!tog || m.id !== tog.dataset.menuToggle) m.classList.remove('open'); });
    if (!tog) return;
    const menu = document.getElementById(tog.dataset.menuToggle);
    const open = menu.classList.toggle('open');
    if (!open) return;
    /* The table clips its own overflow, which cut the last rows' menus in half. The popup is
       positioned against the viewport instead of the row, and flips above the button when there
       is not enough room below, so it is always whole. */
    const pop = menu.querySelector('.menu-pop');
    const r = tog.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = 'auto'; pop.style.bottom = 'auto';
    pop.style.left = Math.max(8, Math.min(r.right - 212, window.innerWidth - 220)) + 'px';
    const h = pop.offsetHeight || 150;
    if (r.bottom + 6 + h > window.innerHeight - 8) pop.style.top = Math.max(8, r.top - 6 - h) + 'px';
    else pop.style.top = (r.bottom + 6) + 'px';
  });

  // ── icons ─────────────────────────────────────────────────────────────────────────────────
  const ICON = {
    customers: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 20V9"/></svg>',
    users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 20a6.4 6.4 0 0 0-2.2-4.8"/></svg>',
    account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
  };

  // ── rail ──────────────────────────────────────────────────────────────────────────────────
  const NAV = [
    { id: 'clientes', label: 'Clientes', icon: 'customers' },
    { id: 'usuarios', label: 'Usuarios', icon: 'users' },
    { id: 'cuenta',   label: 'Mi cuenta', icon: 'account' }
  ];
  function renderRail(active) {
    document.getElementById('rail-nav').innerHTML = NAV.map(n =>
      `<button class="rail-item${n.id === active ? ' active' : ''}" data-go="${n.id}" title="${esc(n.label)}">
         <span class="rail-ico">${ICON[n.icon]}</span><span>${esc(n.label)}</span>
       </button>`).join('');
    document.getElementById('rail-foot').innerHTML =
      `<button class="rail-item" id="rail-logout"><span class="rail-ico">${ICON.out}</span><span>Cerrar sesión</span></button>`;
    document.getElementById('rail-logout').onclick = () => window.staffLogoutAll
      ? window.staffLogoutAll('/portal.html') : (sessionStorage.clear(), location.reload());
  }
  // Touch has no hover, so the rail would stay collapsed on a tablet; a tap pins it.
  function wireRail() {
    const rail = document.getElementById('rail');
    rail.addEventListener('click', e => {
      const go = e.target.closest('[data-go]');
      if (go) { location.hash = '#/' + go.dataset.go; return; }
      if (!window.matchMedia('(hover: hover)').matches) rail.classList.toggle('pinned');
    });
    document.addEventListener('click', e => { if (!rail.contains(e.target)) rail.classList.remove('pinned'); });
  }

  // ── data ──────────────────────────────────────────────────────────────────────────────────
  //
  // Two rules the front page is held to, both of them regressions once already:
  //
  //  * It asks for the directory BEFORE the session check answers, not after. The check costs a
  //    round trip to the server and the directory does not depend on its answer — every endpoint
  //    checks the session itself, so asking early risks nothing and saves the wait. Kicking this
  //    off at load, rather than inside start(), is the whole point; do not move it.
  //  * Opening it costs exactly one request. The staff list is only ever read by the users table,
  //    so it is fetched when that table is opened and not before — otherwise every visit to the
  //    customer list pays for a screen it is not showing.
  let directoryReq = null;
  function fetchDirectory() {
    directoryReq = api.get('/api/intake-codes', { directory: '1' }).catch(() => ({ items: [] }));
    return directoryReq;
  }
  fetchDirectory();

  async function loadCustomers(refetch) {
    const dir = await (refetch || !directoryReq ? fetchDirectory() : directoryReq);
    state.customers = dir.items || [];
    state.loaded = true;
  }

  async function loadStaff(refetch) {
    if (state.staffLoaded && !refetch) return;
    const r = await api.get('/api/staff-users', {}).catch(() => ({ items: [] }));
    state.staff = r.items || [];
    state.staffLoaded = true;
  }

  // ── view: clientes ────────────────────────────────────────────────────────────────────────
  let custQuery = '';
  function viewCustomers() {
    const q = custQuery.trim().toLowerCase();
    const items = q ? state.customers.filter(c => (c.company || '').toLowerCase().includes(q)) : state.customers;

    const step = (label, kind, text) =>
      `<div class="step"><span class="step-l">${label}</span>${chip(kind, text)}</div>`;

    const card = c => {
      const owner = (c.members || [])[0] || { username: slugify(c.company) };
      const intake = c.submittedAt ? step('Formulario', 'ok', 'Enviado') : step('Formulario', 'warn', 'Falta el cliente');
      const pr = c.promptsApprovedAt ? step('Prompts', 'ok', 'Aprobados')
        : c.promptsGeneratedAt ? step('Prompts', 'warn', 'Por revisar')
        : step('Prompts', 'idle', 'Aún no');
      const au = c.runCount ? step('Auditoría', 'ok', c.runCount + (c.runCount === 1 ? ' corrida' : ' corridas'))
        : step('Auditoría', 'idle', 'Aún no');
      return `<button class="card-link" data-customer="${esc(c.company)}">
          <span class="card-name">${esc(c.company)}</span>
          <span class="card-meta">${esc(owner.username)} · ${(c.members || []).length} ${(c.members || []).length === 1 ? 'usuario' : 'usuarios'}</span>
          <span class="steps">${intake}${pr}${au}</span>
          <span class="card-foot">
            <span class="dot ${c.monitoringEnabled ? '' : 'off'}"><i></i>${c.monitoringEnabled ? 'Monitoreo activo' : 'Monitoreo apagado'}</span>
            <span class="card-go">Abrir →</span>
          </span>
        </button>`;
    };

    content().className = 'content';
    content().innerHTML = `<div class="page">
        <div class="page-head">
          <div class="page-head-main">
            <h1 class="page-h1">Clientes</h1>
            <p class="page-sub">Todos los clientes de la plataforma, y en qué punto va cada uno.</p>
          </div>
          <div class="page-acts">
            <input type="search" id="cust-q" placeholder="Buscar clientes…" value="${esc(custQuery)}">
            <button class="btn btn-primary" id="new-customer">+ Nuevo cliente</button>
          </div>
        </div>
        <div class="toolbar"><span class="count">${items.length} ${items.length === 1 ? 'cliente' : 'clientes'}</span></div>
        ${!state.customers.length ? `<div class="empty">Todavía no hay clientes. Crea el primero para empezar.</div>`
          : !items.length ? `<div class="empty">Ningún cliente coincide con esa búsqueda.</div>`
          : `<div class="grid">${items.map(card).join('')}</div>`}
      </div>`;

    const qi = document.getElementById('cust-q');
    qi.addEventListener('input', e => { custQuery = e.target.value; viewCustomers(); document.getElementById('cust-q').focus(); });
    document.getElementById('new-customer').onclick = newCustomer;
    content().querySelectorAll('[data-customer]').forEach(el => {
      // The customer's own page is a real page with every tool on it. The console lists and
      // creates; it does not keep a thinner copy of that page alongside the real one.
      el.onclick = () => { location.href = '/index.html?company=' + encodeURIComponent(el.dataset.customer); };
    });
  }

  async function newCustomer() {
    const v = await dialog({
      title: 'Nuevo cliente',
      sub: 'Se crea la cuenta y su primer usuario. La contraseña se muestra una sola vez.',
      fields: [{ name: 'company', label: 'Nombre de la empresa', required: true, placeholder: 'Ej. Fiacsa' }],
      confirm: 'Crear cliente'
    });
    if (!v || !v.company.trim()) return;
    try {
      const out = await api.send('POST', '/api/intake-codes', { company: v.company.trim() });
      await loadCustomers(true); route();
      await dialog({
        title: 'Cliente creado',
        sub: 'Guarda estas credenciales ahora: la contraseña no vuelve a mostrarse.',
        fields: [],
        confirm: 'Listo',
        note: `<div><strong>${esc(out.company || v.company)}</strong></div>
               <div style="margin-top:8px;">Usuario <code>${esc(out.username || '')}</code></div>
               <div style="margin-top:6px;">Contraseña <code>${esc(out.password || '')}</code></div>`
      });
    } catch (e) { toast('No se pudo crear: ' + e.message); }
  }

  // ── view: cliente ─────────────────────────────────────────────────────────────────────────






  // ── view: usuarios ────────────────────────────────────────────────────────────────────────
  let usersFilter = 'todos', usersQuery = '';

  /* Internal staff and customer accounts are one population with one question attached — who can
     get in, as what — so they are one table with a Type column, not two screens that drift. */
  function allUsers() {
    const internal = state.staff.map(u => ({
      kind: 'interno', username: u.username, role: u.role || 'staff',
      company: 'Akore Labs', twoFactor: !!u.twoFactorEnabled, createdAt: u.createdAt
    }));
    const external = state.customers.flatMap(c => (c.members || []).map((m, i) => ({
      kind: 'externo', username: m.username, role: m.role || 'full',
      company: c.company, twoFactor: !!m.twoFactorEnabled, createdAt: m.createdAt, owner: i === 0
    })));
    return internal.concat(external);
  }

  const roleLabel = window.akoreRoleLabel;   // one definition, in portal-rail.js

  function viewUsers() {
    /* The staff list is this table's alone, so this is where it is fetched. Render first from
       whatever is held and fill in when it lands: the customer accounts are already here, and a
       table that appears half-populated reads better than a blank screen that appears all at
       once, later. Re-renders only if this view is still the one on screen. */
    if (!state.staffLoaded) {
      loadStaff().then(() => { if ((location.hash || '').indexOf('usuarios') !== -1) viewUsers(); });
    }
    const q = usersQuery.trim().toLowerCase();
    let list = allUsers();
    if (usersFilter === 'internos') list = list.filter(u => u.kind === 'interno');
    if (usersFilter === 'externos') list = list.filter(u => u.kind === 'externo');
    if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.company.toLowerCase().includes(q));
    list.sort((a, b) => a.kind.localeCompare(b.kind) || a.company.localeCompare(b.company) || a.username.localeCompare(b.username));

    const row = u => {
      const acts = [];
      if (u.kind === 'interno') {
        if (isAdmin()) {
          if (u.twoFactor) acts.push({ act: 'reset2fa', arg: u.username, label: 'Restablecer autenticador' });
          if (u.username !== (state.me || {}).username) { acts.push('-'); acts.push({ act: 'rmstaff', arg: u.username, label: 'Quitar del equipo', danger: true }); }
        }
      } else {
        acts.push({ act: 'resetpw', arg: u.username + '|' + u.company, label: 'Restablecer contraseña' });
        if (u.twoFactor) acts.push({ act: 'reset2fa', arg: u.username, label: 'Restablecer autenticador' });
        if (!u.owner) { acts.push('-'); acts.push({ act: 'rmmember', arg: u.username + '|' + u.company, label: 'Quitar acceso', danger: true }); }
      }
      return `<tr>
          <td><div class="u-name">${esc(u.username)}</div><div class="u-sub">${esc(u.company)}</div></td>
          <td>${chip(u.kind === 'interno' ? 'info' : 'idle', u.kind === 'interno' ? 'Interno' : 'Externo')}</td>
          <td>${esc(roleLabel(u.role))}${u.owner ? ' <span class="count">· principal</span>' : ''}</td>
          <td>${u.twoFactor ? chip('ok', 'Configurado') : chip('warn', 'Sin configurar')}</td>
          <td>${esc(fmtDate(u.createdAt))}</td>
          <td class="right">${acts.length ? rowMenu(acts) : '<span class="count">—</span>'}</td>
        </tr>`;
    };

    const counts = allUsers();
    content().className = 'content';
    content().innerHTML = `<div class="page">
        <div class="page-head">
          <div class="page-head-main">
            <h1 class="page-h1">Usuarios</h1>
            <p class="page-sub">Todas las cuentas que pueden entrar a la plataforma: el equipo de Akore y los usuarios de cada cliente.</p>
          </div>
          ${isAdmin() ? `<div class="page-acts"><button class="btn btn-primary" id="new-user">+ Nuevo usuario</button></div>` : ''}
        </div>
        <div class="toolbar">
          <div class="seg">
            <button class="${usersFilter === 'todos' ? 'active' : ''}" data-filter="todos">Todos (${counts.length})</button>
            <button class="${usersFilter === 'internos' ? 'active' : ''}" data-filter="internos">Internos (${counts.filter(u => u.kind === 'interno').length})</button>
            <button class="${usersFilter === 'externos' ? 'active' : ''}" data-filter="externos">Externos (${counts.filter(u => u.kind === 'externo').length})</button>
          </div>
          <input type="search" id="users-q" placeholder="Buscar por usuario o empresa…" value="${esc(usersQuery)}">
          <span class="count">${list.length} ${list.length === 1 ? 'cuenta' : 'cuentas'}</span>
        </div>
        ${list.length ? `<div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Cuenta</th><th>Tipo</th><th>Rol</th><th>Autenticación de dos pasos</th><th>Creada</th><th></th></tr></thead>
            <tbody>${list.map(row).join('')}</tbody>
          </table></div>` : `<div class="empty">Ninguna cuenta coincide.</div>`}
      </div>`;

    content().querySelectorAll('[data-filter]').forEach(b => { b.onclick = () => { usersFilter = b.dataset.filter; viewUsers(); }; });
    const qi = document.getElementById('users-q');
    qi.addEventListener('input', e => { usersQuery = e.target.value; viewUsers(); document.getElementById('users-q').focus(); });
    const nu = document.getElementById('new-user');
    if (nu) nu.onclick = newUser;
    content().querySelectorAll('[data-act]').forEach(b => { b.onclick = () => userAction(b.dataset.act, b.dataset.arg); });
  }

  async function newUser() {
    const v = await dialog({
      title: 'Nuevo usuario',
      sub: 'Interno es alguien de Akore con acceso a esta consola. Externo es un usuario de un cliente.',
      fields: [
        { name: 'kind', label: 'Tipo', type: 'select', value: 'externo',
          options: [{ value: 'externo', label: 'Externo — usuario de un cliente' }, { value: 'interno', label: 'Interno — equipo de Akore' }] },
        { name: 'company', label: 'Cliente', type: 'select', value: (state.customers[0] || {}).company || '',
          options: state.customers.map(c => ({ value: c.company, label: c.company })),
          hint: 'Solo aplica a usuarios externos.' },
        { name: 'username', label: 'Usuario', required: true, placeholder: 'nombre.apellido' },
        { name: 'role', label: 'Rol', type: 'select', value: 'full',
          options: [{ value: 'full', label: 'Acceso completo' }, { value: 'viewer', label: 'Solo lectura' }, { value: 'admin', label: 'Administrador (interno)' }] }
      ],
      confirm: 'Crear usuario'
    });
    if (!v || !v.username.trim()) return;
    try {
      let out;
      if (v.kind === 'interno') {
        out = await api.send('POST', '/api/staff-users', { username: v.username.trim(), role: v.role === 'admin' ? 'admin' : 'staff' });
      } else {
        out = await api.send('POST', '/api/intake-codes', { company: v.company, username: v.username.trim(), role: v.role === 'viewer' ? 'viewer' : 'full' });
      }
      await Promise.all([loadCustomers(true), loadStaff(true)]); viewUsers();
      await dialog({
        title: 'Usuario creado', sub: 'Guarda la contraseña ahora: no vuelve a mostrarse.', fields: [], confirm: 'Listo',
        note: `<div>Usuario <code>${esc(out.username || v.username)}</code></div>
               <div style="margin-top:6px;">Contraseña <code>${esc(out.password || '—')}</code></div>`
      });
    } catch (e) { toast('No se pudo crear: ' + e.message); }
  }

  async function userAction(act, arg) {
    const [username, company] = String(arg).split('|');
    try {
      if (act === 'resetpw') {
        if (!(await confirmPassword('Restablecer contraseña', `Se genera una contraseña nueva para <strong>${esc(username)}</strong>. La anterior deja de servir.`))) return;
        const out = await api.send('PATCH', '/api/intake-codes', { company, username, resetPassword: true });
        await dialog({ title: 'Contraseña restablecida', sub: 'Compártela con la persona; no vuelve a mostrarse.', fields: [], confirm: 'Listo',
          note: `<div>Usuario <code>${esc(username)}</code></div><div style="margin-top:6px;">Contraseña <code>${esc(out.password || '—')}</code></div>` });
      } else if (act === 'reset2fa') {
        if (!(await confirmPassword('Restablecer autenticador', `<strong>${esc(username)}</strong> tendrá que volver a configurar su app de dos pasos al entrar.`))) return;
        await api.send('POST', '/api/enroll', { action: 'reset', username });
        toast('Autenticador restablecido');
      } else if (act === 'rmmember') {
        if (!(await confirmPassword('Quitar acceso', `<strong>${esc(username)}</strong> dejará de poder entrar a ${esc(company)}.`))) return;
        await api.remove('/api/intake-codes', { company, username });
        toast('Acceso retirado');
      } else if (act === 'rmstaff') {
        if (!(await confirmPassword('Quitar del equipo', `<strong>${esc(username)}</strong> perderá el acceso a esta consola.`))) return;
        await api.remove('/api/staff-users', { username });
        toast('Usuario retirado');
      }
      await Promise.all([loadCustomers(true), loadStaff(true)]); viewUsers();
    } catch (e) { toast('No se pudo completar: ' + e.message); }
  }

  // ── view: mi cuenta ───────────────────────────────────────────────────────────────────────
  const LANGS = [['es', 'Español'], ['en', 'English']];
  const curLang = () => { try { return localStorage.getItem('hieronymus_lang') || 'es'; } catch (e) { return 'es'; } };

  /* A menu, not a page with every control open at once. Each item opens its own screen, so
     arriving here does not confront you with three password boxes you did not come for. */
  function viewAccount(pane) {
    const me = state.me || {};
    const c = content();
    c.className = 'content';
    const head = (title, sub) => `
      <div class="page-head"><div class="page-head-main">
        <button class="btn btn-sm btn-quiet" style="margin-bottom:14px;" onclick="location.hash='#/cuenta'">&larr; Mi cuenta</button>
        <h1 class="page-h1">${esc(title)}</h1><p class="page-sub">${esc(sub)}</p>
      </div></div>`;

    if (pane === 'idioma') {
      const lang = curLang();
      c.innerHTML = `<div class="page acct">
          ${head('Idioma', 'El idioma con el que abren las páginas bilingües: los tableros, el formulario y las páginas del cliente.')}
          <div class="panel">
            <div class="seg">${LANGS.map(([id, name]) =>
              `<button class="${lang === id ? 'active' : ''}" data-lang="${id}">${name}</button>`).join('')}</div>
            <p class="panel-sub" style="margin:16px 0 0;">La consola interna todavía está solo en español.</p>
          </div>
        </div>`;
      c.querySelectorAll('[data-lang]').forEach(btn => {
        btn.onclick = () => {
          try { localStorage.setItem('hieronymus_lang', btn.dataset.lang); } catch (e) {}
          viewAccount('idioma');
          toast('Idioma guardado');
        };
      });
      return;
    }

    if (pane === 'password') {
      c.innerHTML = `<div class="page acct">
          ${head('Cambiar contraseña', 'Cambiarla cierra tu sesión en todos los dispositivos, incluido este.')}
          <div class="panel">
            <div class="field-grid">
              <input type="password" id="ac-cur" placeholder="Contraseña actual" autocomplete="current-password">
              <input type="password" id="ac-new" placeholder="Contraseña nueva (mínimo 6)" autocomplete="new-password">
              <input type="password" id="ac-rep" placeholder="Repite la nueva" autocomplete="new-password">
            </div>
            <button class="btn btn-primary" id="ac-save">Cambiar contraseña</button>
            <div class="field-msg" id="ac-msg"></div>
          </div>
        </div>`;
      document.getElementById('ac-save').onclick = changeOwnPassword;
      document.getElementById('ac-cur').focus();
      return;
    }

    if (pane === 'twofa') {
      c.innerHTML = `<div class="page acct">
          ${head('Autenticación de dos pasos', 'Tu cuenta pide un código de tu app de autenticación además de la contraseña.')}
          <div class="panel">
            <div class="acct" style="margin-bottom:16px;">
              <span>Autenticador: <strong>${me.twoFactorEnabled === false ? 'sin configurar' : 'configurado'}</strong></span>
            </div>
            <button class="btn" id="ac-rec">Generar códigos de recuperación</button>
            <div class="field-msg" id="ac-rec-msg"></div>
            <p class="panel-sub" style="margin:18px 0 0;">Para cambiar de teléfono o de app necesitas que un administrador reinicie tu autenticador — todavía no se puede hacer desde aquí.</p>
          </div>
        </div>`;
      document.getElementById('ac-rec').onclick = newRecoveryCodes;
      return;
    }

    const row = (id, title, desc, value) => `
      <button class="set-row" onclick="location.hash='#/cuenta/${id}'">
        <span class="set-row-main">
          <span class="set-row-title">${esc(title)}</span>
          <span class="set-row-desc">${esc(desc)}</span>
        </span>
        ${value ? `<span class="set-row-value">${esc(value)}</span>` : ''}
        <span class="set-row-chev">&rsaquo;</span>
      </button>`;

    c.innerHTML = `<div class="page acct">
        <div class="page-head"><div class="page-head-main">
          <h1 class="page-h1">Mi cuenta</h1>
          <p class="page-sub">Tu acceso a la consola: ${esc(me.username || '')}${me.role ? ' · ' + esc(roleLabel(me.role)) : ''}.</p>
        </div></div>
        <div class="set-list">
          ${row('idioma', 'Idioma', 'El idioma de las páginas bilingües.', curLang() === 'en' ? 'English' : 'Español')}
          ${row('password', 'Contraseña', 'Cambiar la contraseña con la que entras.', '')}
          ${row('twofa', 'Autenticación de dos pasos', 'Autenticador y códigos de recuperación.',
                me.twoFactorEnabled === false ? 'Sin configurar' : 'Configurado')}
        </div>
      </div>`;
  }

  /* The auth endpoints answer in English. The console is in Spanish, so the handful of messages a
     person actually hits are translated on the way out — the server keeps saying what it says. */
  const ERR_ES = {
    'Current password is incorrect': 'La contraseña actual no es correcta.',
    'Invalid username or password': 'La contraseña no es correcta.',
    'Enter your password to get new recovery codes.': 'Escribe tu contraseña para generar códigos nuevos.',
    'Sign in to get new recovery codes.': 'Tu sesión caducó. Vuelve a iniciar sesión.',
    'Set up an authenticator first.': 'Primero configura un autenticador.'
  };
  const errEs = m => ERR_ES[String(m || '').trim()] || m;

  async function changeOwnPassword() {
    const cur = document.getElementById('ac-cur').value;
    const nw  = document.getElementById('ac-new').value;
    const rep = document.getElementById('ac-rep').value;
    const msg = document.getElementById('ac-msg');
    const fail = text => { msg.className = 'field-msg bad'; msg.textContent = text; };
    if (!cur || !nw) return fail('Completa los tres campos.');
    if (nw.length < 6) return fail('La contraseña nueva necesita al menos 6 caracteres.');
    if (nw !== rep) return fail('Las dos contraseñas nuevas no coinciden.');
    msg.className = 'field-msg';
    msg.textContent = 'Cambiando…';
    try {
      /* The server asks for the current password as well as the session, so a borrowed session
         cannot lock its owner out, and it then retires every session — including this one. */
      await api.send('PATCH', '/api/staff-users',
        { username: (state.me || {}).username, currentPassword: cur, newPassword: nw });
      msg.className = 'field-msg ok';
      msg.textContent = 'Contraseña cambiada. Vuelve a iniciar sesión…';
      setTimeout(() => location.reload(), 1400);
    } catch (e) { fail(errEs(e.message)); }
  }

  async function newRecoveryCodes() {
    const got = await dialog({
      title: 'Generar códigos de recuperación',
      sub: 'Los códigos anteriores dejarán de servir. Los nuevos se muestran una sola vez.',
      fields: [{ name: 'password', label: 'Tu contraseña', type: 'password', required: true }],
      confirm: 'Generar'
    });
    if (!got) return;
    const msg = document.getElementById('ac-rec-msg');
    msg.className = 'field-msg';
    msg.textContent = 'Generando…';
    try {
      /* The endpoint resolves the account from `username`; session + password alone is a 401. */
      const r = await api.send('POST', '/api/enroll',
        { action: 'recovery', username: (state.me || {}).username, password: got.password });
      const codes = r.recoveryCodes || r.codes || [];
      msg.className = 'field-msg ok';
      msg.innerHTML = `<strong>Guárdalos ahora — no se vuelven a mostrar.</strong>
        <div class="codes">${codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>`;
    } catch (e) { msg.className = 'field-msg bad'; msg.textContent = errEs(e.message); }
  }

  // ── router ────────────────────────────────────────────────────────────────────────────────
  function route() {
    const h = (location.hash || '').replace(/^#\//, '');
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'cliente' && parts[1]) {
      location.replace('/index.html?company=' + encodeURIComponent(decodeURIComponent(parts[1])));
      return;
    }
    if (parts[0] === 'usuarios') return viewUsers();
    if (parts[0] === 'cuenta') return viewAccount(parts[1]);
    return viewCustomers();
  }
  window.addEventListener('hashchange', route);

  // ── boot ──────────────────────────────────────────────────────────────────────────────────
  async function start() {
    document.getElementById('shell').hidden = false;
    state.me = window.akoreAuth.who() || {};
    if (window.akoreMountRail) window.akoreMountRail();
    try { await loadCustomers(); } catch (e) { toast('No se pudieron cargar los datos: ' + e.message); }
    route();
  }

  // Nothing renders until the server confirms a live staff session; a value in storage proves
  // nothing on its own. There is one sign-in page and this is not it — this console briefly grew
  // its own form, which is six sign-in forms again, each with its own strings and its own handling
  // of a code. Send them to the one that exists, remembering where they were headed.
  window.akoreRequireStaff()
    .then(gate => { if (gate && gate.ok) start(); else if (!gate || !gate.redirecting) window.akoreGoToLogin(); })
    .catch(() => window.akoreGoToLogin());
})();
