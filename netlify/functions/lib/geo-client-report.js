// The client-facing report. Same scan payload as the technical version, different reader: a
// business owner being shown this by Roy, not a technician working a list.
//
// Structure follows the editorial pattern Rene liked — numbered sections, a mono eyebrow over a
// large headline, paired "what works / what doesn't" panels, status words instead of scores.
// What it does NOT follow: claims a scan cannot support. No projected trajectory, no competitor
// assertions, no generated prose about the business. Every line below is traceable to a check,
// and a section that has no evidence behind it does not render at all.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Reading the payload ────────────────────────────────────────────────────────────────────────

function aggregate(data) {
  const agg = {};
  (function walk(o, page) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, page));
    const p = o.url || page;
    if (o.id && o.status) {
      const a = agg[o.id] = agg[o.id] || { statuses: [], pages: new Set() };
      a.statuses.push(o.status);
      if (p && (o.status === 'FAIL' || o.status === 'WARNING')) a.pages.add(p);
    }
    Object.values(o).forEach(v => walk(v, p));
  })(data, '');
  return agg;
}

// A score becomes a word. A prospect cannot act on 64, and inviting them to compare 64 against
// some other site's number is a promise this scan does not make.
function band(score) {
  if (score === null || score === undefined) return { word: 'sin verificar', tone: 'unknown' };
  if (score >= 80) return { word: 'bien', tone: 'good' };
  if (score >= 60) return { word: 'a medias', tone: 'mid' };
  return { word: 'débil', tone: 'bad' };
}

// ── The problems, grouped by the job that fixes them ──────────────────────────────────────────
const CATALOGUE = [
  {
    ids: ['content-depth', 'authority-signals', 'entities', 'first-250-specificity'],
    titulo: 'Las páginas no dicen lo suficiente como para que la IA las cite',
    que: 'La mayoría de las páginas de producto y de servicio tienen muy poco texto. La IA puede entrar y leerlas perfectamente, y aun así no citarlas nunca, porque no hay nada concreto que citar.',
    porque: 'Las respuestas de la IA se arman con páginas que explican el servicio a detalle: qué incluye, para quién es, cómo funciona, cuánto tarda.'
  },
  {
    ids: ['schema-completeness', 'schema'],
    titulo: 'La ficha del negocio está incompleta',
    que: 'El sitio web sí trae una ficha con los datos del negocio —qué es, dónde está y a qué se dedica— pero le faltan datos obligatorios, y en varias páginas no aparece.',
    porque: 'Si a esa ficha le falta un dato obligatorio, no se puede usar: no aporta nada aunque esté ahí. Es de lo que más ayuda para que la IA reconozca un negocio real.'
  },
  {
    ids: ['meta-description', 'open-graph'],
    titulo: 'Faltan las descripciones de varias páginas',
    que: 'Es el resumen que aparece debajo del título en los resultados de búsqueda, y el que se ve cuando alguien comparte la página por WhatsApp.',
    porque: 'Es el primer texto que se lee para decidir de qué trata la página. Se escribe desde el mismo administrador del sitio web, una por página.'
  },
  {
    ids: ['main-landmark', 'a11y-tree-health', 'headings', 'heading-hierarchy'],
    titulo: 'No se distingue el contenido principal del resto de la página',
    que: 'Nada separa el contenido de verdad del menú, la columna lateral y el pie de página. Además los títulos saltan niveles, así que el orden de la página no queda claro.',
    porque: 'Si la IA no distingue el contenido del menú, se lleva el menú. Se corrige una sola vez en la plantilla y queda resuelto en todas las páginas a la vez.'
  },
  {
    ids: ['image-alt'],
    titulo: 'Las fotos no traen descripción',
    que: 'Ninguna de las imágenes revisadas trae una descripción escrita, que es lo que se lee cuando no se puede ver la foto.',
    porque: 'Sin esa descripción, cada foto de producto es invisible para Google y para la IA.'
  },
  {
    ids: ['content-freshness'],
    titulo: 'No se puede saber qué tan actual es la información',
    que: 'Las páginas no traen una fecha de actualización, así que no hay forma de saber si lo que dicen sigue vigente.',
    porque: 'Ante dos páginas parecidas, la IA prefiere la que se ve reciente. Sin fecha, la tuya pierde por descarte.'
  },
  {
    ids: ['answer-format'],
    titulo: 'El contenido no está escrito en forma de respuesta',
    que: 'Las páginas son texto corrido. No hay preguntas con su respuesta debajo, ni listas, ni tablas comparativas.',
    porque: 'A la IA le cuesta mucho más sacar una respuesta directa de un párrafo largo que de una pregunta contestada en la primera línea.'
  }
];

