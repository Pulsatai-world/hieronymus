// Per-customer intake templates: who may read which copy, and what cannot be taken out of one.
//
// Two rules carry this feature, and both have to hold on the server. A customer holds a working
// intake link, so anything enforced only in the staff editor is enforced nowhere. And a template is
// the input to prompt generation and to grading, so a template that drops general.website does not
// break the form — it produces an audit about nobody, weeks later, for one customer.
//
//   * A customer is served the RELEASED copy and never the draft. A form half-edited on a Tuesday
//     morning must not be what the client opens on Tuesday afternoon.
//   * The four load-bearing answers cannot be removed, renamed, or switched off, at save OR at
//     release, whatever the editor happens to allow today.
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('path');
register('./support/blobs-hook.mjs', pathToFileURL(__filename));

const STORES = (globalThis.__BLOBS__ = globalThis.__BLOBS__ || {});
const store = name => (STORES[name] = STORES[name] || {});

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

const URL_BASE = 'https://x/api/intake-template';
const call = (fn, method, { qs = '', body = null } = {}) =>
  fn(new Request(URL_BASE + qs, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }), {});

// A template good enough to be accepted: the four required answers, switched on.
const okTemplate = (extra = {}) => ({
  version: 1,
  sections: [{ id: 'panel-0', order: 0, title: { en: 'General', es: 'General' } }],
  fields: [
    { id: 'company', section: 'panel-0', type: 'text', paths: ['general.company'], label: { en: 'Company', es: 'Empresa' } },
    { id: 'industry', section: 'panel-0', type: 'text', paths: ['general.industry'], label: { en: 'Industry', es: 'Industria' } },
    { id: 'website', section: 'panel-0', type: 'url', paths: ['general.website', 'websites.primarySite'], label: { en: 'Site', es: 'Sitio' } }
  ],
  ...extra
});

