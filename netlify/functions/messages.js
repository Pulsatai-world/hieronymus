// Messages between a customer and Akore: a plain inbox, not a chatbot.
//
// A company has any number of conversations, each with a subject. Every login at that company can
// read and write all of them — viewers included — and no other company can see that they exist.
// That last rule is enforced here and only here: the client portal is handed a working session, so
// anything the page itself withheld would be withheld from nobody.
//
// ── Storage (hieronymus-messages) ──
//
//   t/<slug>/<threadId>                      the conversation: subject, who started it, when
//   m/<slug>/<threadId>/<ts>-<s|c>-<rand>    one message each, never rewritten
//   r/<side>/<slug>/<threadId>/<ts>          "this side has read up to <ts>" (side = staff | client)
//
// One blob per message for the same reason audit rows are one blob each: two people replying at
// once must not be able to overwrite each other, and a shared read-modify-write cannot promise that.
//
// Who sent a message and when are in its KEY, as is how far each side has read. So the unread
// badges, which both portals poll, are answered from two key listings and no blob reads at all —
// the cost of a poll does not grow with the number of messages being counted.
//
// Read state is per side, not per person. When anyone at Akore opens a conversation it is read for
// all of Akore, and likewise for everyone at a company: this is a shared team inbox, and "someone
// on our side has seen it" is the question the badge answers.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { callerOf } from './lib/authorize.js';
import { slugify } from './lib/accounts.js';

const STORE = 'hieronymus-messages';
const GROUP_STORE = 'hieronymus-intake-codes';
const MAX_TEXT = 4000;
const MAX_SUBJECT = 120;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

// Timestamps in keys are zero-padded milliseconds, so keys sort in time order as plain strings.
const stamp = ms => String(ms).padStart(13, '0');
const rand = () => crypto.randomBytes(4).toString('hex');
const sideOf = caller => (caller.kind === 'staff' ? 'staff' : 'client');
const otherSide = side => (side === 'staff' ? 'client' : 'staff');

// A thread id is used inside a key, so it must never carry a slash or anything else that could
// reach another company's prefix. Ours are always <13 digits>-<8 hex>.
const THREAD_ID = /^\d{13}-[0-9a-f]{8}$/;

/** Every key under a prefix. The production client pages through and merges for us. */
async function keys(store, prefix) {
  const { blobs } = await store.list({ prefix });
  return (blobs || []).map(b => b.key);
}

/**
 * Per-thread activity from the message keys and read markers alone — no blob reads.
 *   m/<slug>/<threadId>/<ts>-<s|c>-<rand>
 *   r/<side>/<slug>/<threadId>/<ts>
 */
function tally(messageKeys, markerKeys, side) {
  const readUpTo = {};
  for (const k of markerKeys) {
    const p = k.split('/');                  // r, side, slug, threadId, ts
    const key = p[2] + '/' + p[3];
    if (!readUpTo[key] || p[4] > readUpTo[key]) readUpTo[key] = p[4];
  }
  const fromOther = side === 'staff' ? 'c' : 's';
  const threads = {};
  for (const k of messageKeys) {
    const p = k.split('/');                  // m, slug, threadId, "<ts>-<s|c>-<rand>"
    const [ts, from] = p[3].split('-');
    const key = p[1] + '/' + p[2];
    const t = threads[key] || (threads[key] = { slug: p[1], id: p[2], count: 0, unread: 0, lastTs: '', lastFrom: '' });
    t.count++;
    if (ts > t.lastTs) { t.lastTs = ts; t.lastFrom = from === 's' ? 'staff' : 'client'; }
    if (from === fromOther && (!readUpTo[key] || ts > readUpTo[key])) t.unread++;
  }
  return threads;
}

const iso = ts => (ts ? new Date(Number(ts)).toISOString() : null);

/** Records that `side` has read this thread up to now, and drops its older markers. */
async function markRead(store, side, slug, threadId) {
  const prefix = `r/${side}/${slug}/${threadId}/`;
  const old = await keys(store, prefix);
  const mark = prefix + stamp(Date.now());
  await store.setJSON(mark, {});
  // Two marks in the same millisecond share a key; deleting "the old one" would delete this one.
  await Promise.all(old.filter(k => k !== mark).map(k => store.delete(k).catch(() => {})));
}

/** The company a customer record exists for, or null. Staff may only write to real customers. */
async function realCompany(name) {
  const slug = slugify(name);
  if (!slug) return null;
  const rec = await getStore(GROUP_STORE).get(slug, { type: 'json' }).catch(() => null);
  return rec ? (rec.company || name) : null;
}

/**
 * Every new message passes through here once it is stored. Nothing is sent yet: email is wanted
 * later "for a few things", and this is the single place it will go, so turning it on does not
 * mean touching the inbox.
 */
async function notify(/* { company, thread, message } */) {}

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