const BUENO = [
  { ids: ['multi-ua', 'robots-txt', 'x-robots-tag', 'noindex-meta', 'edge-protection'],
    txt: 'Nada le impide el paso a la IA. Puede entrar al sitio web sin ningún obstáculo.' },
  { ids: ['response-time'], txt: 'El sitio web abre rápido.' },
  { ids: ['sitemap'], txt: 'La IA puede encontrar todas las páginas sin batallar.' },
  { ids: ['faq-schema-match'], txt: 'Las preguntas frecuentes están puestas de manera que la IA puede tomarlas como respuesta.' },
  { ids: ['title'], txt: 'Los títulos de las páginas están bien escritos y con el largo adecuado.' },
  { ids: ['contact-machine-readable'], txt: 'El teléfono y el correo se detectan solos, sin que nadie tenga que buscarlos.' },
  { ids: ['js-rendering'], txt: 'El texto se lee sin necesidad de que la página termine de cargar sus programas.' },
  { ids: ['canonical'], txt: 'Cada página declara cuál es su dirección oficial, así que no se duplica sola.' },
  { ids: ['author-attribution'], txt: 'El contenido tiene autor identificable, no es texto anónimo.' }
];

// Questions the site already asks in its own words, taken from the question-form headings the
// scanner found on the page. Never invented, and never the FAQ schema text — the engine records
// that only as a count, so the words themselves are not available to quote.
//
// Below two questions the section does not render at all. One lonely question makes a weaker
// point than no section, and its absence is itself the finding.
function preguntas(data) {
  const found = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (Array.isArray(o.questionHeadings)) o.questionHeadings.forEach(q => {
      if (typeof q === "string" && q.trim().length > 8) found.push(q.trim());
    });
    Object.values(o).forEach(walk);
  })(data);
  const unique = [...new Set(found)];
  return unique.length >= 2 ? unique.slice(0, 6) : [];
}

// ── Render ─────────────────────────────────────────────────────────────────────────────────────

