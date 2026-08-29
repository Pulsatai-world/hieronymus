// Authenticator-app two-factor (TOTP, RFC 6238) — the one implementation, shared by every login.
//
// It is imported by staff-users.js (the internal Portal login), staff-session.js (the token mint),
// intake-codes.js (the customer login used by all three client-facing pages) and two-factor.js
// (enrollment and recovery). Four copies of a security decision is how they drift apart, and the
// sibling-module import used here is the same pattern geo-report.js and geo-scan-background.js
// already ship with.
//
// Nothing beyond node:crypto is needed: a base32 secret, an HMAC-SHA1 over the 30-second counter,
// and RFC 4226 dynamic truncation down to six digits.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DRIFT_STEPS = 1;         // accept the neighbouring windows, for a phone clock slightly off
const MAX_ATTEMPTS = 5;        // six digits is a million guesses; unthrottled that is brute-forceable
const LOCK_MINUTES = 15;
const TFA_SESSION_HOURS = 12;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function codeForStep(secretB32, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 4294967296), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Returns the matched time step, so a caller can refuse to accept the same code twice.
export function verifyTotp(secretB32, code, nowMs = Date.now()) {
  const clean = String(code || '').replace(/\D/g, '');
  if (!secretB32 || clean.length !== 6) return { ok: false, step: null };
  const current = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    // Constant-time compare; both sides are fixed-length six-digit strings.
    if (crypto.timingSafeEqual(Buffer.from(codeForStep(secretB32, current + d)), Buffer.from(clean))) {
      return { ok: true, step: current + d };
    }
  }
  return { ok: false, step: null };
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));      // 160 bits, per RFC 4226
}

export function otpauthUri(label, secret, issuer = 'Akore Labs') {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + label)
    + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

// A customer's three pages each re-validate their login on load, so demanding a fresh code every
// time would mean typing one to walk from the intake form to the dashboard. A successful code mints
// a short-lived token instead, which the pages hold for the rest of the browser session. The token
// is opaque, stored server-side, and scoped to one username.
export async function mintTfaToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  await getStore('hieronymus-2fa-sessions').setJSON(token, {
    username: String(username).toLowerCase(),
    expiresAt: new Date(Date.now() + TFA_SESSION_HOURS * 3600 * 1000).toISOString()
  });
  return token;
}

export async function tfaTokenValid(token, username) {
  if (!token) return false;
  const rec = await getStore('hieronymus-2fa-sessions').get(String(token), { type: 'json' }).catch(() => null);
  if (!rec || rec.username !== String(username).toLowerCase()) return false;
  // A record with no expiry is treated as invalid rather than eternal — fail closed.
  if (!rec.expiresAt) return false;
  const left = Date.parse(rec.expiresAt) - Date.now();
  if (left < 0) return false;
  // Sliding expiry. Now that every scoped request carries this ticket, a fixed 12 hours would cut
  // someone off in the middle of a working day. Extended only once it is more than half spent, so
  // this is not a blob write on every request — and an idle session still lapses.
  if (left < (TFA_SESSION_HOURS / 2) * 3600 * 1000) {
    rec.expiresAt = new Date(Date.now() + TFA_SESSION_HOURS * 3600 * 1000).toISOString();
    await getStore('hieronymus-2fa-sessions').setJSON(String(token), rec).catch(() => {});
  }
  return true;
}

// Enrollment's confirm step throttles the same way a login does — shared so the two cannot disagree
// about how many wrong codes are too many.
export function lockState(rec, nowMs = Date.now()) {
  const t = rec && rec.totp;
  if (!t || !t.lockedUntil) return { locked: false, minutes: 0 };
  const left = Date.parse(t.lockedUntil) - nowMs;
  return left > 0 ? { locked: true, minutes: Math.ceil(left / 60000) } : { locked: false, minutes: 0 };
}

export function registerFailure(rec, nowMs = Date.now()) {
  rec.totp = rec.totp || {};
  rec.totp.failures = (rec.totp.failures || 0) + 1;
  if (rec.totp.failures >= MAX_ATTEMPTS) {
    rec.totp.lockedUntil = new Date(nowMs + LOCK_MINUTES * 60000).toISOString();
    rec.totp.failures = 0;
  }
}

