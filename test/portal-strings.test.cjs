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
const tStart = html.indexOf('const T = {');
if (tStart < 0) { console.log('could not find the T dictionary'); process.exit(1); }
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
