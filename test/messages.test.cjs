// Messages: a customer sees their own company's conversations and nobody else's.
//
// The client portal holds a working session and can call /api/messages directly, so every rule
// that matters here has to hold on the server: which company a customer reaches, whether a thread
// id from another company finds anything, and what the badges count. The page drawing only the
// right conversations is not the protection — this is.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = name => (STORES[name] = STORES[name] || {});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

const BASE = 'https://x/api/messages';
async function call(fn, method, { qs = '', body = null } = {}) {
  const res = await fn(new Request(BASE + qs, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), {});
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  const fn = (await import(pathToFileURL(path.resolve('netlify/functions/messages.js')).href)).default;
  const { createStaffSession, createClientSession } = await import(pathToFileURL(
    path.resolve('netlify/functions/lib/session.js')).href);

  Object.keys(STORES).forEach(k => delete STORES[k]);
  store('hieronymus-intake-codes')['acme'] = { company: 'Acme', members: [] };
  store('hieronymus-intake-codes')['rival-co'] = { company: 'Rival Co', members: [] };

  const STAFF = await createStaffSession('akore-rene', 'admin');
  const ACME = await createClientSession('acme-owner', 'Acme');
  const ACME2 = await createClientSession('acme-viewer', 'Acme');   // a second login, same company
  const RIVAL = await createClientSession('rival-user', 'Rival Co');
  const q = (s, extra = '') => `?session=${encodeURIComponent(s)}${extra}`;
  const msgKeys = slug => Object.keys(store('hieronymus-messages')).filter(k => k.startsWith('m/' + slug + '/'));

  console.log('Signed out gets nothing:\n');
  {
    const r = await call(fn, 'GET', { qs: '?company=Acme' });
    check('a read without a session is refused', r.status === 401, 'status ' + r.status);
    const w = await call(fn, 'POST', { body: { company: 'Acme', subject: 'x', text: 'x' } });
    check('a send without a session is refused', w.status === 401, 'status ' + w.status);
  }

  console.log('\nA customer starts a conversation:\n');
  let thread;
  {
    const r = await call(fn, 'POST', { body: { session: ACME, subject: 'Question about my dashboard', text: 'Why did my score drop?' } });
    check('it is accepted', r.status === 200 && r.data.thread, JSON.stringify(r.data));
    thread = r.data.thread;
    check('it belongs to their own company', thread && thread.company === 'Acme', JSON.stringify(thread));
    check('a subject is required for a new conversation',
      (await call(fn, 'POST', { body: { session: ACME, text: 'no subject' } })).status === 400, 'accepted');
    check('an empty message is refused',
      (await call(fn, 'POST', { body: { session: ACME, thread: thread.id, text: '   ' } })).status === 400, 'accepted');
  }

  console.log('\nAnother customer cannot see it, reach it, or write into it:\n');
  {
    const list = await call(fn, 'GET', { qs: q(RIVAL, '&company=Acme') });
    check('naming Acme returns Rival Co\'s own (empty) inbox, not Acme\'s',
      list.status === 200 && list.data.company === 'Rival Co' && list.data.threads.length === 0, JSON.stringify(list.data));
    const read = await call(fn, 'GET', { qs: q(RIVAL, '&company=Acme&thread=' + thread.id) });
    check('opening Acme\'s thread by id finds nothing', read.status === 404, 'status ' + read.status);
    const before = msgKeys('acme').length;
    const post = await call(fn, 'POST', { body: { session: RIVAL, company: 'Acme', thread: thread.id, text: 'injected' } });
    check('replying into Acme\'s thread is refused', post.status === 404, 'status ' + post.status);
    check('and nothing was written into Acme\'s conversation', msgKeys('acme').length === before, 'a message was added');
    const all = await call(fn, 'GET', { qs: q(RIVAL) });
    check('a customer asking for the cross-customer inbox gets only their own',
      all.status === 200 && all.data.threads.length === 0, JSON.stringify(all.data));
    const sneaky = await call(fn, 'GET', { qs: q(RIVAL, '&company=Acme&thread=' + encodeURIComponent('../acme/' + thread.id)) });
    check('a thread id carrying a path is refused', sneaky.status === 404, 'status ' + sneaky.status);
  }

  console.log('\nAkore is notified, reads, and replies:\n');
  {
    const c = await call(fn, 'GET', { qs: q(STAFF, '&count=1') });
    check('the staff badge counts the new conversation', c.data.unread === 1, JSON.stringify(c.data));
    const inbox = await call(fn, 'GET', { qs: q(STAFF) });
    check('it is in the staff inbox with its company', inbox.data.threads.length === 1 &&
      inbox.data.threads[0].company === 'Acme' && inbox.data.threads[0].unread === 1, JSON.stringify(inbox.data));
    const open = await call(fn, 'GET', { qs: q(STAFF, '&company=Acme&thread=' + thread.id) });
    check('staff can open it', open.status === 200 && open.data.messages.length === 1 &&
      open.data.messages[0].text === 'Why did my score drop?', JSON.stringify(open.data));
    await call(fn, 'PATCH', { body: { session: STAFF, company: 'Acme', thread: thread.id } });
    check('opening it clears the staff badge', (await call(fn, 'GET', { qs: q(STAFF, '&count=1') })).data.unread === 0, 'still unread');
    const reply = await call(fn, 'POST', { body: { session: STAFF, company: 'Acme', thread: thread.id, text: 'A competitor gained ground. Details inside.' } });
    check('staff can reply', reply.status === 200 && reply.data.message.from === 'staff', JSON.stringify(reply.data));
    check('replying does not count as unread for Akore', (await call(fn, 'GET', { qs: q(STAFF, '&count=1') })).data.unread === 0, 'unread');
  }

  console.log('\nThe customer sees the reply — every login at that company does:\n');
  {
    check('the customer\'s badge shows the reply', (await call(fn, 'GET', { qs: q(ACME, '&count=1') })).data.unread === 1, 'no badge');
    const v = await call(fn, 'GET', { qs: q(ACME2, '&thread=' + thread.id) });
    check('a second login at the same company reads the whole conversation',
      v.status === 200 && v.data.messages.length === 2 && v.data.messages[1].from === 'staff', JSON.stringify(v.data));
    const vp = await call(fn, 'POST', { body: { session: ACME2, thread: thread.id, text: 'Thanks!' } });
    check('and can reply to it', vp.status === 200 && vp.data.message.author === 'acme-viewer', JSON.stringify(vp.data));
    check('Rival Co\'s badge never moved', (await call(fn, 'GET', { qs: q(RIVAL, '&count=1') })).data.unread === 0, 'Rival sees Acme activity');
  }

  console.log('\nAkore can start a conversation, but only with a real customer:\n');
  {
    const bad = await call(fn, 'POST', { body: { session: STAFF, company: 'Nobody Inc', subject: 'Hi', text: 'Hello' } });
    check('an unknown company is refused', bad.status === 404, 'status ' + bad.status);
    const ok = await call(fn, 'POST', { body: { session: STAFF, company: 'Rival Co', subject: 'Your audit is ready', text: 'Take a look.' } });
    check('a real customer is accepted', ok.status === 200 && ok.data.thread.company === 'Rival Co', JSON.stringify(ok.data));
    const rl = await call(fn, 'GET', { qs: q(RIVAL) });
    check('that customer sees it, unread', rl.data.threads.length === 1 && rl.data.threads[0].unread === 1, JSON.stringify(rl.data));
    const al = await call(fn, 'GET', { qs: q(ACME) });
    check('and the other customer does not', al.data.threads.length === 1 && al.data.threads[0].company === 'Acme', JSON.stringify(al.data));
  }

  console.log('\nText is stored as written, and capped:\n');
  {
    const html = '<img src=x onerror=alert(1)>';
    const r = await call(fn, 'POST', { body: { session: ACME, thread: thread.id, text: html } });
    check('markup is kept verbatim for the page to show as text', r.data.message.text === html, r.data.message && r.data.message.text);
    const long = await call(fn, 'POST', { body: { session: ACME, thread: thread.id, text: 'x'.repeat(10000) } });
    check('a very long message is cut to 4000 characters', long.data.message.text.length === 4000, String(long.data.message.text.length));
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'messages stay with their own company'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
