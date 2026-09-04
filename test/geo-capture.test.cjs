// Runs the real bookmarklet source in a fake browser, then feeds what it produces into the real
// scan engine. Everything between the click and the report is covered here.
//
// What it cannot cover: whether a real browser on a real network gets past a site's bot
// protection. That is the whole point of the bookmarklet and it can only be confirmed by a person
// clicking it on a blocked site. Nothing here should be read as evidence that it was.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

// A site with more internal links than the bookmarklet will take, so sampling is exercised.
const page = (title, body) => `<!DOCTYPE html><html lang="es"><head><title>${title}</title>
<meta name="description" content="Una descripción de ${title} con suficiente texto para pasar."></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const links = [];
for (let i = 1; i <= 40; i++) links.push(`<a href="https://ejemplo.mx/pagina-${i}">Página ${i}</a>`);
const home = `<!DOCTYPE html><html lang="es"><head><title>Inicio</title></head><body>
  <nav>${links.join('')}
  <a href="https://otrositio.com/externo">Externo</a>
  <a href="https://ejemplo.mx/doc.pdf">Un PDF</a>
  <a href="https://ejemplo.mx/pagina-1#seccion">Ancla repetida</a>
  </nav><main><h1>Inicio</h1><p>Contenido de la portada.</p></main></body></html>`;

const dom = new JSDOM(home, { url: 'https://ejemplo.mx/', runScripts: 'outside-only' });
const { window } = dom;

const fetched = [];
window.fetch = (u) => {
  fetched.push(u);
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve(page('Página ' + u, 'Texto suficiente para que cuente. '.repeat(30)))
  });
};

let clipboard = null;
window.navigator.clipboard = { writeText: (t) => { clipboard = t; return Promise.resolve(); } };

const src = fs.readFileSync(path.join(ROOT, 'js/geo-capture.src.js'), 'utf8');
window.eval(src);

setTimeout(() => {
  check('it copied something to the clipboard', !!clipboard, 'clipboard was never written');
  if (!clipboard) { finish(); return; }

  let bundle;
  try { bundle = JSON.parse(clipboard); } catch (e) { check('the clipboard holds JSON', false, e.message); finish(); return; }

  check('the bundle is marked as ours', bundle.akoreCapture === 1, JSON.stringify(Object.keys(bundle)));
  check('it caps the page count at 20', bundle.pages.length <= 20, 'got ' + bundle.pages.length);
  check('it captured more than the homepage', bundle.pages.length > 1, 'got ' + bundle.pages.length);
  check('the homepage is first', bundle.pages[0].url === 'https://ejemplo.mx/', bundle.pages[0].url);

  const urls = bundle.pages.map(p => p.url);
  check('every page is same-origin', urls.every(u => u.startsWith('https://ejemplo.mx/')), urls.find(u => !u.startsWith('https://ejemplo.mx/')) || '');
  check('the external link was skipped', !urls.some(u => u.includes('otrositio.com')), 'external link captured');
  check('the PDF was skipped', !urls.some(u => u.endsWith('.pdf')), 'PDF captured');
  check('no duplicates', new Set(urls).size === urls.length, 'duplicate urls present');

  // Sampling should spread across the 40 links, not take the first few.
  const nums = urls.map(u => Number((u.match(/pagina-(\d+)/) || [])[1])).filter(Boolean);
  check('the sample spreads across the site', Math.max(...nums) > 20, 'highest page sampled was ' + Math.max(...nums));

  // The real engine, on the real bundle.
  import(require("node:url").pathToFileURL(path.join(ROOT, "netlify/functions/lib/geo-scan-engine.js")).href).then(mod => {
    const result = mod.runScanFromHtml({ url: bundle.url, pages: bundle.pages });
    check('the engine analysed every captured page', result.scanQuality.pagesAnalyzed === bundle.pages.length,
      result.scanQuality.pagesAnalyzed + ' of ' + bundle.pages.length);
    check('it is marked as supplied HTML', result.scanQuality.source === 'supplied-html', String(result.scanQuality.source));
    check('it produced a score', typeof result.score.overall === 'number', String(result.score.overall));
    console.log('\n  captured ' + bundle.pages.length + ' page(s), engine scored ' + result.score.overall + '/100');
    finish();
  }).catch(e => { check('the engine accepted the bundle', false, e.message); finish(); });
}, 60);

function finish() {
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'capture pipeline works end to end'));
  process.exit(failures ? 1 : 0);
}
