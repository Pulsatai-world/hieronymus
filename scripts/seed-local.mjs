// Fills a local dev server with accounts you can actually sign in as.
//
// Two-factor is mandatory, so without this you cannot get past your own login on localhost: the
// first staff account has nobody to create it, and every account after that needs an authenticator.
//
// It drives the real HTTP API rather than writing to storage, so what it produces is what a real
// sign-up produces — the same enrollment, the same session, the same records. If a rule changes,
// this breaks in the same way a person would, which is the point.
//
//   node scripts/seed-local.mjs          against http://localhost:8888
//   BASE=http://localhost:9999 node ...  somewhere else
//
// Secrets are written to .local-dev-accounts.json (gitignored) so `npm run code` can print live
// six-digit codes — you never need a phone for local work.

import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8888';
const OUT = '.local-dev-accounts.json';
const BLOBS = '.netlify/blobs-serve';
const RESET = process.argv.includes('--reset');

// Same TOTP maths the server uses, so the seed can answer its own enrollment challenge.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function codeFor(secret, atMs = Date.now()) {
  const step = Math.floor(atMs / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 4294967296), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

async function api(path, { method = 'POST', body, session } = {}) {
  const url = new URL(BASE + path);
  if (session) url.searchParams.set('session', session);
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

/** Enrolls an account that already exists, and returns its secret and a live session. */
async function enrol(username, password) {
  const start = await api('/api/enroll', { body: { username, password } });
  if (start.status !== 200 || !start.data.secret) {
    throw new Error(`enrol ${username}: ${start.status} ${JSON.stringify(start.data)}`);
  }
  const secret = start.data.secret;
  const done = await api('/api/enroll', { body: { username, password, code: codeFor(secret) } });
  if (done.status !== 200 || !done.data.session) {
    throw new Error(`enrol ${username} finish: ${done.status} ${JSON.stringify(done.data)}`);
  }
  return { secret, session: done.data.session, recoveryCodes: done.data.recoveryCodes || [] };
}

const PW = 'local-dev-password';
const STAFF = 'akore-local';
// Only the company name is ours to choose — the Portal generates each customer's username and
// password, and the seed uses what it gets back rather than assuming the naming rule.
const CUSTOMERS = ['Demo Refrigeración', 'Demo Logistics'];

async function main() {
  process.stdout.write(`Seeding ${BASE} … `);
  try {
    await fetch(BASE, { method: 'HEAD' });
  } catch {
    console.log('\n\nCould not reach ' + BASE + '. Start the dev server first:\n\n  npm run dev\n');
    process.exit(1);
  }
  console.log('reachable.\n');

  // Local blob storage lives on disk and survives restarts, so a store seeded weeks ago is still
  // there. Wiping it is opt-in: it holds whatever demo data you built up by hand.
  if (RESET && fs.existsSync(BLOBS)) {
    fs.rmSync(BLOBS, { recursive: true, force: true });
    console.log('Cleared ' + BLOBS + ' (local data only).\n');
  }

  // 1. The first staff account bootstraps as admin with no credentials — there is nobody to ask.
  const made = await api('/api/staff-users', { body: { username: STAFF, password: PW } });
  if (made.status === 409) {
    console.log(`Staff account "${STAFF}" already exists — reusing it.`);
  } else if (made.status === 401 || made.status === 403) {
    // The bootstrap only works on an empty store: the first account has nobody to authorise it.
    throw new Error(
      'This local store already has staff accounts, so the first-account bootstrap is refused.\n' +
      '  To start from a clean local database:\n\n' +
      '    npm run seed -- --reset\n\n' +
      '  That deletes ' + BLOBS + ', which is local-only and gitignored — but it does hold any\n' +
      '  demo customers and results you built up by hand. Copy it first if you want them back.');
  } else if (made.status !== 200) {
    throw new Error(`could not create the first staff account: ${made.status} ${JSON.stringify(made.data)}`);
  }

  const staff = await enrol(STAFF, PW);
  const accounts = [{ kind: 'staff', username: STAFF, password: PW, secret: staff.secret }];
  console.log(`✓ staff  ${STAFF}`);

  // 2. Customers, created the way the Portal creates them, then enrolled.
  for (const company of CUSTOMERS) {
    const created = await api('/api/intake-codes', { body: { company }, session: staff.session });
    if (created.status !== 200) {
      console.log(`  ! ${company}: ${created.status} ${JSON.stringify(created.data)}`);
      console.log('    (already seeded? re-run with --reset for a clean store)');
      continue;
    }
    const { username, password } = created.data;
    const who = await enrol(username, password);
    accounts.push({ kind: 'customer', company, username, password, secret: who.secret });
    console.log(`✓ client ${username.padEnd(22)} (${company})`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, password: PW, accounts }, null, 2) + '\n');

  console.log(`\nWritten to ${OUT} — usernames, passwords and secrets are all in there.\n`);
  for (const a of accounts) {
    console.log(`  ${(a.kind === 'staff' ? 'staff ' : 'client')}  ${a.username.padEnd(22)} ${a.password}`);
  }
  console.log('');
  console.log('Sign in at ' + BASE + '/login.html');
  console.log('For the 6-digit code, run:  npm run code\n');
}

// Only when run directly. totp-code.mjs imports codeFor from here, and without this guard that
// import kicked off a whole seed as a side effect of asking for a six-digit code.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch(err => { console.error('\n' + err.message + '\n'); process.exit(1); });
}