// The gate every login goes through. Returns null when the login may proceed, or a Response saying
// what is still needed. `save` persists the throttle counters, so a wrong code actually costs
// something; `json` is the caller's own response builder so headers stay consistent per endpoint.
//
// opts: { username, token }  — and it sets opts.issued when it mints a new session token.
export async function totpGate(rec, code, save, json, opts = {}) {
  const t = rec && rec.totp;

  // Two-factor is mandatory, so an account that has not enrolled cannot get in — it is sent to set
  // up an authenticator first. This is the only reason a correct password is refused.
  if (!t || !t.enabledAt || !t.secret) {
    return json({ error: 'Set up your authenticator app to continue.', needsEnrollment: true }, 401);
  }

  if (opts.token && await tfaTokenValid(opts.token, opts.username)) return null;

  if (t.lockedUntil && Date.parse(t.lockedUntil) > Date.now()) {
    const mins = Math.ceil((Date.parse(t.lockedUntil) - Date.now()) / 60000);
    return json({ error: 'Too many incorrect codes. Try again in ' + mins + ' minutes.', locked: true }, 429);
  }
  if (!code) return json({ error: 'Enter the 6-digit code from your authenticator app.', needsCode: true }, 401);

  const res = verifyTotp(t.secret, code);
  // Codes must move forward, never repeat and never go back. Refusing only the exact step used last
  // was not enough: the ±1 drift window keeps three codes live at once, so someone who saw a code
  // could still use it whenever the account's last login happened to land on a neighbouring step.
  // RFC 6238 is explicit — do not accept the same or an earlier time step twice.
  if (!res.ok || (typeof t.lastStep === 'number' && res.step <= t.lastStep)) {
    t.failures = (t.failures || 0) + 1;
    if (t.failures >= MAX_ATTEMPTS) {
      t.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      t.failures = 0;
    }
    await save();
    return json({
      error: res.ok ? 'That code has already been used. Wait for the next one.' : 'Incorrect code.',
      needsCode: true
    }, 403);
  }

  t.failures = 0;
  t.lockedUntil = null;
  t.lastStep = res.step;
  await save();
  if (opts.username) opts.issued = await mintTfaToken(opts.username);
  return null;
}

// ── Proof that a request came from someone who passed two-factor ──
//
// The gate above protects the LOGIN. It did not protect the endpoints the pages then call, and those
// accepted a raw username+password as sufficient — so a stolen password still read and wrote
// everything over plain HTTP, and two-factor only stopped someone using the UI. This is the other
// half: on a scoped endpoint, a password must be accompanied by the ticket issued when the code was
// accepted. A staff session token counts on its own, because one is only ever minted after a code.
//
// Fails closed. An account with no ticket gets nothing, which is right: two-factor is mandatory, so
// there is no legitimate caller holding a password and no ticket.
export async function requireTwoFactorProof(url, body, json) {
  const q = url.searchParams;

  async function refuse() {
    return json({
      error: 'Your session needs a fresh code. Sign in again.',
      needsTwoFactor: true
    }, 401);
  }

  // A customer naming themselves in the query string (every scoped GET).
  const cu = q.get('username');
  if (cu && q.get('password')) {
    if (!await tfaTokenValid(q.get('tfToken'), cu)) return refuse();
  }

  // A customer naming themselves in a request body (saving an intake, approving prompts).
  if (body && body.requestingUsername && body.requestingPassword) {
    if (!await tfaTokenValid(body.tfToken, body.requestingUsername)) return refuse();
  }

  // The destructive staff actions (clear results, delete one run) name themselves this way in the
  // query string. The in-app dialog still asks only for a password — the ticket rides along with it
  // — so this costs nobody a second code while closing the same hole.
  const rq = q.get('requestingUsername');
  if (rq && q.get('requestingPassword')) {
    if (!await tfaTokenValid(q.get('tfToken'), rq)) return refuse();
  }

  // Admin actions name themselves this way: creating or deleting a staff account, resetting someone
  // else's password, releasing a dashboard, deleting a customer, clearing another account's
  // two-factor. Every one of them is reachable with a password, so every one of them needs the
  // ticket. Without this, an admin password alone could create a new admin account and enroll a
  // fresh authenticator on it — two-factor bypassed end to end.
  if (body && body.requestingStaffUsername && body.requestingStaffPassword) {
    if (!await tfaTokenValid(body.tfToken, body.requestingStaffUsername)) return refuse();
  }
  const rqs = q.get('requestingStaffUsername');
  if (rqs && q.get('requestingStaffPassword')) {
    if (!await tfaTokenValid(q.get('tfToken'), rqs)) return refuse();
  }

  // Staff sending a password rather than a session token. The token is proof by construction; the
  // password is not, so it needs the ticket alongside it.
  if (q.get('staffPassword') && !q.get('staffToken')) {
    if (!await tfaTokenValid(q.get('tfToken'), q.get('staffUsername'))) return refuse();
  }
  if (body && body.staffPassword && !body.staffToken) {
    if (!await tfaTokenValid(body.tfToken, body.staffUsername)) return refuse();
  }

  return null;
}
