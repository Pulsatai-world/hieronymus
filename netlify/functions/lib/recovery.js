// Recovery codes: the way back in when the phone with the authenticator is gone.
//
// Until these existed the only recovery was a staff admin clearing someone's authenticator, which
// leaves a platform with one admin unable to recover that admin — the reset needs an admin session,
// and an admin session needs a code from the phone that was lost. That is a real lockout with no
// path out except editing storage by hand.
//
// A code is single-use. Ten are issued at enrollment, shown once, and only their hashes are kept:
// a stored recovery code is a password equivalent, and a leak of the record must not hand someone
// a way in.
//
// Hashed with SHA-256 rather than scrypt, deliberately. scrypt is slow on purpose, to make guessing
// a human-chosen password expensive. These are not human-chosen: fifty bits from a CSPRNG, which is
// far past the point where guessing is the attack. Slow hashing would only mean up to ten scrypt
// runs on every sign-in that used one.

import crypto from 'node:crypto';

// No I, L, O or U: the first three are unreadable next to 1 and 0, and dropping U keeps the set
// from spelling words. 32 symbols, so ten characters carry fifty bits.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 10;
export const RECOVERY_CODE_COUNT = 10;

/** Normalises what someone typed: case, spaces and dashes are all forgiven. */
export function normalizeRecoveryCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** One code, drawn without modulo bias, formatted in two groups for reading aloud. */
function oneCode() {
  let out = '';
  while (out.length < CODE_CHARS) {
    // 256 is not a multiple of 32 — it is, but rejection sampling is kept so the alphabet can
    // change size later without quietly reintroducing bias.
    for (const byte of crypto.randomBytes(CODE_CHARS)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === CODE_CHARS) break;
    }
  }
  return out.slice(0, 5) + '-' + out.slice(5);
}

/**
 * A fresh set. Returns the plaintext codes (shown once, never stored) and the records to persist.
 * Any set this replaces is dead the moment these are saved.
 */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = Array.from({ length: count }, oneCode);
  return {
    codes,
    stored: codes.map(c => ({ hash: hashRecoveryCode(c), usedAt: null })),
    issuedAt: new Date().toISOString()
  };
}

/**
 * Checks a typed code against the unused ones and marks the match as spent.
 *
 * Mutates the list, so the caller saves the record afterwards — a code that is accepted but not
 * recorded as used would be reusable forever, which is the whole point of single-use.
 *
 * Returns { ok, remaining }.
 */
export function consumeRecoveryCode(list, input) {
  const codes = Array.isArray(list) ? list : [];
  const wanted = hashRecoveryCode(input);
  const remainingOf = () => codes.filter(c => c && !c.usedAt).length;
  if (normalizeRecoveryCode(input).length !== CODE_CHARS) return { ok: false, remaining: remainingOf() };

  let matched = false;
  for (const entry of codes) {
    if (!entry || entry.usedAt || typeof entry.hash !== 'string' || entry.hash.length !== wanted.length) continue;
    // Constant-time, so a near-miss cannot be told from a miss by how long the answer took.
    if (crypto.timingSafeEqual(Buffer.from(entry.hash, 'hex'), Buffer.from(wanted, 'hex')) && !matched) {
      entry.usedAt = new Date().toISOString();
      matched = true;
    }
  }
  return { ok: matched, remaining: remainingOf() };
}

/** How many are left, for telling someone they are running low. Never exposes the codes. */
export function recoveryRemaining(list) {
  return (Array.isArray(list) ? list : []).filter(c => c && !c.usedAt).length;
}

/** The length a recovery code normalises to, so callers can tell one from a six-digit code. */
export const RECOVERY_CODE_LENGTH = CODE_CHARS;
