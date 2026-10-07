// restore() coalesces concurrent callers into one request — and must not coalesce across the
// two different sessions a page may be asking about.
//
// Two restores run on every console page load: the sidebar asks, and so does the page. Sharing
// one request is right — a non-ok answer calls setToken('') and would otherwise throw away a
// session the other caller is in the middle of confirming.
//
// But akoreRestoreEither(), which the dashboards use because either audience can open them,
// flips `audience` and calls restore() AGAIN to try the other session. A single-flight keyed on
// nothing handed that second call the first audience's answer: on a dashboard the sidebar asks
// first under the client audience, finds an empty client slot, and a staff member was then told
// they were not signed in — the dashboard showing "you do not have access" over a perfectly
// good staff session. Keying the in-flight promise by the token keeps the coalescing and loses
// the bug: two different tokens are two different questions.
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

function browser({ staff, client }) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  vc.on('error', () => {});
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://test.local/dashboard-diagnostic.html?company=Demo',
    runScripts: 'outside-only', virtualConsole: vc
  });
  const w = dom.window;
  const asked = [];
  try {
    if (staff) w.localStorage.setItem('akore_staff_session', staff);
    if (client) w.sessionStorage.setItem('akore_client_session', client);
  } catch (e) { /* storage refused */ }
  w.fetch = async (u) => {
    const url = new URL(String(u), 'https://test.local');
    const session = url.searchParams.get('session') || '';
    asked.push(session);
    // The server recognises only the staff token in this fixture.
    await new Promise(r => setTimeout(r, 5));
    if (session === staff) {
      return { ok: true, status: 200, json: async () => ({ username: 'akore-local', kind: 'staff', role: 'admin' }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) };
  };
  w.eval(AUTH);
  return { w, asked };
}

test('a staff session survives the sidebar having asked first under the client audience', async () => {
  const { w } = browser({ staff: 'STAFF-TOKEN' });     // staff browser: client slot empty
  // The sidebar fires at DOMContentLoaded and does not await before the page's own code runs.
  const sidebar = w.akoreAuth.restore();
  const who = await w.akoreRestoreEither();
  await sidebar;
  assert.ok(who, 'akoreRestoreEither returned null — the dashboard will say "no access" to staff');
  assert.strictEqual(who.kind, 'staff');
  assert.strictEqual(who.username, 'akore-local');
});

test('and the session is left readable afterwards, not cleared', async () => {
  const { w } = browser({ staff: 'STAFF-TOKEN' });
  const sidebar = w.akoreAuth.restore();
  await w.akoreRestoreEither();
  await sidebar;
  assert.strictEqual(w.localStorage.getItem('akore_staff_session'), 'STAFF-TOKEN',
    'a failed probe under the other audience wiped the staff token');
});

test('concurrent callers asking about the SAME session still make one request', async () => {
  const { w, asked } = browser({ staff: 'STAFF-TOKEN' });
  w.akoreAuth.useStaffSession();
  const [a, b, c] = [w.akoreAuth.restore(), w.akoreAuth.restore(), w.akoreAuth.restore()];
  await Promise.all([a, b, c]);
  assert.strictEqual(asked.length, 1,
    `three concurrent restores made ${asked.length} requests; they should share one`);
  assert.strictEqual(a, b, 'the callers did not get the same promise');
});

test('a later restore after the first settles is a fresh request, not a stale answer', async () => {
  const { w, asked } = browser({ staff: 'STAFF-TOKEN' });
  w.akoreAuth.useStaffSession();
  await w.akoreAuth.restore();
  await w.akoreAuth.restore();
  assert.strictEqual(asked.length, 2, 'the second restore reused a settled promise');
});
