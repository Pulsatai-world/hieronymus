// What a signed-in page is told about itself, and how a session is issued.
//
// Shared by the login and the enrollment endpoints because both end the same way: a password and a
// live code have been checked, so the person is signed in. Keeping it here means the two cannot
// disagree about what a signed-in caller looks like — the sort of drift that previously left a
// client page unable to render because one path omitted a field the other sent.

import { createStaffSession, createClientSession } from './session.js';

/** Issues the session for an account that has just proved a password and a code. */
export async function sessionFor(acct) {
  return acct.kind === 'staff'
    ? await createStaffSession(acct.username, acct.role)
    : await createClientSession(acct.username, acct.company);
}

/**
 * Everything a page needs to render itself, and nothing secret. A customer's pages read the release
 * flags and the intake state from here, so anything they display must be in this payload — a missing
 * field once meant a released dashboard stayed hidden from the customer it was released to.
 */
export function whoPayload(acct) {
  const base = {
    kind: acct.kind,
    username: acct.username,
    role: acct.role,
    defaultLanguage: acct.record.defaultLanguage || null
  };
  if (acct.kind === 'staff') return base;

  const group = acct.group || {};
  return {
    ...base,
    company: group.company || '',
    submittedAt: group.submittedAt || null,
    monitoringEnabled: !!group.monitoringEnabled,
    diagnosisReleased: !!group.diagnosisReleased,
    monitoringReleased: !!group.monitoringReleased
  };
}
