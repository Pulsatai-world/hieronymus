// Setting up an authenticator, and resetting someone else's.
//
//   POST { username, password }                    start   -> { secret, otpauth, qrSvg, serverTime }
//   POST { username, password, code }              finish  -> { session, ...who }   (signed in)
//   POST { username, password, code, currentCode } replace an active authenticator
//   POST { action:'reset', username, session }     a staff admin clears someone's authenticator
//   POST { action:'recovery', session }             a fresh set of recovery codes, shown once
//
// Two steps on purpose: a secret is issued and held as *pending*, and only becomes the account's
// authenticator once a live code proves the app actually holds it. Without that, a mistyped setup key
// would lock the account out with nothing to fall back on.
//
// Finishing signs the person in. A password and a live code have both just been checked — the same
// two things a sign-in checks — so sending them back to a login form would only invite the mistakes
// that come with a second round trip.

import { findAccount } from './lib/accounts.js';
import { newSecret, verifyCode, otpauthUri, otpauthLabel, qrSvgFor } from './lib/totp.js';
import { sessionFor, whoPayload } from './lib/identity.js';
import { readSession, revokeAllFor } from './lib/session.js';
import { newRecoveryCodes, recoveryRemaining } from './lib/recovery.js';

// Several recent secrets stay valid rather than each replacing the last.
//
// This is the defect that made setup fail over and over. One user action could ask for setup twice
// (a button and an Enter key both firing), each ask issued a new secret, and each new secret replaced
// the one before it. Two QR codes reached the authenticator under an identical label — every scan of
// the same account looks the same in the app — so there was no way to tell which was current, and
// scanning the wrong one gave "that code is not valid" on a brand-new account. Keeping the recent
// ones means whichever QR was actually scanned is accepted. A pending secret grants nothing until a
// code proves an app holds it, so keeping a few costs nothing.
const MAX_PENDING = 5;
const PENDING_TTL_MS = 30 * 60 * 1000;

// The SAME window a login uses, and that matters more than being generous.
//
// Setup once accepted ±3 minutes while login accepted ±30 seconds. A phone whose clock was ninety
// seconds out therefore enrolled perfectly and could then never sign in — five tries and a fifteen
// minute lock, forever — and the step it matched was written to `lastStep` in the future, marking
// the next genuine codes as replays too. A window setup can pass and login cannot is a trap, so
// there is one window. A clock too far out now fails at setup, where the dialog says so and the
// person can fix it, instead of silently bricking the account afterwards.
import { AUTH_DRIFT } from './lib/totp.js';
const SETUP_DRIFT = AUTH_DRIFT;

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

