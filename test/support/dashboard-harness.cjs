/* Renders a dashboard page the way a browser would, against a fixed dataset, and hands back the
 * DOM of each region it draws.
 *
 * This exists for the modularisation work: both dashboards are being taken apart into an engine
 * plus a library of blocks, and the only acceptable outcome of that refactor is that every
 * customer keeps seeing exactly what they see now. A structural change is safe when the DOM it
 * produces is byte-identical to the snapshot taken before the change, and unsafe otherwise.
 *
 * Everything here is deterministic on purpose: the dataset is generated from a fixed sequence,
 * and the clock is frozen, so a diff always means the renderer changed.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

const CSV_COLUMNS = [
  'run_id', 'run_type', 'snapshot_date', 'engine', 'prompt_id', 'prompt_text', 'query_intent', 'topic_cluster',
  'brand', 'brand_mentioned', 'brand_cited', 'brand_citation_rank', 'total_brands_cited',
  'brands_cited_list', 'top_cited_brand', 'brand_is_leader', 'linked_to_site', 'sentiment',
  'claims_about_brand', 'incorrect_claims', 'has_incorrect_claim', 'services_correct',
  'location_correct', 'contact_correct', 'ai_sessions', 'ai_conversions', 'ai_pipeline_usd',
  'answer_excerpt'
];

// Wide enough to exercise the parts that have broken before: the top-25 leaderboard cut, spelling
// variants that must canonicalise together, the client landing below the cut, several snapshot
// dates so the monitoring trends have something to plot, both languages, and error rows.
const RIVALS = [
  'Parker', 'Parker Hannifin', 'Parker Hannifin México', 'Bosch', 'Bosch Rexroth',
  'Bosch Rexroth S.A. de C.V.', 'SKF', 'SKF México', 'Festo', 'SMC', 'Norgren', 'Danfoss',
  'Eaton', 'Rexnord', 'Timken', 'NSK', 'Schaeffler', 'INA', 'FAG', 'Gates', 'Continental',
  'Dayco', 'Optibelt', 'Megadyne', 'Habasit', 'Ammeraal', 'Forbo', 'Siegling', 'Nitta', 'Sampla'
];
const ENGINES = ['claude', 'chatgpt', 'gemini'];
const CLUSTERS = ['Brand', 'Category', 'Problem', 'Competitor', 'Persona'];
const INTENTS = ['informational', 'commercial', 'navigational'];
const DATES = ['2026-01-15', '2026-02-15', '2026-03-15'];

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* A deterministic dataset. `runType` is 'diagnostic' (one snapshot) or 'monitoring' (three);
 * `brand` is the customer the rows belong to, which has to match the company the page is opened
 * for or the dashboard correctly decides it has no data. */
