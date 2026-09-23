// These all reached the portal and were found by reading the rendered report, not the source.
// They are the same class of bug each time: the string looks right where it is written, and comes
// out wrong once a real number or a real heading is put through it.
//
//   "se analizaron 1 página"      the noun agreed with the count, the verb did not
//   "Track record crítico.."      headings that are whole sentences, joined with '; '
//   "Decide primero …"            an instruction cut in half, because the row shows one sentence
//
// So this renders a report and reads the text, rather than asserting about the dictionaries.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/');

let failures = 0;
const check = (name, ok, got) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '\n         got: ' + got));
  if (!ok) failures++;
};

const readable = html => html
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&([a-z]+);/g, (m, n) => ({ aacute: 'á', oacute: 'ó', iacute: 'í', eacute: 'é',
    uacute: 'ú', ntilde: 'ñ', laquo: '«', raquo: '»', amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ' }[n] || m))
  .replace(/\s+/g, ' ');

// A one-page site whose section headings are full sentences, as jeeves-solutions.com's are.
const ONE_PAGER = `<!doctype html><html lang="es"><head><title>Prueba</title></head><body>
<nav><a href="#a">A</a><a href="#b">B</a><a href="#c">C</a><a href="#d">D</a></nav>
<h1>Prueba</h1>
<h2>Nuestros valores son la arquitectura de todo lo que construimos.</h2><p>Texto de la sección uno.</p>
<h2>Conectividad inteligente de extremo a extremo.</h2><p>Texto de la sección dos.</p>
<h2>Servicios diseñados para escalar.</h2><p>Texto de la sección tres.</p>
<h2>Track record crítico.</h2><p>Texto de la sección cuatro.</p>
</body></html>`;

(async () => {
  const { buildReportHtml } = await import(url('netlify/functions/lib/geo-report-html.js'));
  const { runScanFromHtml } = await import(url('netlify/functions/lib/geo-scan-engine.js'));

  console.log('The rendered report reads as written Spanish:\n');

  const scan = await runScanFromHtml({
    url: 'https://ejemplo.mx/',
    pages: [{ url: 'https://ejemplo.mx/', html: ONE_PAGER }]
  });
  const one = readable(buildReportHtml(scan, 'es'));

  check('a count of one takes a singular verb',
    /se analizó 1 página/.test(one),
    (one.match(/se analiz\w+ \d+ p\wgina\w*/) || ['not found'])[0]);

  check('no "(s)" plurals survive into the page',
    !/[a-záéíóúñ]+\((?:s|es)\)/i.test(one),
    (one.match(/.{0,30}[a-záéíóúñ]+\((?:s|es)\).{0,20}/i) || ['-'])[0]);

  check('sentence headings do not collide with their separator',
    !/\.;|\.\./.test(one),
    (one.match(/.{40}(\.;|\.\.).{20}/) || ['-'])[0]);

  check('the topic list appears once, not in the instruction too',
    (one.match(/Nuestros valores son la arquitectura/g) || []).length === 1,
    (one.match(/Nuestros valores son la arquitectura/g) || []).length + ' occurrences');

  // Every row shows one sentence of howToFix, so no instruction may carry its point in a second.
  const FIXTURE = path.join(__dirname, 'fixtures', 'scan-fiacsa.json');
  if (fs.existsSync(FIXTURE)) {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const c of fx.pageDiscovery.categories) c.status = 'FAIL';
    const merged = readable(buildReportHtml(fx, 'es'));
    check('the merged missing-pages instruction is not cut in half',
      /crea las que falten y enlázalas/.test(merged),
      (merged.match(/Decide primero.{0,130}/) || ['not found'])[0]);
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'the report reads correctly'));
  process.exit(failures ? 1 : 0);
})();
