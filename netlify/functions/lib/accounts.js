// Finding an account and checking its password — for both kinds of account, in one place.
//
// There are two kinds and they are stored differently: staff are one record each in
// hieronymus-staff-users, customers are members inside a company group in hieronymus-intake-codes.
// Every login-ish piece of code used to re-derive that difference for itself, which is how five
// different credential namings appeared. Here it is once, and callers get the same shape either way.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const STAFF_STORE = 'hieronymus-staff-users';
const GROUP_STORE = 'hieronymus-intake-codes';

// Where an account's authenticator lives on its record.
//
// Deliberately NOT the old field name. Every account in the platform was left enrolled against a
// secret nobody could produce codes for, after repeated failed setup attempts, so all of them have
// to start over. Reading a new field means every account is simply "not enrolled yet" and sets up
// cleanly on its next login — no bulk operation, no reach into storage, and no recovery scaffolding
// to remember to delete. Any old value is ignored and dropped the next time the record is written.
// ── Resetting every account ──
// Bumping this name voids every authenticator on the platform at once: nothing reads the old field,
// so every account is simply "not enrolled yet" and sets up cleanly on its next sign-in. No bulk
// operation, nothing to reach into storage for, and no half-finished state left to reason about.
// Every older name goes in LEGACY_FIELDS and is deleted the next time a record is written.
//
// Bumped now because repeated failed setup attempts left accounts enrolled against secrets nobody
// could produce codes for, and a full reset was asked for.
const FIELD = 'authenticator_v2';
const LEGACY_FIELDS = ['totp', 'authenticator'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

/**
 * Looks up an account by username, whichever kind it is.
 *
 * Returns null if there is no such account, otherwise:
 *   {
 *     kind: 'staff' | 'customer',
 *     username, role, company,          // company is '' for staff
 *     record,                           // the account's own record (a staff user, or a member)
 *     auth,                             // its authenticator state, or null
 *     setAuth(next), save()             // persist changes
 *   }
 */
export async function findAccount(username) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) return null;

  const staffStore = getStore(STAFF_STORE);
  const staff = await staffStore.get(uname, { type: 'json' }).catch(() => null);
  if (staff) {
    return account({
      kind: 'staff',
      username: uname,
      role: staff.role || 'user',
      company: '',
      record: staff,
      save: () => staffStore.setJSON(uname, staff)
    });
  }

  // Customers: scan the company groups for a member with this username.
  const groups = getStore(GROUP_STORE);
  const { blobs } = await groups.list().catch(() => ({ blobs: [] }));
  for (const b of blobs) {
    const group = await groups.get(b.key, { type: 'json' }).catch(() => null);
    const member = group && (group.members || []).find(m => m && m.username === uname);
    if (member) {
      return account({
        kind: 'customer',
        username: uname,
        role: member.role || 'full',
        company: group.company || '',
        record: member,
        group,
        // Saved under the key the group was actually read from. Deriving the key from the company
        // name instead once wrote a second, shadow copy of a customer whose name and key disagreed.
        save: () => groups.setJSON(b.key, group)
      });
    }
  }
  return null;
}

function account(base) {
  const rec = base.record;
  return {
    ...base,
    get auth() {
      const a = rec[FIELD];
      return a && typeof a === 'object' ? a : null;
    },
    /** True once this account has an authenticator that logins must check. */
    get enrolled() {
      const a = rec[FIELD];
      return !!(a && a.secret && a.enabledAt);
    },
    setAuth(next) {
      if (next) rec[FIELD] = next; else delete rec[FIELD];
      // Drop anything left by the previous scheme so a record cannot carry two answers.
      for (const old of LEGACY_FIELDS) delete rec[old];
    },
    checkPassword(password) {
      return verifyPassword(password, rec.passwordHash);
    }
  };
}

/** Whether an account is enrolled, without exposing anything about it. Used by listings. */
export function isEnrolled(record) {
  const a = record && record[FIELD];
  return !!(a && a.secret && a.enabledAt);
}

/**
 * Strips everything secret from an account record before it goes anywhere near a response: the
 * password hash, and the authenticator (whose secret would let anyone mint valid codes forever).
 * What goes out is the fact of enrollment and nothing more.
 */
export function publicRecord(record) {
  if (!record) return record;
  const clean = { ...record };
  delete clean.passwordHash;
  delete clean[FIELD];
  for (const old of LEGACY_FIELDS) delete clean[old];
  clean.twoFactorEnabled = isEnrolled(record);
  return clean;
}

export const AUTH_FIELD = FIELD;