export function buildClientReport(data) {
  const agg = aggregate(data);
  const has = (id, s) => (agg[id]?.statuses || []).includes(s);
  const passed = id => has(id, 'PASS');
  const flagged = id => (agg[id]?.statuses || []).some(s => s === 'FAIL' || s === 'WARNING');
  const failed = id => has(id, 'FAIL');
  const pagesFor = ids => new Set(ids.flatMap(id => [...(agg[id]?.pages || [])])).size;

  const layer = id => (data.layers || []).find(l => l.id === id) || {};
  const host = (() => { try { return new URL(data.input.url).hostname; } catch { return data.input.url; } })();
  const fecha = new Date(data.scannedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  const nPages = data.scanQuality?.pagesAnalyzed ?? 0;
  const bloqueos = data.score?.blockers?.count ?? 0;

  const problemas = CATALOGUE
    .map(c => ({ ...c, paginas: pagesFor(c.ids), grave: c.ids.some(failed) }))
    .filter(c => c.ids.some(flagged))
    .sort((a, b) => (b.grave - a.grave) || (b.paginas - a.paginas));

  const bueno = BUENO.filter(b => b.ids.some(passed));
  const qs = preguntas(data);

  const acceso = band(layer('access').score);
  const lectura = band(layer('readability').score);
  const cita = band(layer('substance').score);

  // Nothing read is not the same as nothing there. Said plainly, rather than describing an
  // empty site that was never actually looked at.
  const sinPaginas = nPages === 0;
  const titular = sinPaginas
    ? 'No se pudo leer ninguna página del sitio web.'
    : bloqueos === 0
    ? 'Nada impide que la IA entre al sitio web. El problema es lo que encuentra cuando entra.'
    : 'Hay algo bloqueándole el paso a la IA. Eso se resuelve primero.';
  const resumen = sinPaginas
    ? 'El servidor respondió, pero rechazó cada intento de leer una página, así que no hay nada que informar todavía. Esto no dice nada sobre el sitio web en sí: sólo que no se dejó revisar de forma automática.'
    : bloqueos === 0
    ? `Revisamos ${nPages} página${nPages === 1 ? '' : 's'}. ChatGPT, Gemini, Perplexity y Google pueden entrar sin ningún problema. Lo que falta es información concreta que puedan citar.`
    : `Revisamos ${nPages} página${nPages === 1 ? '' : 's'} y encontramos ${bloqueos} punto${bloqueos === 1 ? '' : 's'} que le impiden el paso a la IA. Mientras eso siga así, lo demás no importa.`;

  const señal = (titulo, b, texto) => `
    <div class="signal">
      <div class="signal-head">
        <h3>${esc(titulo)}</h3>
        <span class="chip chip-${b.tone}">${esc(b.word.toUpperCase())}</span>
      </div>
      <p>${esc(texto)}</p>
    </div>`;

  const seccion = (n, eyebrow, titulo, cuerpo) => `
    <section class="sec">
      <div class="sec-head">
        <span class="sec-n">${esc(n)}</span>
        <div>
          <div class="eyebrow">${esc(eyebrow)}</div>
          <h2>${esc(titulo)}</h2>
        </div>
      </div>
      ${cuerpo}
    </section>`;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisión de sitio web — ${esc(host)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{
  --violet:#5b3fd6;--violet-50:#f3f0fd;--violet-100:#e5dffa;
  --good:#0f7d5b;--good-50:#eafaf3;--bad:#b03030;--bad-50:#fdeeee;--mid:#8a6a12;--mid-50:#fbf3e0;
  --ink:#0b0d12;--ink-700:#2a313d;--ink-600:#3d4653;--ink-500:#5a6472;--ink-400:#7b8492;
  --ink-200:#c8ccd4;--ink-100:#e6e9ee;--ink-50:#f5f6f9;--paper:#ffffff;
  --fd:"Fraunces",Georgia,serif;--fb:"Manrope",Arial,sans-serif;--fm:"JetBrains Mono",monospace}
*{box-sizing:border-box}
@page{size:A4;margin:15mm 13mm}
body{font-family:var(--fb);color:var(--ink-700);background:var(--paper);margin:0;padding:0 22px 44px;font-size:14px;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:820px;margin:0 auto}

header{padding:40px 0 20px;margin-bottom:8px;border-bottom:1px solid var(--ink-200)}
.brand{font-family:var(--fm);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-400);margin-bottom:16px}
h1{font-family:var(--fd);font-size:40px;font-weight:700;line-height:1.02;letter-spacing:-.02em;color:var(--ink);margin:0 0 8px;text-wrap:balance}
.sub{font-size:13.5px;color:var(--ink-500);margin:0}

.lede{background:var(--violet-50);border-radius:12px;padding:22px 24px;margin:26px 0 34px;break-inside:avoid}
.lede h2{font-family:var(--fd);font-size:22px;font-weight:600;line-height:1.25;margin:0 0 10px;color:var(--ink);text-wrap:balance}
.lede p{margin:0;font-size:14px;color:var(--ink-600)}

.sec{margin-bottom:36px}
.sec-head{display:flex;gap:16px;align-items:flex-start;margin-bottom:18px;break-after:avoid;page-break-after:avoid}
.sec-n{font-family:var(--fd);font-size:34px;font-weight:600;font-style:italic;color:var(--violet);line-height:.9;min-width:46px}
.eyebrow{font-family:var(--fm);font-size:9.5px;letter-spacing:.17em;text-transform:uppercase;color:var(--ink-400);margin-bottom:4px}
.sec h2{font-family:var(--fd);font-size:25px;font-weight:700;line-height:1.12;letter-spacing:-.015em;color:var(--ink);margin:0;text-wrap:balance}

.signals{display:flex;flex-direction:column;gap:10px}
.signal{border:1px solid var(--ink-100);border-radius:10px;padding:15px 17px;break-inside:avoid;page-break-inside:avoid}
.signal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.signal h3{font-family:var(--fb);font-size:15px;font-weight:700;color:var(--ink);margin:0}
.signal p{margin:0;font-size:13px;color:var(--ink-600)}
.chip{font-family:var(--fm);font-size:9px;letter-spacing:.08em;padding:4px 9px;border-radius:4px;font-weight:500;white-space:nowrap}
.chip-good{background:var(--good-50);color:var(--good)}
.chip-mid{background:var(--mid-50);color:var(--mid)}
.chip-bad{background:var(--bad-50);color:var(--bad)}
.chip-unknown{background:var(--ink-50);color:var(--ink-500)}

.panels{display:flex;flex-direction:column;gap:14px}
.panel{border-radius:11px;padding:18px 20px;break-inside:avoid;page-break-inside:avoid}
.panel-good{background:var(--good-50)}
.panel-bad{background:var(--bad-50)}
.panel h3{font-family:var(--fb);font-size:14.5px;font-weight:800;margin:0 0 11px}
.panel-good h3{color:var(--good)}
.panel-bad h3{color:var(--bad)}
.panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.panel li{display:flex;gap:10px;font-size:13px;color:var(--ink-600);line-height:1.5}
.mark{flex:none;font-weight:800;line-height:1.4}
.panel-good .mark{color:var(--good)}
.panel-bad .mark{color:var(--bad)}

.qs{display:flex;flex-direction:column;gap:9px}
.q{border-left:3px solid var(--violet);background:var(--violet-50);border-radius:0 8px 8px 0;padding:12px 16px;break-inside:avoid}
.q p{margin:0;font-family:var(--fd);font-style:italic;font-size:14.5px;color:var(--ink);line-height:1.4}

.fixes{display:flex;flex-direction:column;gap:0}
.fix{display:flex;gap:16px;padding:18px 0;border-top:1px solid var(--ink-100);break-inside:avoid;page-break-inside:avoid}
.fix:first-child{border-top:none;padding-top:4px}
.fix-n{font-family:var(--fm);font-size:11px;color:var(--violet);min-width:26px;padding-top:3px}
.fix-b h3{font-family:var(--fb);font-size:15.5px;font-weight:800;color:var(--ink);margin:0 0 7px;line-height:1.3}
.fix-b p{margin:0 0 6px;font-size:13px;color:var(--ink-600)}
.fix-b p.why{margin:0;font-size:12.5px;color:var(--ink-500)}

.next{background:var(--ink);border-radius:12px;padding:26px 28px;color:#e9ecf2;break-inside:avoid;page-break-inside:avoid}
.next .eyebrow{color:#8b95a6;margin-bottom:8px}
.next h2{font-family:var(--fd);font-size:24px;font-weight:700;color:#fff;margin:0 0 12px;line-height:1.15;text-wrap:balance}
.next p{margin:0 0 9px;font-size:13.5px;color:#c3cad6}
.next p:last-child{margin:0}

footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--ink-200);display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;font-family:var(--fm);font-size:9.5px;letter-spacing:.05em;color:var(--ink-400)}

@media print{
  body{padding:0;font-size:10.5pt}
  .wrap{max-width:none}
  h1{font-size:27pt}
  .sec{margin-bottom:26px}
  /* The large italic numeral has a tall em box, so a section landing flush at a page top sits
     closer to the paper edge than the margin suggests. A few millimetres of clearance costs
     nothing on a three-page document and removes the question entirely. */
  .sec-head{padding-top:4mm}
  .next{background:var(--ink)!important}
  p,li{orphans:3;widows:3}
}
@media(max-width:560px){
  .sec-head{gap:12px}.sec-n{font-size:27px;min-width:34px}
  h1{font-size:31px}.sec h2{font-size:21px}
}
</style></head><body><div class="wrap">

<header>
  <div class="brand">Akore Labs · Revisión de sitio web</div>
  <h1>${esc(host)}</h1>
  <p class="sub">Qué tan preparado está el sitio web para que la inteligencia artificial lo encuentre, lo lea y lo cite · ${esc(fecha)}</p>
</header>

<div class="lede">
  <h2>${esc(titular)}</h2>
  <p>${esc(resumen)}</p>
  ${data.scanQuality?.source === 'supplied-html' ? '<p style="margin-top:10px;font-size:12.5px;color:var(--ink-500);">' + esc('Este análisis se hizo sobre el código de la página, guardado a mano, porque el servidor no acepta peticiones automáticas. Por eso no se puede decir aquí si la IA logra entrar al sitio web: eso se revisa aparte.') + '</p>' : ''}
</div>

${seccion('01', 'Lo que revisamos', 'Qué puede hacer la IA con este sitio web hoy', `
  <div class="signals">
    ${señal('¿Puede entrar?', acceso, 'Si los sistemas de IA logran llegar al sitio web y leerlo sin que nada los detenga.')}
    ${señal('¿Puede entenderlo?', lectura, 'Si distingue de qué trata cada página y dónde está el contenido que importa.')}
    ${señal('¿Puede citarlo?', cita, 'Si encuentra información concreta que valga la pena usar como respuesta.')}
  </div>`)}

${seccion('02', 'La lectura', 'Qué ayuda y qué se está perdiendo', `
  <div class="panels">
    ${bueno.length ? `<div class="panel panel-good">
      <h3>Esto ya funciona</h3>
      <ul>${bueno.map(b => `<li><span class="mark">✓</span><span>${esc(b.txt)}</span></li>`).join('')}</ul>
    </div>` : ''}
    ${problemas.length ? `<div class="panel panel-bad">
      <h3>Esto lo está limitando</h3>
      <ul>${problemas.slice(0, 5).map(p => `<li><span class="mark">—</span><span>${esc(p.titulo)}</span></li>`).join('')}</ul>
    </div>` : ''}
  </div>`)}

${qs.length ? seccion('03', 'Las preguntas', 'Lo que el sitio web ya contesta', `
  <p style="margin:0 0 14px;font-size:13px;color:var(--ink-500);">Estas preguntas ya están en el sitio web con su respuesta. Son las que la IA puede usar tal cual.</p>
  <div class="qs">${qs.map(q => `<div class="q"><p>«${esc(q)}»</p></div>`).join('')}</div>`) : ''}

${problemas.length ? seccion(qs.length ? '04' : '03', 'El plan', 'Qué conviene corregir primero', `
  <div class="fixes">
    ${problemas.map((p, i) => `
    <div class="fix">
      <div class="fix-n">${String(i + 1).padStart(2, '0')}</div>
      <div class="fix-b">
        <h3>${esc(p.titulo)}</h3>
        <p>${esc(p.que)}</p>
        <p class="why">${esc(p.porque)}</p>
      </div>
    </div>`).join('')}
  </div>`) : ''}

<div class="next">
  <div class="eyebrow">Qué sigue</div>
  <h2>Esto es la base. Falta saber si hoy te están nombrando.</h2>
  <p>Esta revisión ve únicamente lo que pasa dentro del sitio web: si la IA puede entrar, entenderlo y citarlo. Conviene resolverlo antes de medir cualquier otra cosa.</p>
  <p>Lo que no mide: si hoy apareces en las respuestas de ChatGPT, Gemini o Perplexity cuando alguien pregunta por tu servicio, ni cómo te comparas con tu competencia. Eso se mide aparte, y solo tiene sentido una vez resuelto lo de arriba.</p>
</div>

<footer>
  <span>Akore Labs</span>
  <span>${esc(host)} · ${esc(fecha)}</span>
</footer>
</div></body></html>`;
}
