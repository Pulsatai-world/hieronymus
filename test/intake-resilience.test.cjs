// What the intake form does when the template cannot be fetched.
//
// The template is loaded before the customer's saved answers are restored, which makes every way
// that request can fail a way the customer loses access to work they already did. A 500 is the easy
// case. The one that matters is a request that never settles: fetch has no timeout of its own, so
// without a deadline the form waits minutes on a wedged connection, showing an empty questionnaire
// to somebody who filled half of it in last week.
//
// In every case the right answer is the same — draw the standard questions and get on with it. A
// form with the wrong wording is worth incomparably more than a form that never appears.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const pageSrc = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');
const inline = [...pageSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'intake-template.default.json'), 'utf8'));

// Only the loader, lifted out of the page: running the page would start its access gate.
const from = inline.indexOf('const TEMPLATE_FETCH_MS');
const to = inline.indexOf('async function applyIntakeTemplate()');
check('the template loader was found in intake.html', from !== -1 && to > from, `${from}..${to}`);
if (from === -1 || to <= from) { console.log('\n1 FAILURE(S)'); process.exit(1); }
const loaderSrc = inline.slice(from, to);

function loaderWith(fetchImpl) {
  const sandbox = {
    fetch: fetchImpl,
    window: { apiQuery: async (e, p) => e },
    setTimeout, clearTimeout, Promise, Array, JSON, console
  };
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(loaderSrc + '\nthis.__load = loadIntakeTemplate;', sandbox);
  return sandbox.__load;
}

const ok = body => ({ ok: true, status: 200, json: async () => body });

(async () => {
  console.log('\nWhen the template cannot be fetched:\n');

  {
    const load = loaderWith(async () => { throw new Error('offline'); });
    const got = await load('Acme');
    check('a network failure falls back rather than throwing', got === null, JSON.stringify(got));
  }

  {
    const load = loaderWith(async (u) => String(u).indexOf('/api/') !== -1
      ? { ok: false, status: 500, json: async () => ({}) }
      : ok(template));
    const got = await load('Acme');
    check("a 500 from the customer's own template falls back to the standard questions",
      got && got.fields.length === template.fields.length, got ? got.fields.length : 'null');
  }

  {
    const load = loaderWith(async (u) => String(u).indexOf('/api/') !== -1
      ? ok({ company: 'Acme', template: { fields: [] } })
      : ok(template));
    const got = await load('Acme');
    check('a template with no questions in it is not used',
      got && got.fields.length === template.fields.length, got ? got.fields.length : 'null');
  }

  {
    const load = loaderWith(async (u) => String(u).indexOf('/api/') !== -1
      ? ok({ company: 'Acme', template: { fields: 'not an array' } })
      : ok(template));
    const got = await load('Acme');
    check('a malformed template is not used', got && Array.isArray(got.fields),
      JSON.stringify(got && got.fields).slice(0, 40));
  }

  {
    // The one with teeth. Without a deadline this never returns.
    const load = loaderWith((u) => String(u).indexOf('/api/') !== -1
      ? new Promise(() => {})                      // never settles
      : Promise.resolve(ok(template)));
    const started = Date.now();
    const got = await load('Acme');
    const took = Date.now() - started;
    check('a request that never settles gives up instead of hanging the form', took < 9000, took + 'ms');
    check('and the customer still gets the standard questions',
      got && got.fields.length === template.fields.length, got ? got.fields.length : 'null');
  }

  {
    // Both wedged: still has to return, so the form renders its own original wording.
    const load = loaderWith(() => new Promise(() => {}));
    const started = Date.now();
    const got = await load('Acme');
    check('with nothing reachable at all it still returns', Date.now() - started < 15000,
      (Date.now() - started) + 'ms');
    check('and says so plainly rather than inventing a template', got === null, JSON.stringify(got));
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
  process.exit(failures ? 1 : 0);
})();
