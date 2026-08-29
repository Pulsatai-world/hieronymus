// "Is this caller allowed, and what may they see?" — asked one way, everywhere.
//
// Endpoints used to answer this for themselves, and between them they recognised five different
// credential namings in query strings and request bodies. Every new rule had to be taught all five,
// and a rule that missed one was a hole: that is how an unauthenticated write and an admin-password
// bypass both survived review. There is one credential now — a session — and one place that reads it.
//
// A session is issued only by /api/login or by finishing /api/enroll, each of which checks a password
// AND a code. So "has a session" means "signed in with two factors", and an endpoint does not have to
// reason about how.

import { readSession } from './session.js';
import { slugify } from './accounts.js';

function refuse(json, message, status) {
  return json({ error: message, needsSignIn: status === 401 }, status);
}

/** The session behind a request, or null. Reads ?session= or a session in the body. */
export async function callerOf(url, body) {
  const token = (url && url.searchParams.get('session')) || (body && body.session) || '';
  return await readSession(token);
}

/**
 * Requires any signed-in staff member. Returns null to proceed, or a Response to return.
 * Used by the internal-only endpoints, where every caller is one of our own pages.
 */
export async function requireStaff(url, body, json) {
  const caller = await callerOf(url, body);
  if (!caller) return refuse(json, 'Sign in to continue.', 401);
  if (caller.kind !== 'staff') return refuse(json, 'Staff access only.', 403);
  return null;
}

/** Requires a signed-in staff admin — creating accounts, releasing dashboards, deleting customers. */
export async function requireStaffAdmin(url, body, json) {
  const caller = await callerOf(url, body);
  if (!caller) return refuse(json, 'Sign in to continue.', 401);
  if (caller.kind !== 'staff' || caller.role !== 'admin') {
    return refuse(json, 'Only a staff admin can do this.', 403);
  }
  return null;
}

/**
 * Requires either any staff member, or the customer this company belongs to.
 *
 * This is the rule that keeps one customer out of another's audit. It compares the company on the
 * session against the company being asked for — the session was issued by a login, so the company on
 * it cannot be chosen by the caller. Previously each endpoint re-derived this from a password, and a
 * browser-side filter had once been all that separated two customers' data.
 */
export async function requireCompany(url, body, json, company) {
  const caller = await callerOf(url, body);
  if (!caller) return refuse(json, 'Sign in to continue.', 401);
  if (caller.kind === 'staff') return null;
  if (!company || slugify(caller.company) !== slugify(company)) {
    return refuse(json, 'Not authorised to read this customer.', 403);
  }
  return null;
}

/** For endpoints that need the caller's identity as well as permission. */
export async function staffCaller(url, body) {
  const caller = await callerOf(url, body);
  return caller && caller.kind === 'staff' ? caller : null;
}

export async function isStaffSession(url, body) {
  return !!(await staffCaller(url, body));
}

/** True when this caller may act as the given member (that customer, or any staff member). */
export async function isSelfOrStaff(url, body, username) {
  const caller = await callerOf(url, body);
  if (!caller) return false;
  if (caller.kind === 'staff') return true;
  return caller.username === String(username || '').toLowerCase();
}
