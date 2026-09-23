// Akore is a Mexican company and Spanish is the product's first language, not a translation of
// the English one. Rene has asked three times for copy that reads as written rather than
// converted, so the two things that can be checked mechanically are checked here.
//
// What this catches: em dashes, which are English punctuation and were scattered through the
// Spanish; peninsular vocabulary, which is Spanish but not Mexican and reads as foreign to the
// customer; and "(s)" plurals, which nobody writes by hand — the report said "20 página(s)" and
// "14 archivo(s)" in a document meant to read as though a person wrote it. The count is always
// in the string, so the sentence can choose the word.
// What it cannot catch is register and phrasing. Those still need reading aloud.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'portal.html', 'index.html', 'client-portal.html', 'geo-report.html',
  'dashboard-diagnostic.html', 'dashboard-monitoring.html', 'prompt-review.html', 'intake.html',
  'netlify/functions/lib/geo-client-report.js',
  'netlify/functions/lib/geo-report-html.js',
  'netlify/functions/lib/geo-scan-engine.js',
  'netlify/functions/lib/geo-check-registry.js'
];

// Spain's word first, Mexico's second.
const PENINSULAR = [
  ['añade', 'agrega'], ['Añade', 'Agrega'], ['añadir', 'agregar'],
  ['pulsa ', 'presiona'], ['Introduce ', 'Escribe'],
  ['ordenador', 'computadora'], ['fichero', 'archivo'],
  ['coger ', 'tomar'], ['vale,', 'está bien,']
];

let failures = 0;
const fail = (msg) => { console.log('  FAIL  ' + msg); failures++; };

// Spanish strings are written as es: '…' in the dictionaries and t('…', '…') in the engine.
function spanishStrings(src) {
  const out = [];
  for (const m of src.matchAll(/\bes:\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bt\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')\s*,/g)) out.push(m[1]);
  // The client report writes its copy as plain object keys rather than es:/t(). Without these it
  // reported zero Spanish strings for the most Spanish file in the project, and would have passed
  // no matter what was in it.
  for (const m of src.matchAll(/\b(?:titulo|que|porque|txt|titular|resumen):\s*('(?:[^'\\]|\\.)*')/g)) out.push(m[1]);
  return out;
}

console.log('Spanish copy reads as Mexican Spanish, not as translated English:\n');

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const strings = spanishStrings(src);

  const dashed = strings.filter(s => s.includes('—'));
  if (dashed.length) {
    fail(rel + ' — ' + dashed.length + ' Spanish string(s) contain an em dash');
    dashed.slice(0, 3).forEach(s => console.log('        ' + s.replace(/\s+/g, ' ').slice(0, 100)));
  }

  for (const [spain, mexico] of PENINSULAR) {
    const hits = strings.filter(s => s.includes(spain));
    if (hits.length) fail(rel + ': "' + spain + '" is peninsular, use "' + mexico + '" (' + hits.length + ')');
  }

  // "página(s)", "revisión(es)". In the engine the count sits in the template literal, so use the
  // pl() helper; in the report dictionaries use the {n:singular|plural} token.
  const bracketed = strings.filter(s => /[a-záéíóúñ]+\((?:s|es)\)/i.test(s));
  if (bracketed.length) {
    fail(rel + ' — ' + bracketed.length + ' Spanish string(s) use a "(s)" plural');
    bracketed.slice(0, 3).forEach(s => console.log('        ' + s.replace(/\s+/g, ' ').slice(0, 110)));
  }

  if (!dashed.length && !bracketed.length) console.log('  PASS  ' + rel + '  (' + strings.length + ' Spanish string(s))');
}

console.log('\n' + (failures ? failures + ' PROBLEM(S)' : 'no em dashes and no peninsular vocabulary in Spanish copy'));
process.exit(failures ? 1 : 0);