export default async (request) => {
  const url = new URL(request.url);
  // Strong, not the default eventual consistency. A sender's page re-reads the conversation the
  // moment its message is stored, and an eventually-consistent listing can come back without it —
  // on the live site that made a sent message vanish until a later poll, so it looked unsent.
  // Local Blobs are always consistent, which is why it only ever showed in production.
  const store = getStore(STORE, { consistency: 'strong' });

  let body = null;
  if (request.method === 'POST' || request.method === 'PATCH') {
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  }

  const caller = await callerOf(url, body);
  if (!caller) return json({ error: 'Sign in to continue.', needsSignIn: true }, 401);
  const side = sideOf(caller);

  // Which company this request is about. A customer's is their session's, full stop: whatever the
  // request names is ignored rather than compared, so there is nothing to probe. Staff name it.
  const asked = (url.searchParams.get('company') || (body && body.company) || '').trim();
  const company = side === 'client' ? caller.company : asked;
  const slug = slugify(company);

  // ── reads ──
  if (request.method === 'GET') {
    // The staff inbox across every customer, and the badge count the console polls.
    if (!company) {
      if (side !== 'staff') return json({ error: 'Not authorised.' }, 403);
      const [mk, rk] = await Promise.all([keys(store, 'm/'), keys(store, 'r/staff/')]);
      const threads = tally(mk, rk, 'staff');
      const unread = Object.values(threads).reduce((n, t) => n + (t.unread ? 1 : 0), 0);
      if (url.searchParams.get('count') === '1') return json({ unread }, 200);
      const list = await Promise.all(Object.values(threads).map(async t => {
        const meta = await store.get(`t/${t.slug}/${t.id}`, { type: 'json' }).catch(() => null);
        return meta && summary(meta, t);
      }));
      return json({ unread, threads: sortThreads(list.filter(Boolean)) }, 200);
    }
    if (!slug) return json({ error: 'Missing company' }, 400);

    const threadId = url.searchParams.get('thread') || '';
    if (threadId) {
      if (!THREAD_ID.test(threadId)) return json({ error: 'Unknown conversation' }, 404);
      const meta = await store.get(`t/${slug}/${threadId}`, { type: 'json' }).catch(() => null);
      if (!meta) return json({ error: 'Unknown conversation' }, 404);
      const mk = (await keys(store, `m/${slug}/${threadId}/`)).sort();
      const messages = (await Promise.all(mk.map(k => store.get(k, { type: 'json' }).catch(() => null)))).filter(Boolean);
      return json({ thread: publicThread(meta), messages }, 200);
    }

    const [mk, rk] = await Promise.all([keys(store, `m/${slug}/`), keys(store, `r/${side}/${slug}/`)]);
    const threads = tally(mk, rk, side);
    const unread = Object.values(threads).reduce((n, t) => n + (t.unread ? 1 : 0), 0);
    if (url.searchParams.get('count') === '1') return json({ unread }, 200);
    const list = await Promise.all(Object.values(threads).map(async t => {
      const meta = await store.get(`t/${slug}/${t.id}`, { type: 'json' }).catch(() => null);
      return meta && summary(meta, t);
    }));
    return json({ company, unread, threads: sortThreads(list.filter(Boolean)) }, 200);
  }

  if (!slug) return json({ error: 'Missing company' }, 400);
  const threadId = String((body && body.thread) || '');

  // ── mark a conversation read ──
  if (request.method === 'PATCH') {
    if (!THREAD_ID.test(threadId)) return json({ error: 'Unknown conversation' }, 404);
    const meta = await store.get(`t/${slug}/${threadId}`, { type: 'json' }).catch(() => null);
    if (!meta) return json({ error: 'Unknown conversation' }, 404);
    await markRead(store, side, slug, threadId);
    return json({ status: 'ok' }, 200);
  }

  // ── send: a reply to a conversation, or the first message of a new one ──
  if (request.method === 'POST') {
    const text = cleanText(body.text, MAX_TEXT);
    if (!text) return json({ error: 'Write a message first.' }, 400);

    let meta;
    if (threadId) {
      // The thread is looked up under the CALLER's company, so a customer naming another
      // company's thread id simply finds nothing.
      if (!THREAD_ID.test(threadId)) return json({ error: 'Unknown conversation' }, 404);
      meta = await store.get(`t/${slug}/${threadId}`, { type: 'json' }).catch(() => null);
      if (!meta) return json({ error: 'Unknown conversation' }, 404);
    } else {
      const subject = cleanText(body.subject, MAX_SUBJECT).replace(/\n+/g, ' ');
      if (!subject) return json({ error: 'Give the conversation a subject.' }, 400);
      let name = company;
      if (side === 'staff') {
        name = await realCompany(company);
        if (!name) return json({ error: 'Unknown customer' }, 404);
      }
      const now = Date.now();
      meta = {
        id: stamp(now) + '-' + rand(),
        company: name,
        subject,
        createdAt: new Date(now).toISOString(),
        createdBy: { side, username: caller.username }
      };
      await store.setJSON(`t/${slug}/${meta.id}`, meta);
    }

    const now = Date.now();
    const message = {
      id: stamp(now) + '-' + (side === 'staff' ? 's' : 'c') + '-' + rand(),
      from: side,
      author: caller.username,
      text,
      sentAt: new Date(now).toISOString()
    };
    await store.setJSON(`m/${slug}/${meta.id}/${message.id}`, message);
    // Whoever writes has, by definition, read the conversation.
    await markRead(store, side, slug, meta.id);
    await notify({ company: meta.company, thread: publicThread(meta), message }).catch(e =>
      console.error('MESSAGE_NOTIFY_FAILED', e && e.message));
    return json({ status: 'ok', thread: publicThread(meta), message }, 200);
  }

  return new Response('Method Not Allowed', { status: 405 });
};

function publicThread(meta) {
  return { id: meta.id, company: meta.company, subject: meta.subject, createdAt: meta.createdAt, createdBy: meta.createdBy };
}

function summary(meta, t) {
  return Object.assign(publicThread(meta), {
    count: t.count, unread: t.unread, lastAt: iso(t.lastTs), lastFrom: t.lastFrom
  });
}

// Waiting on us first, then most recent activity.
function sortThreads(list) {
  return list.sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || String(b.lastAt).localeCompare(String(a.lastAt)));
}