function buildCsv(runType, brand) {
  brand = brand || 'Fiacsa';
  const dates = runType === 'monitoring' ? DATES : [DATES[0]];
  const lines = [CSV_COLUMNS.join(',')];
  let n = 0;
  for (const date of dates) {
    for (let i = 0; i < 90; i++, n++) {
      const cited = [];
      for (let j = 0; j <= (i % 12); j++) cited.push(RIVALS[(i * 7 + j * 3) % RIVALS.length]);
      const clientCited = i % 9 === 0;
      if (clientCited) cited.push(brand);
      const cluster = CLUSTERS[i % CLUSTERS.length];
      const isError = i % 37 === 0;
      const row = {
        run_id: 'run-' + date,
        run_type: runType,
        snapshot_date: date,
        engine: ENGINES[i % ENGINES.length],
        prompt_id: 'Q' + String((i % 20) + 1).padStart(2, '0'),
        // Some prompts deliberately name the company: the leaderboard must exclude those.
        prompt_text: (i % 15 === 0 ? 'is ' + brand + ' better than Parker for ' : 'where do I buy ')
          + 'hydraulic seals in Toluca ' + (i % 20),
        query_intent: INTENTS[i % INTENTS.length],
        topic_cluster: cluster,
        brand: brand,
        brand_mentioned: i % 3 === 0 ? 1 : 0,
        brand_cited: clientCited ? 1 : 0,
        brand_citation_rank: clientCited ? (i % 4) + 1 : '',
        total_brands_cited: cited.length,
        brands_cited_list: cited.join(';'),
        top_cited_brand: cited[0],
        brand_is_leader: i % 18 === 0 ? 1 : 0,
        linked_to_site: i % 5 === 0 ? 1 : 0,
        sentiment: isError ? 'error' : ['positive', 'neutral', 'negative'][i % 3],
        claims_about_brand: i % 4,
        incorrect_claims: i % 11 === 0 ? 'claims a location it does not have' : '',
        has_incorrect_claim: i % 11 === 0 ? 1 : 0,
        services_correct: i % 7 === 0 ? 0 : 1,
        location_correct: 1,
        contact_correct: i % 13 === 0 ? 0 : 1,
        ai_sessions: 0, ai_conversions: 0, ai_pipeline_usd: 0,
        answer_excerpt: isError ? 'ERROR (answer) upstream timeout' : 'Answer excerpt number ' + n
      };
      lines.push(CSV_COLUMNS.map(c => csvEscape(row[c])).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

/* jsdom does not fetch <script src>, so inline them exactly as the browser would run them. A src
 * that cannot be resolved is an error, not something to paper over: silently dropping a script is
 * how a page passes its tests while being broken in a browser. */
function resolveAsset(src, specRoot) {
  // /specs/... can be redirected to a fixture tree so a test can exercise a customer spec without
  // shipping one. Everything else resolves from the repo, as the browser would serve it.
  if (specRoot && src.startsWith('/specs/')) return path.join(specRoot, src.slice('/specs/'.length));
  return path.join(ROOT, src.replace(/^\//, ''));
}

function inlineScripts(file, specRoot) {
  const missing = [];
  const html = fs.readFileSync(file, 'utf8').replace(
    /<script src="([^"]+)"><\/script>/g,
    (m, src) => {
      const p = resolveAsset(src, specRoot);
      if (!fs.existsSync(p)) { missing.push(src); return ''; }
      return '<script>' + fs.readFileSync(p, 'utf8') + '</script>';
    });
  return { html, missing };
}

/* Scripts the page injects at runtime — a customer's spec module — are fetched rather than
 * inlined, so these serve them from disk at the same URL a browser would request. A file that is
 * not there answers 404, which is what the page must treat as "this customer has no spec". */
function localFileResources(specRoot) {
  return {
    interceptors: [requestInterceptor(request => {
      let u;
      try { u = new URL(request.url); } catch (e) { return new Response('', { status: 404 }); }
      // Every request is answered here, so a test never reaches the network. The pages link a
      // Google Fonts stylesheet; served empty, since jsdom applies no CSS anyway and a failed
      // fetch would otherwise show up as a page error.
      if (u.hostname !== 't.local') {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } });
      }
      const p = resolveAsset(u.pathname, specRoot);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        return new Response('not found', { status: 404 });
      }
      const type = p.endsWith('.css') ? 'text/css' : 'text/javascript';
      return new Response(fs.readFileSync(p, 'utf8'), { headers: { 'Content-Type': type } });
    })]
  };
}

const FROZEN_NOW = Date.UTC(2026, 2, 20, 12, 0, 0);

// Regions each page draws into. Missing ids are skipped, so the same list serves both pages.
const REGIONS = ['stats', 'count', 'wrap', 'cwrap', 'pwrap', 'foot', 'lastwk', 'lastwk2', 'schedule-block'];

