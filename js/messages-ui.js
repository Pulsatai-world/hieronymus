/* The inbox, as both sides see it.
 *
 * One implementation for the client portal and the staff console, rather than one per app: the
 * two would otherwise drift, and the place they drift is exactly the one that matters here —
 * which side a message is from and who is allowed to see it. The server decides the second; this
 * file only draws what it is given.
 *
 *   AkoreMessages.mount(el, { side: 'client' | 'staff', company, customers, lang, onUnread })
 *     (who "You" is comes from the signed-in session, window.akoreAuth.who())
 *     side        whose inbox this is
 *     company     client: their company (shown, never sent as a claim — the server uses the session)
 *     customers   staff: company names to offer when starting a conversation
 *     onUnread    called with the unread count whenever it is refreshed
 *   AkoreMessages.unread(company?)  -> Promise<number>, for a sidebar badge
 *
 * Message text is only ever set as text, never parsed as HTML: what one side types is rendered on
 * the other side's screen, and that is not a place to be running anybody's markup.
 */
(function () {
  'use strict';

  const POLL_MS = 30000;

  const T = {
    title:      { en: 'Messages', es: 'Mensajes' },
    subClient:  { en: 'Questions for the Akore team. Everyone at your company can see these conversations.',
                  es: 'Preguntas para el equipo de Akore. Todos en tu empresa pueden ver estas conversaciones.' },
    subStaff:   { en: 'Every customer conversation. Unread ones are listed first.',
                  es: 'Todas las conversaciones con clientes. Las que no se han leído aparecen primero.' },
    newBtn:     { en: '+ New conversation', es: '+ Nueva conversación' },
    none:       { en: 'No conversations yet.', es: 'Todavía no hay conversaciones.' },
    noneClient: { en: 'No conversations yet. Have a question? Start one and the Akore team will reply here.',
                  es: 'Todavía no hay conversaciones. ¿Tienes una pregunta? Empieza una y el equipo de Akore te responderá aquí.' },
    pick:       { en: 'Pick a conversation on the left.', es: 'Elige una conversación de la lista.' },
    customer:   { en: 'Customer', es: 'Cliente' },
    choose:     { en: 'Choose a customer…', es: 'Elige un cliente…' },
    subject:    { en: 'Subject', es: 'Asunto' },
    subjectPh:  { en: 'What is it about?', es: '¿De qué se trata?' },
    message:    { en: 'Message', es: 'Mensaje' },
    replyPh:    { en: 'Write a reply…', es: 'Escribe una respuesta…' },
    firstPh:    { en: 'Write your message…', es: 'Escribe tu mensaje…' },
    send:       { en: 'Send', es: 'Enviar' },
    sending:    { en: 'Sending…', es: 'Enviando…' },
    cancel:     { en: 'Cancel', es: 'Cancelar' },
    akore:      { en: 'Akore', es: 'Akore' },
    you:        { en: 'You', es: 'Tú' },
    needAll:    { en: 'Fill in every field.', es: 'Completa todos los campos.' },
    failed:     { en: 'Could not send: ', es: 'No se pudo enviar: ' },
    loadFailed: { en: 'Could not load messages.', es: 'No se pudieron cargar los mensajes.' },
    replyNote:  { en: 'The Akore team usually replies within one business day.',
                  es: 'El equipo de Akore suele responder en un día hábil.' },
    hint:       { en: 'Ctrl+Enter to send', es: 'Ctrl+Enter para enviar' },
    count:      { en: n => n + (n === 1 ? ' conversation' : ' conversations'),
                  es: n => n + (n === 1 ? ' conversación' : ' conversaciones') }
  };

  const CSS = `
.msg-page { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 26px 38px 22px; box-sizing: border-box; }
.msg-head { margin-bottom: 18px; }
.msg-h1 { font-family: var(--font-display, sans-serif); font-size: 26px; font-weight: 700; color: var(--ink-950, #08090c); }
.msg-sub { font-size: 14px; color: var(--ink-60, #5b6472); margin-top: 5px; max-width: 72ch; line-height: 1.55; }
.msg { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 340px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr); background: #fff; border: 1px solid var(--ink-100, #e3e6ea);
  border-radius: 16px; overflow: hidden; box-shadow: var(--shadow-sm); }
.msg-side { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--ink-100, #e3e6ea); background: var(--ink-50, #f4f6f8); }
.msg-side-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 14px 10px; }
.msg-count { font-size: 12px; color: var(--ink-60, #5b6472); }
.msg-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.msg-item { text-align: left; font: inherit; background: #fff; border: 1px solid var(--ink-100, #e3e6ea); border-left: 3px solid transparent;
  border-radius: 10px; padding: 10px 12px; cursor: pointer; display: block; width: 100%; }
.msg-item:hover { border-color: var(--violet-300, #bcaef7); }
.msg-item.active { border-left-color: var(--violet-600, #6d4fe0); box-shadow: var(--shadow-md); }
.msg-item-top { display: flex; align-items: center; gap: 8px; }
.msg-item-subj { font-weight: 600; font-size: 13.5px; color: var(--ink-950, #08090c); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-item.unread .msg-item-subj { font-weight: 800; }
.msg-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--emerald-500, #1ea97c); flex: 0 0 9px; }
.msg-item-meta { font-size: 12px; color: var(--ink-60, #5b6472); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-main { display: flex; flex-direction: column; min-height: 0; }
.msg-main-head { padding: 16px 22px 12px; border-bottom: 1px solid var(--ink-100, #e3e6ea); }
.msg-main-subj { font-family: var(--font-display, sans-serif); font-weight: 700; font-size: 17px; }
.msg-main-co { font-size: 12.5px; color: var(--ink-60, #5b6472); margin-top: 2px; }
.msg-thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }
.msg-bubble { max-width: 78%; align-self: flex-start; }
.msg-bubble.mine { align-self: flex-end; }
.msg-bubble-meta { font-size: 11.5px; color: var(--ink-60, #5b6472); margin: 0 4px 4px; }
.msg-bubble.mine .msg-bubble-meta { text-align: right; }
.msg-bubble-text { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.5; padding: 10px 14px;
  border-radius: 14px; background: var(--ink-50, #f4f6f8); border: 1px solid var(--ink-100, #e3e6ea); color: var(--ink-950, #08090c); }
.msg-bubble.mine .msg-bubble-text { background: var(--violet-600, #6d4fe0); border-color: var(--violet-600, #6d4fe0); color: #fff; }
.msg-compose { border-top: 1px solid var(--ink-100, #e3e6ea); padding: 12px 16px 14px; }
.msg-compose textarea, .msg-form input, .msg-form select, .msg-form textarea {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; color: var(--ink-950, #08090c); background: #fff;
  border: 1px solid var(--ink-200, #c3c8d0); border-radius: 10px; padding: 10px 12px; outline: none; resize: vertical; }
.msg-compose textarea { min-height: 64px; max-height: 220px; }
.msg-compose textarea:focus, .msg-form input:focus, .msg-form select:focus, .msg-form textarea:focus {
  border-color: var(--violet-400, #9b86f2); box-shadow: 0 0 0 3px rgba(109,79,224,.12); }
.msg-compose-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
.msg-hint { font-size: 12px; color: var(--ink-60, #5b6472); }
.msg-err { font-size: 12.5px; color: #b3261e; }
.msg-btn { font: inherit; font-size: 13.5px; font-weight: 600; border-radius: 999px; padding: 9px 18px; cursor: pointer;
  border: 1px solid var(--violet-600, #6d4fe0); background: var(--violet-600, #6d4fe0); color: #fff; white-space: nowrap; }
.msg-btn:hover { background: var(--violet-700, #4834b0); }
.msg-btn:disabled { opacity: .5; cursor: default; }
.msg-btn.ghost { background: #fff; color: var(--violet-600, #6d4fe0); border-color: var(--ink-200, #c3c8d0); }
.msg-btn.sm { font-size: 12.5px; padding: 7px 12px; }
.msg-form { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; max-width: 640px; overflow-y: auto; }
.msg-form label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-60, #5b6472); display: block; margin-bottom: 6px; }
.msg-form textarea { min-height: 140px; }
.msg-form-acts { display: flex; gap: 10px; align-items: center; }
.msg-empty { margin: auto; padding: 30px; text-align: center; color: var(--ink-60, #5b6472); font-size: 14px; max-width: 46ch; line-height: 1.55; }
.msg-list .msg-empty { margin: 20px 4px; padding: 16px; }
.msg-back { display: none; }
@media (max-width: 760px) {
  .msg-page { padding: 18px 16px 14px; }
  .msg { grid-template-columns: 1fr; }
  .msg.reading .msg-side { display: none; }
  .msg:not(.reading) .msg-main { display: none; }
  .msg-back { display: inline-flex; margin-bottom: 6px; }
  .msg-bubble { max-width: 92%; }
}`;

  function styles() {
    if (document.getElementById('akore-messages-css')) return;
    const st = document.createElement('style');
    st.id = 'akore-messages-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function getJson(params) {
    const res = await fetch(await window.apiQuery('/api/messages', params || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async function send(method, body) {
    const res = await fetch('/api/messages', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ session: window.akoreAuth.session() }, body))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /**
   * The unread count for a sidebar badge. Never throws: a badge that fails is just no badge.
   * With a company, that company's conversations (a customer's are always their own, whatever is
   * named); without one, a staff member's whole inbox.
   */
  async function unread(company) {
    try { return (await getJson({ count: '1', company: company || '' })).unread || 0; } catch (e) { return 0; }
  }

  function mount(root, opts) {
    const o = opts || {};
    const side = o.side === 'staff' ? 'staff' : 'client';
    const lang = o.lang === 'en' ? 'en' : 'es';
    const me = String(((window.akoreAuth && window.akoreAuth.who && window.akoreAuth.who()) || {}).username || '').toLowerCase();
    const t = (k, ...a) => { const v = (T[k] || {})[lang]; return typeof v === 'function' ? v(...a) : (v == null ? k : v); };
    const locale = lang === 'es' ? 'es-MX' : 'en-US';
    const when = v => {
      const d = new Date(v);
      if (isNaN(d)) return '';
      const sameDay = d.toDateString() === new Date().toDateString();
      return sameDay ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
                     : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ', ' +
                       d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    };
    // For a client a company is implied; staff address every thread by its company.
    const companyParam = th => (side === 'staff' ? (th ? th.company : '') : (o.company || ''));

    styles();
    const state = { threads: [], open: null, composing: false, messages: [], timer: null };

    root.innerHTML = '';
    const page = el('div', 'msg-page');
    const head = el('div', 'msg-head');
    head.appendChild(el('div', 'msg-h1', t('title')));
    head.appendChild(el('div', 'msg-sub', side === 'staff' ? t('subStaff') : t('subClient')));
    const box = el('div', 'msg');
    const sideEl = el('aside', 'msg-side');
    const top = el('div', 'msg-side-top');
    const count = el('span', 'msg-count');
    const newBtn = el('button', 'msg-btn sm', t('newBtn'));
    newBtn.type = 'button';
    top.appendChild(count); top.appendChild(newBtn);
    const list = el('div', 'msg-list');
    sideEl.appendChild(top); sideEl.appendChild(list);
    const main = el('section', 'msg-main');
    box.appendChild(sideEl); box.appendChild(main);
    page.appendChild(head); page.appendChild(box);
    root.appendChild(page);

    newBtn.onclick = () => { state.open = null; state.composing = true; paintList(); paintMain(); };

    function backButton() {
      const b = el('button', 'msg-btn ghost sm msg-back', '← ' + t('title'));
      b.type = 'button';
      b.onclick = () => { state.open = null; state.composing = false; paintList(); paintMain(); };
      return b;
    }

    function paintList() {
      list.innerHTML = '';
      count.textContent = t('count', state.threads.length);
      if (!state.threads.length) {
        list.appendChild(el('div', 'msg-empty', side === 'client' ? t('noneClient') : t('none')));
      }
      for (const th of state.threads) {
        const b = el('button', 'msg-item' + (th.unread ? ' unread' : '') +
          (state.open && state.open.id === th.id && state.open.company === th.company ? ' active' : ''));
        b.type = 'button';
        const row = el('div', 'msg-item-top');
        if (th.unread) row.appendChild(el('span', 'msg-dot'));
        row.appendChild(el('span', 'msg-item-subj', th.subject));
        b.appendChild(row);
        const meta = (side === 'staff' ? th.company + ' · ' : '') + when(th.lastAt || th.createdAt);
        b.appendChild(el('div', 'msg-item-meta', meta));
        b.onclick = () => openThread(th);
        list.appendChild(b);
      }
      box.classList.toggle('reading', !!(state.open || state.composing));
      if (o.onUnread) o.onUnread(state.threads.filter(x => x.unread).length);
    }

    // Messages line up by side (ours on the right), but the label names the person: a company has
    // several logins, and "You" on a colleague's message would say the wrong thing about who wrote it.
    // A client sees Akore as Akore; staff see which of us replied.
    function authorLabel(m) {
      if (m.author && m.author === me) return t('you');
      if (m.from === 'staff') return side === 'staff' ? t('akore') + ' · ' + m.author : t('akore');
      return m.author;
    }

    function paintMain() {
      main.innerHTML = '';
      if (state.composing) return paintNew();
      const th = state.open;
      if (!th) { main.appendChild(el('div', 'msg-empty', state.threads.length ? t('pick') : (side === 'client' ? t('noneClient') : t('none')))); return; }

      const h = el('div', 'msg-main-head');
      h.appendChild(backButton());
      h.appendChild(el('div', 'msg-main-subj', th.subject));
      if (side === 'staff') h.appendChild(el('div', 'msg-main-co', th.company));
      main.appendChild(h);

      const thread = el('div', 'msg-thread');
      for (const m of state.messages) {
        const b = el('div', 'msg-bubble' + (m.from === side ? ' mine' : ''));
        b.appendChild(el('div', 'msg-bubble-meta', authorLabel(m) + ' · ' + when(m.sentAt)));
        b.appendChild(el('div', 'msg-bubble-text', m.text));
        thread.appendChild(b);
      }
      main.appendChild(thread);
      thread.scrollTop = thread.scrollHeight;

      const c = el('div', 'msg-compose');
      const ta = el('textarea');
      ta.placeholder = t('replyPh');
      ta.maxLength = 4000;
      const row = el('div', 'msg-compose-row');
      const hint = el('span', 'msg-hint', side === 'client' ? t('replyNote') : t('hint'));
      const btn = el('button', 'msg-btn', t('send'));
      btn.type = 'button';
      row.appendChild(hint); row.appendChild(btn);
      c.appendChild(ta); c.appendChild(row);
      main.appendChild(c);

      const go = async () => {
        const text = ta.value.trim();
        if (!text) return;
        btn.disabled = true; btn.textContent = t('sending');
        try {
          await send('POST', { company: companyParam(th), thread: th.id, text });
          ta.value = '';
          await loadThread(th, true);
          await loadList();
        } catch (e) {
          hint.className = 'msg-err'; hint.textContent = t('failed') + e.message;
        } finally { btn.disabled = false; btn.textContent = t('send'); }
      };
      btn.onclick = go;
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    }

    function paintNew() {
      const f = el('div', 'msg-form');
      f.appendChild(backButton());
      let pick = null;
      if (side === 'staff') {
        const w = el('div');
        w.appendChild(el('label', '', t('customer')));
        pick = el('select');
        const first = el('option', '', t('choose')); first.value = '';
        pick.appendChild(first);
        for (const name of (o.customers || []).slice().sort((a, b) => a.localeCompare(b))) {
          const op = el('option', '', name); op.value = name; pick.appendChild(op);
        }
        w.appendChild(pick); f.appendChild(w);
      }
      const ws = el('div');
      ws.appendChild(el('label', '', t('subject')));
      const subj = el('input'); subj.maxLength = 120; subj.placeholder = t('subjectPh');
      ws.appendChild(subj); f.appendChild(ws);
      const wm = el('div');
      wm.appendChild(el('label', '', t('message')));
      const ta = el('textarea'); ta.maxLength = 4000; ta.placeholder = t('firstPh');
      wm.appendChild(ta); f.appendChild(wm);
      const acts = el('div', 'msg-form-acts');
      const btn = el('button', 'msg-btn', t('send')); btn.type = 'button';
      const cancel = el('button', 'msg-btn ghost', t('cancel')); cancel.type = 'button';
      const err = el('span', 'msg-err');
      acts.appendChild(btn); acts.appendChild(cancel); acts.appendChild(err);
      f.appendChild(acts);
      if (side === 'client') f.appendChild(el('div', 'msg-hint', t('replyNote')));
      main.appendChild(f);
      (pick || subj).focus();

      cancel.onclick = () => { state.composing = false; paintList(); paintMain(); };
      btn.onclick = async () => {
        const company = pick ? pick.value : (o.company || '');
        if (!subj.value.trim() || !ta.value.trim() || (pick && !company)) { err.textContent = t('needAll'); return; }
        btn.disabled = true; btn.textContent = t('sending'); err.textContent = '';
        try {
          const r = await send('POST', { company, subject: subj.value, text: ta.value });
          state.composing = false;
          await loadList();
          await openThread(r.thread);
        } catch (e) {
          err.textContent = t('failed') + e.message;
          btn.disabled = false; btn.textContent = t('send');
        }
      };
    }

    async function loadList() {
      const data = await getJson({ company: side === 'client' ? (o.company || '') : '' });
      state.threads = data.threads || [];
      paintList();
    }

    async function loadThread(th, repaint) {
      const data = await getJson({ company: companyParam(th), thread: th.id });
      const grew = data.messages.length !== state.messages.length;
      state.messages = data.messages || [];
      // Opening a conversation that had something new marks it read for this whole side.
      const listed = state.threads.find(x => x.id === th.id && x.company === th.company);
      if (listed && listed.unread) {
        await send('PATCH', { company: companyParam(th), thread: th.id }).catch(() => {});
        listed.unread = 0;
      }
      if (repaint || grew) paintMain();
    }

    async function openThread(th) {
      state.composing = false;
      state.open = state.threads.find(x => x.id === th.id && x.company === th.company) || th;
      state.messages = [];
      paintList();
      try { await loadThread(state.open, true); } catch (e) { main.innerHTML = ''; main.appendChild(el('div', 'msg-empty', t('loadFailed'))); }
      paintList();
    }

    // Keeps both lists current while the screen is open, and stops once it has been navigated away
    // from — a detached inbox polling forever would be a request every 30s for nobody.
    async function tick() {
      if (!document.body.contains(page)) { clearInterval(state.timer); return; }
      try {
        await loadList();
        if (state.open && !state.composing) {
          const ta = main.querySelector('textarea');
          // Never repaint under someone halfway through typing a reply.
          if (!ta || !ta.value) await loadThread(state.open, false);
        }
      } catch (e) { /* the next tick tries again */ }
    }

    paintMain();
    loadList().then(() => {
      // Land on the conversation that most needs attention, but only on a wide screen — on a phone
      // the list IS the first screen.
      if (state.threads.length && window.matchMedia('(min-width: 761px)').matches) openThread(state.threads[0]);
      else paintMain();
    }).catch(() => { list.innerHTML = ''; list.appendChild(el('div', 'msg-empty', t('loadFailed'))); });
    state.timer = setInterval(tick, POLL_MS);
  }

  window.AkoreMessages = { mount, unread, POLL_MS };
})();
