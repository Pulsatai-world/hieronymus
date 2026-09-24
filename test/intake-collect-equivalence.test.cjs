// The template-driven form must save exactly what the hand-written form saved.
//
// This is the one change in the intake rebuild that can break things nobody is looking at. The
// answers object is not just redisplayed — prompt generation reads it, and grading reads
// `websites.primarySite` out of it. A key that moves, or a value that arrives as '' instead of
// absent, does not fail loudly here; it fails three steps later as a worse prompt set, for one
// customer, weeks after the change.
//
// So the old collectData() and the new template-driven collect() are run against the SAME filled
// form, and compared key by key. Until they agree, intake.html does not get rewired.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'intake-template.default.json'), 'utf8'));
const pageSrc = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');

// The page's markup, without running its inline script: that script owns the access gate and would
// start talking to the network on load. Only the two functions under test are lifted out of it.
const vc = new VirtualConsole();
const dom = new JSDOM(pageSrc, { url: 'https://test.local/intake.html', runScripts: 'outside-only', virtualConsole: vc });
const { window } = dom;

const inline = [...pageSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const gSrc = /function g\(id\)[^\n]*/.exec(inline);
const collectSrc = /function collectData\(\)\s*\{[\s\S]*?\n\}/.exec(inline);
check('found g() and collectData() in intake.html', !!gSrc && !!collectSrc,
  'g=' + !!gSrc + ' collectData=' + !!collectSrc);
if (!gSrc || !collectSrc) { console.log('\n1 FAILURE(S)'); process.exit(1); }

// The four bespoke sub-forms the page still owns. Both implementations must read the same ones.
const SOCIAL = ['linkedin', 'facebook'];
const BRANDS = ['Bosch', 'Siemens'];
const SITES = [{ url: 'https://b.example', status: 'broken' }];
const PERSONAS = [{ name: 'Planta', role: 'Jefe' }];
window.socialTags = new Set(SOCIAL);
window.brandTags = new Set(BRANDS);
window.getSites = () => SITES;
window.getPersonas = () => PERSONAS;

// collectData() now delegates to the template when one is loaded and falls back to its original
// literal when none is. Both branches are exercised: the fallback is the thing the template was
// checked against, and the delegation is what actually runs in production.
window.intakeTemplate = null;
window.eval(gSrc[0] + '\n' + collectSrc[0] + '\nwindow.__collectData = collectData;');

// Fill every control the template knows about with a value unique to that control, so a value
// landing under the wrong key is visible rather than coincidentally equal.
let filled = 0, skipped = [];
for (const field of template.fields) {
  const el = window.document.getElementById(field.id);
  if (!el) { skipped.push(field.id); continue; }
  if (el.tagName === 'SELECT') {
    const opt = [...el.options].find(o => o.value);
    if (opt) { el.value = opt.value; filled++; }
  } else {
    el.value = 'v-' + field.id;
    filled++;
  }
}
check('every field in the template exists in the page', skipped.length === 0,
  skipped.length + ' missing: ' + skipped.slice(0, 6).join(', '));
check('the form was actually filled before comparing', filled > 40, filled + ' controls');

// The new implementation, loaded exactly as the browser loads it.
window.eval(fs.readFileSync(path.join(ROOT, 'js', 'intake-template.js'), 'utf8'));

const sources = {
  socialTags: () => [...window.socialTags],
  brandTags: () => [...window.brandTags],
  getSites: () => window.getSites(),
  getPersonas: () => window.getPersonas()
};

// The original hand-written object, with no template in play.
window.intakeTemplate = null;
const oldData = window.__collectData();
const newData = window.akoreIntakeForm.collect(template, sources);

// Compare as flat dotted paths, so a report names the key that differs rather than dumping two
// nested objects and leaving the reader to spot it.
function flatten(obj, prefix, out) {
  out = out || {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = JSON.stringify(v);
  }
  return out;
}
const a = flatten(oldData), b = flatten(newData);
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

const missing = keys.filter(k => !(k in b));
const extra = keys.filter(k => !(k in a));
const differing = keys.filter(k => k in a && k in b && a[k] !== b[k]);

console.log('\nThe template-driven form saves what the hand-written one saved:\n');
check('no key the old form saved is lost', missing.length === 0,
  missing.slice(0, 8).join(', '));
check('no key the old form never saved is invented', extra.length === 0,
  extra.slice(0, 8).join(', '));
check('every shared key holds the same value', differing.length === 0,
  differing.slice(0, 6).map(k => `${k}: ${a[k]} vs ${b[k]}`).join(' | '));
check('the comparison covered the whole answers object', keys.length >= 45, keys.length + ' paths');

// The two that grading and storage actually depend on, named so a future edit cannot quietly
// drop them: the storage key is derived from general.website, the grader reads primarySite.
for (const p of ['general.website', 'websites.primarySite', 'general.company']) {
  check('load-bearing path still carries its value: ' + p, !!b[p] && b[p] === a[p], b[p] + ' vs ' + a[p]);
}
// And the four sub-forms, which are the parts collect() cannot read on its own.
for (const p of ['general.socialPlatforms', 'proof.brands', 'websites.additionalSites', 'customer.personas']) {
  check('sub-form survives the round trip: ' + p, a[p] === b[p] && b[p] !== undefined, b[p] + ' vs ' + a[p]);
}


console.log('\nAnd the page really does use the template, not its own list:\n');
{
  // Without this the suite would prove the two agree and never notice that intake.html had been
  // left calling its original literal — a green run on a branch nothing executes.
  check('collectData() delegates to the template when one is loaded',
    /akoreIntakeForm\.collect\(/.test(collectSrc[0]), 'no delegation found in collectData()');

  window.intakeTemplate = template;
  window.socialTags = new Set(SOCIAL);
  window.brandTags = new Set(BRANDS);
  const delegated = window.__collectData();
  const d = flatten(delegated);
  const same = keys.every(k => d[k] === a[k]);
  check('and with the template loaded it still returns the same answers', same,
    keys.filter(k => d[k] !== a[k]).slice(0, 5).map(k => `${k}: ${a[k]} vs ${d[k]}`).join(' | '));
  check('the page loads js/intake-template.js',
    /<script src="\/js\/intake-template\.js"><\/script>/.test(pageSrc), 'script tag missing');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
