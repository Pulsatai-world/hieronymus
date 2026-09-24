// Every button calls something that exists.
//
// A button whose handler is not defined does nothing at all. No error the operator can see, no
// visible state change, nothing in the page to suggest a fault — it is indistinguishable from a
// feature that was never wired up, and the only way to find it is to press it.
//
// Which is how it was found: the intake editor's "Edit intake form" button was dead on arrival,
// because a rewrite replaced a block of the page that happened to contain openIntakeEditor() and
// did not put it back. Twenty-four suites were green. The suite covering that very editor called
// its render function directly and never once opened it.
//
// So this presses nothing and asserts the only thing a static check can: that the function named
// by each handler is defined somewhere the browser will find it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

// Names the browser provides, plus the ones our own loaded modules define.
const SHARED = fs.readdirSync(path.join(ROOT, 'js'))
  .filter(f => f.endsWith('.js'))
  .map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))
  .join('\n');

const BUILT_IN = new Set([
  'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'history', 'location', 'event', 'fetch',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'parseInt', 'parseFloat',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'RegExp', 'Set', 'Map',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'isNaN', 'Promise', 'void'
]);

function definedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return names;
}

const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));

for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const inline = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const known = definedNames(inline + '\n' + SHARED);

  // Handlers written straight into markup, and handlers inside the template literals that build
  // markup at runtime — the second kind is where the dead button was.
  const called = new Map();
  for (const m of src.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|blur|focus)\s*=\s*(["'])([\s\S]*?)\1/g)) {
    for (const c of m[2].matchAll(/(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = c[1];
      if (BUILT_IN.has(name) || known.has(name)) continue;
      // Method calls (foo.bar()) and keywords are not handlers.
      if (/[.\w$]\s*$/.test(m[2].slice(0, c.index)) && m[2].slice(0, c.index).trim().endsWith('.')) continue;
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function'].includes(name)) continue;
      called.set(name, (called.get(name) || 0) + 1);
    }
  }

  const missing = [...called.keys()];
  check(page + ' — every handler it calls is defined', missing.length === 0,
    missing.map(n => n + '()').join(', '));
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all green'));
process.exit(failures ? 1 : 0);
