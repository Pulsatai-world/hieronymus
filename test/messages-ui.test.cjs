// A sent message is on the sender's screen at once, and stays there.
//
// On the live site a customer pressed Send and their message did not appear until a later poll, so
// it looked as though it had not been sent. Two things caused it, and this drives the real inbox
// screen in jsdom against a server that reproduces both: it answers slowly, and its listings lag
// behind its writes (Netlify Blobs' eventual consistency), so a re-read straight after a send comes
// back WITHOUT the message that was just stored.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'messages-ui.js'), 'utf8');

function world() {
  const dom = new JSDOM('<!doctype html><body><div id="c" style="height:600px"></div></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: true });
  w.akoreAuth = { who: () => ({ username: 'acme-owner' }), session: () => 'S' };
  w.apiQuery = async (p, params) => p + '?' + new URLSearchParams(params || {});

  // The server: a thread that already exists, slow answers, and listings that lag behind writes.
  const server = {
    lagging: true,
    threads: [{ id: '0000000000001-aaaaaaaa', company: 'Acme', subject: 'Existing', createdAt: '2026-10-01T10:00:00Z',
                lastAt: '2026-10-01T10:00:00Z', count: 1, unread: 0 }],
    messages: { '0000000000001-aaaaaaaa': [{ id: '0000000000001-s-1', from: 'staff', author: 'akore-rene',
                text: 'Hello from Akore', sentAt: '2026-10-01T10:00:00Z' }] },
    posts: 0
  };
  const visible = arr => (server.lagging ? arr.filter(m => !m.fresh) : arr);
  w.fetch = async (url, init) => {
    await wait(150);
    const u = new URL(String(url), 'https://x');
    const ok = data => ({ ok: true, status: 200, json: async () => data });
    if (!init || !init.method || init.method === 'GET') {
      const th = u.searchParams.get('thread');
      if (th) return ok({ thread: server.threads.find(t => t.id === th), messages: visible(server.messages[th] || []) });
      return ok({ company: 'Acme', unread: 0, threads: server.threads.filter(t => !(server.lagging && t.fresh)) });
    }
    const body = JSON.parse(init.body);
    if (init.method === 'POST') {
      server.posts++;
      if (body.text === 'FAIL') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      const sentAt = new Date().toISOString();
      let thread = server.threads.find(t => t.id === body.thread);
      if (!thread) {
        thread = { id: '0000000000099-bbbbbbbb', company: 'Acme', subject: body.subject, createdAt: sentAt, fresh: true };
        server.threads.push(thread);
        server.messages[thread.id] = [];
      }
      const message = { id: '0000000000099-c-' + server.posts, from: 'client', author: 'acme-owner', text: body.text, sentAt, fresh: true };
      server.messages[thread.id].push(message);
      return ok({ status: 'ok', thread: { id: thread.id, company: 'Acme', subject: thread.subject, createdAt: thread.createdAt }, message });
    }
    return ok({ status: 'ok' });
  };
  w.eval(src);
  return { w, server, root: w.document.getElementById('c') };
}

const bubbles = root => [...root.querySelectorAll('.msg-bubble')].map(b => b.querySelector('.msg-bubble-text').textContent);

(async () => {
  console.log('Replying to a conversation:\n');
  {
    const { w, root } = world();
    w.AkoreMessages.mount(root, { side: 'client', company: 'Acme', lang: 'es' });
    await wait(700);
    check('the existing conversation opens', bubbles(root).includes('Hello from Akore'), JSON.stringify(bubbles(root)));

    root.querySelector('.msg-compose textarea').value = 'Is my report ready?';
    root.querySelector('.msg-compose .msg-btn').click();
    check('the message is on screen the instant Send is pressed', bubbles(root).includes('Is my report ready?'),
      JSON.stringify(bubbles(root)));
    check('it says it is sending', /Enviando/.test(root.querySelector('.msg-bubble.pending .msg-bubble-meta')?.textContent || ''),
      root.innerHTML.slice(0, 200));
    check('and the box is cleared for the next one', root.querySelector('.msg-compose textarea').value === '', 'still filled');

    await wait(700);
    check('once confirmed it is no longer marked as sending', !root.querySelector('.msg-bubble.pending'), 'still pending');
    check('it survives a re-read that has not caught up yet', bubbles(root).includes('Is my report ready?'),
      JSON.stringify(bubbles(root)));
    check('and it appears exactly once', bubbles(root).filter(x => x === 'Is my report ready?').length === 1,
      JSON.stringify(bubbles(root)));
  }

  console.log('\nStarting a new conversation:\n');
  {
    const { w, root, server } = world();
    w.AkoreMessages.mount(root, { side: 'client', company: 'Acme', lang: 'es' });
    await wait(700);
    root.querySelector('.msg-side-top .msg-btn').click();
    root.querySelector('.msg-form input').value = 'New question';
    root.querySelector('.msg-form textarea').value = 'Can we add a competitor?';
    root.querySelector('.msg-form-acts .msg-btn').click();
    check('the conversation opens at once with the message in it', bubbles(root).includes('Can we add a competitor?') &&
      /New question/.test(root.querySelector('.msg-main-subj')?.textContent || ''), root.querySelector('.msg-main')?.textContent);
    check('and it is in the list straight away', [...root.querySelectorAll('.msg-item-subj')].some(e => e.textContent === 'New question'),
      'not listed');
    await wait(900);
    check('a list re-read that has not caught up does not drop it',
      [...root.querySelectorAll('.msg-item-subj')].some(e => e.textContent === 'New question'), 'dropped from the list');
    check('nor its message', bubbles(root).includes('Can we add a competitor?'), JSON.stringify(bubbles(root)));
    server.lagging = false;
    await w.eval('Promise.resolve()');
  }

  console.log('\nA send that fails says so:\n');
  {
    const { w, root } = world();
    w.AkoreMessages.mount(root, { side: 'client', company: 'Acme', lang: 'es' });
    await wait(700);
    root.querySelector('.msg-compose textarea').value = 'FAIL';
    root.querySelector('.msg-compose .msg-btn').click();
    await wait(400);
    const failed = root.querySelector('.msg-bubble.failed');
    check('the message stays on screen, marked as not sent', !!failed && /No se pudo enviar/.test(failed.textContent),
      failed ? failed.textContent : 'no failed bubble');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'a sent message is shown at once and stays'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
