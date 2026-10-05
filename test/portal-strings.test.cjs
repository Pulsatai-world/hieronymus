// t() returns the key itself when it cannot find one, so a missing string is not an error — it is
// a label reading "geoTitle", which the uppercase style then renders as "GEOTITLE". That is how
// the scanner panel shipped: its strings were added to GATE_T, the login screen's dictionary,
// while t() reads T.
//
// Two dictionaries sit near the top of this file and the wrong one is the one you meet first.
// This asserts every key the markup asks for is in the dictionary that is actually consulted.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');

// The dictionary t() reads, from `const T = {` to the closing brace at column 0.
const asksForKeys = /data-t(?:-placeholder)?="/.test(html);
const tStart = html.indexOf('const T = {');
if (tStart < 0) {
  // No dictionary is a failure only if the markup is asking it for something. The rebuilt console
  // holds its strings in js/portal-app.js and carries no data-t attributes, so there is no key
  // that could render as its own name. That console is Spanish-only — a real gap, but a different
  // one from the mis-filed-key bug this file exists to catch, and not something it can see.
  console.log(asksForKeys
    ? '  the markup asks for data-t keys but there is no T dictionary to resolve them'
    : '  no T dictionary and no data-t keys — nothing here can render as its own name');
  process.exit(asksForKeys ? 1 : 0);
}
const tBlock = html.slice(tStart, html.indexOf('\n};', tStart));
const defined = new Set([...tBlock.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:/gm)].map(m => m[1]));

const asked = [...new Set(
  [...html.matchAll(/data-t(?:-placeholder)?="([^"]+)"/g)].map(m => m[1])
)];

let missing = 0;
for (const key of asked) {
  if (!defined.has(key)) { console.log('  MISSING  ' + key); missing++; }
}

console.log('  ' + asked.length + ' key(s) referenced by the markup, ' + defined.size + ' defined in T');
console.log(missing ? '\n  ' + missing + ' key(s) would render as their own name' : '\n  every key resolves');
process.exit(missing ? 1 : 0);