const fresh = p => p && typeof p.secret === 'string' && Date.now() - Date.parse(p.at || 0) < PENDING_TTL_MS;

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));
  const username = String(body.username || '').trim().toLowerCase();
  const acct = await findAccount(username);
  if (!acct) return json({ error: 'Invalid username or password' }, 401);

  // ── A staff admin clearing someone's authenticator ──
  // The recovery story for a lost phone. Requires a signed-in staff admin: a password alone must not
  // be able to do this, or a stolen password could clear the second factor and then enroll a new
  // phone, which is the whole thing two-factor exists to prevent.
  if (body.action === 'reset') {
    const session = await readSession(body.session);
    if (!session || session.kind !== 'staff' || session.role !== 'admin') {
      return json({ error: 'Only a signed-in staff admin can reset an authenticator.' }, 403);
    }
    acct.setAuth(null);
    await acct.save();
    // Their sessions go too. Clearing the second factor while leaving live sessions alone would
    // achieve nothing.
    await revokeAllFor(acct.username);
    return json({ status: 'ok', enabled: false }, 200);
  }

  // ── A fresh set of recovery codes ──
  // For someone already signed in who has spent some, or never saved the set they were shown. The
  // live session is the proof, not the password: a password alone must not be able to mint a way
  // past the second factor. Issuing a set retires the previous one.
  if (body.action === 'recovery') {
    const session = await readSession(body.session);
    if (!session || session.username !== acct.username) {
      return json({ error: 'Sign in to get new recovery codes.' }, 403);
    }
    if (!acct.enrolled) return json({ error: 'Set up an authenticator first.' }, 409);
    // The password as well as the session. Recovery codes ARE a second factor — ten of them — so a
    // stolen session alone must not be able to mint a durable set and retire the owner's, which
    // would survive them revoking that session and re-enrolling their phone.
    if (!acct.checkPassword(body.password)) {
      return json({ error: 'Enter your password to get new recovery codes.' }, 401);
    }
    const fresh = newRecoveryCodes();
    acct.setAuth({ ...acct.auth, recovery: fresh.stored, recoveryIssuedAt: fresh.issuedAt });
    await acct.save();
    return json({ status: 'ok', recoveryCodes: fresh.codes }, 200);
  }

  if (!acct.checkPassword(body.password)) {
    return json({ error: 'Invalid username or password' }, 401);
  }

  const auth = acct.auth || {};

  if (auth.lockedUntil && Date.parse(auth.lockedUntil) > Date.now()) {
    const mins = Math.ceil((Date.parse(auth.lockedUntil) - Date.now()) / 60000);
    return json({ error: 'Too many incorrect codes. Try again in ' + mins + ' minutes.', locked: true }, 429);
  }

  // Replacing an authenticator needs a code from the CURRENT one — otherwise a stolen password would
  // be enough to swap in a new phone and own the account.
  //
  // Except when that authenticator has never completed a sign-in. Setting one up and then finding it
  // does not work is a real state and it happened repeatedly: the app ends up holding an entry from
  // an earlier attempt, or the entry gets deleted, and the account is then enrolled against a secret
  // nobody can produce codes for — locked out, with the reset needing an admin who may be the locked
  // out person. An unused authenticator has proved nothing, so allowing the account holder to replace
  // it with the same password that created it takes nothing away; the replacement still has to be
  // confirmed with a live code before it becomes the account's second factor.
  //
  // `lastUsedAt` is stamped by /api/login on every successful sign-in.
  //
  // And a recovery code stands the gate down for a while. Someone who signed in with one has lost
  // the authenticator, so demanding a code from it is demanding the impossible — it would leave
  // them signed in, unable to enroll a new phone, and needing an admin they may themselves be.
  const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
  const recentRecovery = !!(auth && auth.recoveryUsedAt
    && Date.now() - Date.parse(auth.recoveryUsedAt) < RECOVERY_WINDOW_MS);
  const proven = !!(auth && auth.lastUsedAt) && !recentRecovery;
  if (acct.enrolled && proven && !body.code) {
    const cur = verifyCode(auth.secret, body.currentCode, { drift: AUTH_DRIFT });
    if (!cur.ok) {
      return json({
        error: 'This account already has an authenticator.',
        needsCurrentCode: true
      }, 403);
    }
  }

  // ── Finish: a code was submitted ──
  if (body.code) {
    // Every recent secret, including one issued by an older deploy — see pendingSecrets.
    const candidates = acct.pendingSecrets.filter(fresh).map(p => p.secret)
      .filter((sec, i, all) => all.indexOf(sec) === i);

    if (!candidates.length) {
      // Nothing pending, and the account is already set up. This used to mint a session if the code
      // verified — a shortcut for a double press, or a first response that never arrived. It was a
      // replay hole: it never consulted `lastStep` and never advanced it, so a code already spent
      // at /api/login (where it is correctly refused a second time) still bought a session here,
      // for the whole ±3-minute setup window, repeatedly. The dialog already guards double
      // submission, so the shortcut bought little and cost the replay defence.
      if (acct.enrolled) {
        return json({ error: 'This account is already set up. Sign in with a code from your app.',
                      alreadyEnrolled: true }, 409);
      }
      return json({ error: 'This setup has expired. Start again.', expired: true }, 409);
    }

    let matched = null, step = null;
    for (const candidate of candidates) {
      const res = verifyCode(candidate, body.code, { drift: SETUP_DRIFT });
      if (res.ok) { matched = candidate; step = res.step; break; }
    }

    if (!matched) {
      const failures = (auth.failures || 0) + 1;
      acct.setAuth(failures >= MAX_ATTEMPTS
        ? { ...auth, failures: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() }
        : { ...auth, failures });
      await acct.save();
      return json({ error: 'That code is not valid. Check the time on your phone and try again.' }, 403);
    }

    // The matched secret becomes the authenticator; every other candidate is dropped.
    //
    // Recovery codes are issued here and returned exactly once. This is the only moment they exist
    // in plaintext anywhere — only their hashes are stored — so the dialog has to show them now or
    // never. Without them, losing the phone means a staff admin must clear the authenticator, and
    // the last remaining admin has nobody who can do that for them.
    const recovery = newRecoveryCodes();
    acct.setAuth({
      secret: matched, enabledAt: new Date().toISOString(), lastStep: step,
      failures: 0, lockedUntil: null,
      // Finishing enrollment IS a sign-in: a password and a live code were both just checked, which
      // is exactly what /api/login checks. Not stamping this left every freshly enrolled account
      // "unproven", which stood the replace-gate down — so a stolen password alone could ask for a
      // new secret, install it, and take the account over with no second factor ever involved. The
      // gate's own comment assumed an invariant nothing maintained.
      lastUsedAt: new Date().toISOString(),
      recovery: recovery.stored, recoveryIssuedAt: recovery.issuedAt
    });
    await acct.save();
    return json({
      session: await sessionFor(acct), ...whoPayload(acct),
      recoveryCodes: recovery.codes
    }, 200);
  }

  // ── Start: issue a secret and a QR ──
  const secret = newSecret();
  const at = new Date().toISOString();
  const pending = [{ secret, at }]
    .concat((Array.isArray(auth.pending) ? auth.pending : []).filter(fresh))
    .filter((p, i, all) => all.findIndex(q => q.secret === p.secret) === i)
    .slice(0, MAX_PENDING);

  acct.setAuth({ ...auth, pending });
  await acct.save();

  // Dated, so an app already holding entries from earlier attempts shows which one is new — the
  // app's own row is where that belongs, not a warning box over the QR.
  const uri = otpauthUri(otpauthLabel(acct.username), secret);
  // The only time a secret leaves the server, to the account it belongs to, during its own setup.
  // serverTime lets the dialog notice a device clock far enough out to make every code look wrong,
  // and say so, rather than leaving someone retyping correct codes.
  return json({
    status: 'pending',
    secret,
    otpauth: uri,
    qrSvg: await qrSvgFor(uri),
    serverTime: Date.now()
  }, 200);
};
