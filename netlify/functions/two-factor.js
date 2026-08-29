// Enrollment and recovery for authenticator-app two-factor, for BOTH account types: staff users
// (hieronymus-staff-users) and customer members (inside hieronymus-intake-codes groups).
//
// The TOTP verification itself lives in ./lib/two-factor-gate.js, shared with the three login
// endpoints that enforce it.
//
// Enrollment is two-step on purpose. A secret is issued and held as PENDING; it only becomes active
// once the user proves they can produce a live code from it. Without that confirmation a mistyped
// setup key would lock the account out with no way back in.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { verifyTotp, newSecret, otpauthUri, mintTfaToken, lockState, registerFailure } from './lib/two-factor-gate.js';

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

// Locates an account in either store and hands back a save function, so the rest of this endpoint
// does not care which kind of login it is dealing with.
async function locate(username) {
  const uname = String(username || '').toLowerCase();
  const staffStore = getStore('hieronymus-staff-users');
  const staff = await staffStore.get(uname, { type: 'json' }).catch(() => null);
  if (staff) {
    return { kind: 'staff', record: staff, save: () => staffStore.setJSON(uname, staff) };
  }
  const codes = getStore('hieronymus-intake-codes');
  const { blobs } = await codes.list();
  for (const b of blobs) {
    const group = await codes.get(b.key, { type: 'json' }).catch(() => null);
    const member = group && (group.members || []).find(m => m.username === uname);
    if (member) {
      return { kind: 'customer', record: member, group, save: () => codes.setJSON(b.key, group) };
    }
  }
  return null;
}

async function isStaffAdmin(username, password) {
  if (!username || !password) return false;
  const rec = await getStore('hieronymus-staff-users').get(String(username).toLowerCase(), { type: 'json' }).catch(() => null);
  if (!rec || rec.role !== 'admin') return false;
  return verifyPassword(password, rec.passwordHash);
}

export default async (request) => {
  const url = new URL(request.url);

  // There is deliberately no GET here. A status endpoint that answered 404 for an unknown name and
  // 200 for a real one let anyone enumerate every staff and customer username, and nothing in the
  // app ever called it — the login response already reports twoFactorEnabled to the account itself.

  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await request.json().catch(() => ({}));
  const action = body.action;
  const found = await locate(body.username);
  if (!found) return json({ error: 'Unknown account' }, 404);
  const rec = found.record;

  // An admin resetting someone else's 2FA is the whole recovery story — a lost phone otherwise
  // means a permanently locked account. Reuses the admin-proves-their-own-password pattern already
  // used for password resets.
  if (action === 'reset') {
    if (!await isStaffAdmin(body.requestingStaffUsername, body.requestingStaffPassword)) {
      return json({ error: 'Only a staff admin can reset two-factor for an account' }, 403);
    }
    delete rec.totp;
    await found.save();
    return json({ status: 'ok', enabled: false }, 200);
  }

  // Everything below is the account acting on itself, so it proves its own password first.
  if (!verifyPassword(body.password || '', rec.passwordHash)) {
    return json({ error: 'Invalid password' }, 403);
  }

  if (action === 'begin') {
    // Replacing an authenticator that is already active needs a code from the CURRENT one. Without
    // this, a stolen password was enough to enroll a new phone and take the account over — the
    // password would have been the only thing standing in the way, which is what two-factor exists
    // to prevent. Someone who has genuinely lost their phone goes through an admin reset instead.
    if (rec.totp && rec.totp.enabledAt && rec.totp.secret) {
      const lock = lockState(rec);
      if (lock.locked) return json({ error: 'Too many attempts. Try again in ' + lock.minutes + ' minutes.' }, 429);
      const cur = verifyTotp(rec.totp.secret, body.currentCode);
      if (!cur.ok) {
        registerFailure(rec);
        await found.save();
        return json({
          error: 'Two-factor is already set up on this account. Enter a code from your current authenticator to replace it, or ask an admin to reset it.',
          needsCurrentCode: true
        }, 403);
      }
    }
    const secret = newSecret();
    rec.totp = { ...(rec.totp || {}), pendingSecret: secret, pendingAt: new Date().toISOString() };
    await found.save();
    // The only time a secret is ever returned. Nothing reads it back out afterwards.
    return json({ status: 'pending', secret, otpauth: otpauthUri(String(body.username).toLowerCase(), secret) }, 200);
  }

  if (action === 'confirm') {
    const pending = rec.totp && rec.totp.pendingSecret;
    if (!pending) return json({ error: 'Start enrollment first' }, 409);
    const lock = lockState(rec);
    if (lock.locked) return json({ error: 'Too many attempts. Try again in ' + lock.minutes + ' minutes.' }, 429);
    const res = verifyTotp(pending, body.code);
    if (!res.ok) {
      registerFailure(rec);
      await found.save();
      return json({ error: 'That code is not valid. Check the time on your phone and try again.' }, 403);
    }
    rec.totp = { secret: pending, enabledAt: new Date().toISOString(), lastStep: res.step, failures: 0, lockedUntil: null };
    await found.save();
    // Hand back a session token. The code just used is burnt by the replay guard, so without this the
    // user would finish setup and then wait 30 seconds for a fresh code before they could log in.
    const token = await mintTfaToken(body.username);
    return json({ status: 'enabled', tfToken: token }, 200);
  }

  if (action === 'disable') {
    const secret = rec.totp && rec.totp.secret;
    if (!secret) { delete rec.totp; await found.save(); return json({ status: 'ok', enabled: false }, 200); }
    // Turning it off still requires a live code, so a stolen password alone cannot remove it.
    const res = verifyTotp(secret, body.code);
    if (!res.ok) return json({ error: 'A valid code is required to turn off two-factor.' }, 403);
    delete rec.totp;
    await found.save();
    return json({ status: 'ok', enabled: false }, 200);
  }

  return json({ error: 'Unknown action' }, 400);
};
