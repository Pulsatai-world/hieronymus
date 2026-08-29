// Authenticator-app codes (TOTP, RFC 6238). Pure functions, no storage, no policy — so it can be
// checked against the RFC's own test vectors, which it is.
//
// Nothing here needs a dependency: a base32 secret, an HMAC-SHA1 over a 30-second counter, and RFC
// 4226 dynamic truncation down to six digits.

import crypto from 'node:crypto';
import QRCode from 'qrcode';

const STEP_SECONDS = 30;
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

/** A fresh 160-bit secret, base32 as authenticator apps expect it. */
export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The six digits an app would show for this secret at this time step. */
export function codeForStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 4294967296), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1000000).padStart(6, '0');
}

export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Checks a typed code against a secret.
 *
 * `drift` is how many 30-second steps either side are accepted. A login uses 1 (a code lives about
 * a minute); enrollment uses more, because it happens once while someone reads a number off one
 * device and types it into another, and a phone clock half a minute out would otherwise make setup
 * impossible with nothing on screen to explain why.
 *
 * Returns the matched step so a caller can refuse to accept the same code twice.
 */
export function verifyCode(secret, code, { drift = 1, nowMs = Date.now() } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  if (!secret || clean.length !== 6) return { ok: false, step: null };
  const current = currentStep(nowMs);
  const window = Math.max(0, Math.min(10, drift));
  for (let d = -window; d <= window; d++) {
    const expected = codeForStep(secret, current + d);
    // Both sides are fixed-length six-digit strings, so this cannot throw on length.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return { ok: true, step: current + d };
    }
  }
  return { ok: false, step: null };
}

/**
 * The URI an authenticator app reads. The label is what the app displays.
 *
 * The label carries the setup time because every enrollment for one account used to produce an
 * identical entry. Someone who had tried before ended up with several "Akore Labs — name" rows in
 * their app, indistinguishable, only one of them live, and the odds of picking the right one got
 * worse with every attempt — which is what "the code is wrong, but the next one works" actually
 * was. Dated, the newest row is obvious and the dead ones can be deleted.
 */
export function otpauthLabel(account, at = new Date()) {
  const stamp = at.toISOString().slice(5, 16).replace('T', ' ');   // MM-DD HH:MM, UTC
  return account + ' (' + stamp + ' UTC)';
}

export function otpauthUri(account, secret, issuer = 'Akore Labs') {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account)
    + '?secret=' + secret
    + '&issuer=' + encodeURIComponent(issuer)
    + '&algorithm=SHA1&digits=6&period=30';
}

/**
 * A QR of that URI, as inline SVG, drawn here rather than in the browser so the encoding comes from
 * a proven implementation — and never fetched from a QR service, which would hand the shared secret
 * to whoever runs it. Returns '' if it cannot be drawn; setup still works from the typed key.
 */
export async function qrSvgFor(uri) {
  try {
    return await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch (e) {
    return '';
  }
}
