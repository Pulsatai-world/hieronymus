#!/usr/bin/env node
/**
 * The demo customer, from a terminal.
 *
 * What it builds and the order it builds it in live in js/demo-seed.js, which the button in the
 * staff console uses too — one definition, so the two cannot drift into describing different
 * demos. All this file adds is signing in and carrying the HTTP.
 *
 *   node scripts/seed-demo-customer.mjs --dry-run
 *   node scripts/seed-demo-customer.mjs --base https://app.akore.com.mx --session <token>
 *   node scripts/seed-demo-customer.mjs --base https://… --username you --password … --code 123456
 *   node scripts/seed-demo-customer.mjs --remove --base https://… --session <token>
 *
 * The session has to belong to a staff admin: writing result rows, releasing a dashboard and
 * deleting a customer are all staff-only, which is the point.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const demo = require(path.join(here, '..', 'js', 'demo-seed.js'));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:8888').replace(/\/$/, '');
let SESSION = arg('session', '');

async function call(method, p, opts) {
  const o = opts || {};
  const url = new URL(BASE + p);
  if (SESSION) url.searchParams.set('session', SESSION);
  for (const [k, v] of Object.entries(o.query || {})) url.searchParams.set(k, v);
  const init = { method };
  if (o.body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(SESSION ? { ...o.body, session: SESSION } : o.body);
  }
  // Retried on 5xx and on a dropped connection. Writing a row drops the derived CSV cache, so a
  // read landing while that rebuilds can take long enough for a proxy in front of the function to
  // give up — the function itself is fine, and the next attempt hits a warm cache.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      if (r.status >= 500 && attempt < 4) { await new Promise(x => setTimeout(x, 800 * (attempt + 1))); continue; }
      let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
      return { status: r.status, data, text };
    } catch (e) {
      if (attempt === 4) return { status: 0, data: e.message, text: '' };
      await new Promise(x => setTimeout(x, 800 * (attempt + 1)));
    }
  }
}

async function signIn() {
  if (SESSION) return;
  const username = arg('username'), password = arg('password'), code = arg('code');
  if (!username || !password) {
    console.error('Need --session <token>, or --username --password --code for a staff admin.');
    process.exit(1);
  }
  const r = await call('POST', '/api/login', { body: { username, password, code } });
  if (!r.data || !r.data.session) {
    console.error('Sign-in failed:', JSON.stringify(r.data).slice(0, 200));
    process.exit(1);
  }
  SESSION = r.data.session;
}

const log = m => console.log('  ' + m);

async function main() {
  if (argv.includes('--dry-run')) {
    const rows = demo.buildRows();
    console.log(`${demo.COMPANY}: ${rows.length} rows across ${demo.TIMELINE.length} snapshots\n`);
    for (const s of demo.TIMELINE) {
      const of = rows.filter(r => r.snapshot_date === s.date);
      const cited = of.filter(r => r.brand_cited === 1).length;
      console.log(`  ${s.date}  ${s.type.padEnd(11)} ${String(of.length).padStart(3)} rows  cited ${String(Math.round(100 * cited / of.length)).padStart(3)}%`);
    }
    console.log('\nNothing was written. Drop --dry-run to build it.');
    return;
  }

  await signIn();

  if (argv.includes('--remove')) {
    console.log(`Removing "${demo.COMPANY}" from ${BASE}\n`);
    await demo.remove({ call, log });
    console.log('\nGone. Run without --remove to build it again.');
    return;
  }

  console.log(`Building "${demo.COMPANY}" on ${BASE}\n`);
  const out = await demo.seed({ call, log });
  const q = encodeURIComponent(demo.COMPANY);
  console.log('\nOpen it:');
  console.log(`  staff view    ${BASE}/index.html?company=${q}`);
  console.log(`  diagnostic    ${BASE}/dashboard-diagnostic.html?company=${q}`);
  console.log(`  monitoring    ${BASE}/dashboard-monitoring.html?company=${q}`);
  console.log(`  client portal ${BASE}/client-portal.html?username=${out.username}`);
  console.log(`\n  client login  ${out.username} / ${out.password}`);
  console.log('  note          a customer enrols an authenticator on first sign-in, so logging in as');
  console.log('                the client needs a phone once. To show the client view without that,');
  console.log('                open the client portal link above while signed in as staff.');
}

main().catch(e => { console.error(e); process.exit(1); });