(async () => {
  const fn = (await import(pathToFileURL(path.resolve('netlify/functions/intake-template.js')).href)).default;
  const { createStaffSession, createClientSession } = await import(pathToFileURL(
    path.resolve('netlify/functions/lib/session.js')).href);

  Object.keys(STORES).forEach(k => delete STORES[k]);
  const STAFF = await createStaffSession('akore-rene', 'admin');
  const CUST = await createClientSession('acme-user', 'Acme');
  const OTHER = await createClientSession('rival-user', 'Rival Co');

  const staffQ = (extra = '') => `?session=${encodeURIComponent(STAFF)}${extra}`;
  const custQ = (s, extra = '') => `?session=${encodeURIComponent(s)}${extra}`;

  console.log('The release gate:\n');
  {
    const saved = await call(fn, 'POST', { body: { session: STAFF, company: 'Acme', template: okTemplate() } });
    check('staff can save a draft', saved.status === 200, String(saved.status));

    // The whole point of the gate.
    const asCustomer = await call(fn, 'GET', { qs: custQ(CUST, '&company=Acme') });
    const custBody = await asCustomer.json();
    check('a customer sees nothing while it is only a draft',
      asCustomer.status === 200 && custBody.template === null, JSON.stringify(custBody).slice(0, 120));
    check('and is not even told a draft exists',
      !('draft' in custBody) && !('unreleasedChanges' in custBody), Object.keys(custBody).join(','));

    const asStaff = await call(fn, 'GET', { qs: staffQ('&company=Acme') });
    const staffBody = await asStaff.json();
    check('staff can see the draft they are working on', !!staffBody.draft, JSON.stringify(staffBody).slice(0, 80));
    check('and are told it has not reached the customer', staffBody.unreleasedChanges === true,
      String(staffBody.unreleasedChanges));

    const released = await call(fn, 'PATCH', { body: { session: STAFF, company: 'Acme' } });
    check('staff can release it', released.status === 200, String(released.status));

    const after = await (await call(fn, 'GET', { qs: custQ(CUST, '&company=Acme') })).json();
    check('now the customer is served it', !!after.template && after.template.fields.length === 3,
      JSON.stringify(after).slice(0, 100));

    // Editing after release must not reach the customer until it is released again.
    const edited = okTemplate();
    edited.fields.push({ id: 'shifts', section: 'panel-0', type: 'text', paths: ['problem.shifts'], label: { en: 'Shifts', es: 'Turnos' } });
    await call(fn, 'POST', { body: { session: STAFF, company: 'Acme', template: edited } });
    const mid = await (await call(fn, 'GET', { qs: custQ(CUST, '&company=Acme') })).json();
    check('a later edit does not reach the customer on its own', mid.template.fields.length === 3,
      mid.template.fields.length + ' fields');

    await call(fn, 'PATCH', { body: { session: STAFF, company: 'Acme' } });
    const now = await (await call(fn, 'GET', { qs: custQ(CUST, '&company=Acme') })).json();
    check('releasing again does', now.template.fields.length === 4, now.template.fields.length + ' fields');

    const withdrawn = await call(fn, 'PATCH', { body: { session: STAFF, company: 'Acme', withdraw: true } });
    const back = await (await call(fn, 'GET', { qs: custQ(CUST, '&company=Acme') })).json();
    check('withdrawing puts them back on the default set',
      withdrawn.status === 200 && back.template === null, JSON.stringify(back).slice(0, 80));
  }

  console.log('\nThe four answers nothing else can work without:\n');
  {
    for (const [why, mutate] of [
      ['removed', t => { t.fields = t.fields.filter(f => f.id !== 'website'); }],
      ['switched off', t => { t.fields.find(f => f.id === 'company').enabled = false; }],
      ['renamed to a different path', t => { t.fields.find(f => f.id === 'industry').paths = ['general.sector']; }]
    ]) {
      const t = okTemplate();
      mutate(t);
      const res = await call(fn, 'POST', { body: { session: STAFF, company: 'Beta', template: t } });
      const body = await res.json();
      check(`a required answer cannot be ${why}`, res.status === 400, res.status + ' ' + (body.error || ''));
    }

    // websites.primarySite rides on the same field as general.website; losing just that one path is
    // the subtle version, and grading is what breaks.
    const t = okTemplate();
    t.fields.find(f => f.id === 'website').paths = ['general.website'];
    const res = await call(fn, 'POST', { body: { session: STAFF, company: 'Beta', template: t } });
    check('nor can one half of a two-path answer be dropped', res.status === 400,
      res.status + ' ' + ((await res.json()).error || ''));

    // A record written before the rule existed must not sneak through at release time.
    store('hieronymus-intake-templates')['gamma'] = {
      company: 'Gamma', draft: (() => { const g = okTemplate(); g.fields = g.fields.filter(f => f.id !== 'company'); return g; })(),
      savedAt: '2026-01-01T00:00:00Z'
    };
    const rel = await call(fn, 'PATCH', { body: { session: STAFF, company: 'Gamma' } });
    check('and a bad draft already in the store is refused at release', rel.status === 400,
      String(rel.status));
    const served = await (await call(fn, 'GET', { qs: staffQ('&company=Gamma') })).json();
    check('so it never becomes what a customer is served', !served.released, JSON.stringify(served.released));
  }

  console.log('\nWho may touch a template:\n');
  {
    const noSession = await call(fn, 'GET', { qs: '?company=Acme' });
    check('an unauthenticated read is refused', noSession.status === 401, String(noSession.status));

    const otherCustomer = await call(fn, 'GET', { qs: custQ(OTHER, '&company=Acme') });
    check("a customer cannot read another customer's template", otherCustomer.status === 403,
      String(otherCustomer.status));

    const custWrite = await call(fn, 'POST', { body: { session: CUST, company: 'Acme', template: okTemplate() } });
    check('a customer cannot edit their own form', custWrite.status === 403, String(custWrite.status));

    const custRelease = await call(fn, 'PATCH', { body: { session: CUST, company: 'Acme' } });
    check('nor release one', custRelease.status === 403, String(custRelease.status));

    const custDelete = await call(fn, 'DELETE', { qs: custQ(CUST, '&company=Acme') });
    check('nor delete one', custDelete.status === 403, String(custDelete.status));

    const list = await call(fn, 'GET', { qs: custQ(CUST) });
    check('listing every customer is staff-only', list.status === 403, String(list.status));

    const staffList = await call(fn, 'GET', { qs: staffQ() });
    check('and staff can list', staffList.status === 200, String(staffList.status));
  }


  console.log('\nStaff opening a customer\'s own intake form:\n');
  {
    // Staff are answered draft and released separately, because the editor needs both. The page
    // reads that shape too — otherwise a staff preview quietly renders the DEFAULT questions and
    // looks exactly like a customer whose form was never tailored.
    await call(fn, 'POST', { body: { session: STAFF, company: 'Delta', template: okTemplate() } });
    await call(fn, 'PATCH', { body: { session: STAFF, company: 'Delta' } });

    const body = await (await call(fn, 'GET', { qs: staffQ('&company=Delta') })).json();
    check('the staff answer carries the released copy', !!body.released, Object.keys(body).join(','));

    const fs = require('fs');
    const page = fs.readFileSync(require('path').join(__dirname, '..', 'intake.html'), 'utf8');
    check('and the page reads it, not only the customer-shaped field',
      /body\.template \|\| body\.released/.test(page), 'intake.html only reads body.template');
  }


  console.log('\nPreviewing an unreleased form:\n');
  {
    // Staff preview a draft by opening the customer's own intake link with ?preview=draft. That is
    // a URL anyone can type, so the rule cannot live in the page: the draft has to be absent from
    // what a customer is answered, whatever they ask for.
    await call(fn, 'POST', { body: { session: STAFF, company: 'Epsilon', template: okTemplate() } });

    const asStaff = await (await call(fn, 'GET', { qs: staffQ('&company=Epsilon&preview=draft') })).json();
    check('staff get the draft, which is what the preview renders', !!asStaff.draft, Object.keys(asStaff).join(','));

    const cust = await createClientSession('eps-user', 'Epsilon');
    const asCust = await (await call(fn, 'GET', { qs: custQ(cust, '&company=Epsilon&preview=draft') })).json();
    check('a customer asking for the draft by URL still gets none',
      !asCust.draft && asCust.template === null, JSON.stringify(asCust).slice(0, 120));
  }

  console.log('\nThe editor and the server agree on the rules:\n');
  {
    // Two copies of the same list, in two languages, in two files. If they drift the editor offers
    // to switch off a question the server then refuses, and staff meet an error with no explanation
    // for what they did wrong.
    const fs = require('fs');
    const here = f => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    const listIn = (src, name) => {
      const at = src.indexOf(name + ' = [');
      if (at === -1) return null;
      const body = src.slice(at, src.indexOf(']', at));
      const quoted = body.match(/'([^']+)'/g);
      return quoted ? quoted.map(x => x.slice(1, -1)).sort() : null;
    };
    const server = listIn(here('netlify/functions/intake-template.js'), 'REQUIRED_PATHS');
    const editor = listIn(here('index.html'), 'TPL_REQUIRED');
    check('both know which four answers are protected', !!server && !!editor,
      'server=' + server + ' editor=' + editor);
    check('and they are the same four', JSON.stringify(server) === JSON.stringify(editor),
      JSON.stringify(server) + ' vs ' + JSON.stringify(editor));

    // An added question must not be able to land on a path the generator or grader reads.
    check('questions added in the editor are stored out of the way, under extra.',
      /paths: \['extra\.'/.test(here('index.html')), 'tplAdd does not namespace its path');
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