async function renderDashboard(page, opts = {}) {
  const company = opts.company || 'Fiacsa';
  const runType = page.includes('monitoring') ? 'monitoring' : 'diagnostic';
  const csv = opts.csv !== undefined ? opts.csv : buildCsv(runType, company);
  const errors = [];

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const first = e.message.split('\n')[0];
    if (/Not implemented: navigation/.test(first)) return;
    errors.push(first);
  });

  const specRoot = opts.specRoot || null;
  const { html, missing } = inlineScripts(path.join(ROOT, page), specRoot);
  missing.forEach(s => errors.push('unresolved <script src>: ' + s));

  const warnings = [];
  const dom = new JSDOM(html, {
    url: 'https://t.local/' + page + '?company=' + encodeURIComponent(company) + '&username=demo',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: localFileResources(specRoot),
    beforeParse(w) {
      w.alert = () => {};
      w.confirm = () => false;
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}
      }));

      // jsdom has no ResizeObserver, and the monitoring trend charts construct one. They also call
      // their own render() directly, so a stub that never fires is exactly "the container was never
      // resized" — the charts still draw, at the 220px floor they fall back to when clientWidth is
      // 0. Firing the callback instead would re-render at a made-up width and make the snapshot a
      // record of jsdom's lack of layout rather than of the renderer.
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

      // A frozen clock, so "next run" style copy cannot make a snapshot drift by the day it ran.
      const RealDate = w.Date;
      class FrozenDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [FROZEN_NOW])); }
        static now() { return FROZEN_NOW; }
      }
      w.Date = FrozenDate;

      w.fetch = async (u) => {
        const s = String(u);
        const isResults = /\/api\/results/.test(s);
        const body =
          /\/api\/login/.test(s) ? { username: 'akore-local', kind: 'staff', role: 'admin', company: '' } :
          /\/api\/intake-codes/.test(s) ? {
            company, username: 'fiacsa', monitoringEnabled: true,
            nextRunAt: '2026-04-01T00:00:00Z', diagnosisReleased: true, monitoringReleased: true
          } : {};
        const text = isResults ? csv : JSON.stringify(body);
        return {
          ok: true, status: 200,
          json: async () => JSON.parse(isResults ? '{}' : text),
          text: async () => text,
          headers: { get: () => (isResults ? 'text/csv' : 'application/json') }
        };
      };

      // Most startup work happens inside promises, where a rejection is silent rather than an error.
      w.addEventListener('unhandledrejection', ev => {
        const r = ev && ev.reason;
        errors.push('unhandled rejection: ' + ((r && r.message) || r));
      });
      w.addEventListener('error', ev => { if (ev && ev.message) errors.push(ev.message); });
      const realWarn = w.console.warn.bind(w.console);
      w.console.warn = (...a) => { warnings.push(a.join(' ')); realWarn(...a); };
      try { w.localStorage.setItem('akore_staff_session', 'test-session'); } catch (e) {}
      // Pin the language so a stored preference cannot change what is captured.
      try { w.localStorage.setItem('hieronymus_lang', opts.lang || 'en'); } catch (e) {}
    }
  });

  await new Promise(r => setTimeout(r, opts.settleMs || 900));

  const d = dom.window.document;
  const regions = {};
  for (const id of REGIONS) {
    const el = d.getElementById(id);
    if (el) regions[id] = el.innerHTML;
  }
  // The tab strip is markup today and becomes spec-driven later, so it is part of the contract.
  const tabs = [...d.querySelectorAll('.tabs .tab')]
    .map(b => b.dataset.panel + ':' + b.textContent.trim()).join(' | ');

  const out = { regions, tabs, errors, warnings, window: dom.window };
  if (!opts.keepWindow) { dom.window.close(); delete out.window; }
  return out;
}

/* One stable string per page, used as the golden snapshot. */
function serialize(result) {
  const parts = ['<!-- tabs -->', result.tabs];
  for (const id of Object.keys(result.regions).sort()) {
    parts.push('<!-- region:' + id + ' -->', result.regions[id]);
  }
  return parts.join('\n') + '\n';
}

module.exports = { buildCsv, renderDashboard, serialize, CSV_COLUMNS, REGIONS, ROOT };
