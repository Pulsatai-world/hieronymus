#!/usr/bin/env node
/**
 * A demo customer with a diagnostic snapshot and a monitoring trend behind it.
 *
 * For showing the platform to someone without running a real audit: no engine calls, no API spend,
 * nothing waiting on a background function. It drives the same HTTP API the app does — create the
 * customer, save an intake, save a prompt set, write result rows, release both dashboards — so the
 * dashboards render it exactly as they render a real customer, because the storage path is the
 * same one. Nothing here is a special case the product has to know about.
 *
 * Re-running it resets the demo: the customer's existing rows are cleared first, so the data never
 * doubles up and the story always reads the same way.
 *
 *   node scripts/seed-demo-customer.mjs                                   # local netlify dev
 *   node scripts/seed-demo-customer.mjs --base https://app.akore.com.mx --session <token>
 *   node scripts/seed-demo-customer.mjs --base https://… --username you --password … --code 123456
 *
 * The session has to belong to a staff admin: writing result rows and releasing a dashboard are
 * both staff-only, which is the point.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = (arg('base', 'http://localhost:8888')).replace(/\/$/, '');
const DRY = argv.includes('--dry-run');

// ── The demo itself ───────────────────────────────────────────────────────────────────────────
//
// Obviously invented, deliberately: a demo that could be mistaken for a real customer's data is a
// demo that ends up quoted back at you. The competitors are invented for the same reason — a
// leaderboard is a ranking, and ranking real companies from made-up numbers is not something to
// put on a screen in front of anyone.
const COMPANY = 'Demo Industrial';
const COMPETITORS = ['Hidráulica Vertex', 'Grupo Meridian', 'Industrias Calder', 'Bomba Norte', 'Selmec Pro'];
const ENGINES = ['claude', 'chatgpt', 'gemini'];

// Five categories, the same ones the generator produces (CAT1…CAT5), so the prompt list and the
// dashboard's "type of question" filter look like a real set.
const PROMPTS = [
  ['CAT1', 'brand',      '¿Qué opiniones hay de Demo Industrial? ¿Alguien les ha comprado refacciones hidráulicas?'],
  ['CAT1', 'brand',      '¿Demo Industrial repara bombas de pistón o sólo vende refacciones?'],
  ['CAT1', 'brand',      'Is Demo Industrial a reliable supplier for hydraulic cylinders?'],
  ['CAT2', 'category',   '¿Cuáles son los mejores proveedores de sistemas hidráulicos industriales en México?'],
  ['CAT2', 'category',   '¿Quién distribuye bombas hidráulicas de alta presión en el Bajío?'],
  ['CAT2', 'category',   'Best industrial hydraulics suppliers for manufacturing plants',
  ],
  ['CAT3', 'problem',    'Mi prensa hidráulica perdió presión de un día para otro, ¿quién puede diagnosticarla?'],
  ['CAT3', 'problem',    'Tengo un cilindro de 6 pulgadas tirando aceite por los sellos, ¿quién hace rectificación?'],
  ['CAT3', 'problem',    'Hydraulic pump overheating after 2 hours of operation — who can service it?'],
  ['CAT4', 'competitor', '¿Demo Industrial o Hidráulica Vertex para mantenimiento de prensas?'],
  ['CAT4', 'competitor', 'Comparación entre proveedores de hidráulica industrial en el centro de México'],
  ['CAT5', 'persona',    'Soy gerente de mantenimiento y busco un proveedor de hidráulica con servicio en sitio'],
];

// The story: a weak baseline, then steady improvement over six months. Each entry is the share of
// answers that cite the brand, and the rank it tends to land at when it is cited. The diagnostic
// is the first row; the rest are monitoring snapshots.
const TIMELINE = [
  { date: '2026-05-04', type: 'diagnostic', citeRate: 0.17, rank: 4.4, leadRate: 0.04 },
  { date: '2026-06-01', type: 'monitoring', citeRate: 0.24, rank: 4.1, leadRate: 0.06 },
  { date: '2026-07-01', type: 'monitoring', citeRate: 0.33, rank: 3.6, leadRate: 0.10 },
  { date: '2026-08-03', type: 'monitoring', citeRate: 0.41, rank: 3.1, leadRate: 0.16 },
  { date: '2026-09-01', type: 'monitoring', citeRate: 0.52, rank: 2.7, leadRate: 0.23 },
  { date: '2026-10-01', type: 'monitoring', citeRate: 0.61, rank: 2.3, leadRate: 0.31 },
  { date: '2026-11-02', type: 'monitoring', citeRate: 0.68, rank: 1.9, leadRate: 0.38 },
];

// Deterministic, so two runs produce the same demo and a screenshot stays true.
let seed = 20260511;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];

function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function buildRows() {
  const rows = [];
  for (const snap of TIMELINE) {
    // Exactly this many answers cite the brand, rather than each one rolling the dice. With 36
    // answers in a snapshot a probability lands anywhere — the first draft dipped in September
    // and flattened in November, which is not the story this is meant to tell. Which answers
    // cite it still varies from month to month; how many does not.
    const slots = PROMPTS.length * ENGINES.length;
    const target = Math.round(snap.citeRate * slots);
    const order = Array.from({ length: slots }, (_, i) => i).sort(() => rnd() - 0.5);
    const citedSlots = new Set(order.slice(0, target));
    let slot = -1;

    for (let i = 0; i < PROMPTS.length; i++) {
      const [cat, intent, text] = PROMPTS[i];
      const promptId = 'Q' + String(i + 1).padStart(2, '0');
      for (const engine of ENGINES) {
        slot++;
        const cited = citedSlots.has(slot);
        // Rank wanders a little around the month's average so the trend is a trend, not a staircase.
        const rank = cited ? Math.max(1, Math.round(snap.rank + (rnd() - 0.5) * 1.6)) : '';
        const leads = cited && rnd() < snap.leadRate;
        // Two or three competitors in each answer, plus the brand when it was cited.
        const others = COMPETITORS.slice().sort(() => rnd() - 0.5).slice(0, 2 + Math.round(rnd()));
        const list = cited ? (leads ? [COMPANY, ...others] : [others[0], COMPANY, ...others.slice(1)]) : others;
        rows.push({
          run_id: hashId(`${COMPANY}|${snap.date}|${promptId}|${engine}`),
          run_type: snap.type,
          snapshot_date: snap.date,
          engine,
          prompt_id: promptId,
          prompt_text: text,
          query_intent: intent,
          topic_cluster: cat,
          brand: COMPANY,
          brand_mentioned: cited || rnd() < 0.12 ? 1 : 0,
          brand_cited: cited ? 1 : 0,
          brand_citation_rank: rank,
          total_brands_cited: list.length,
          brands_cited_list: list.join(';'),
          top_cited_brand: list[0],
          brand_is_leader: leads ? 1 : 0,
          linked_to_site: cited && rnd() < 0.5 ? 1 : 0,
          sentiment: cited ? (rnd() < 0.82 ? 'positive' : 'neutral') : 'neutral',
          claims_about_brand: cited ? 1 + Math.round(rnd() * 3) : 0,
          incorrect_claims: 0,
          has_incorrect_claim: 0,
          services_correct: cited ? 1 : '',
          location_correct: cited ? 1 : '',
          contact_correct: '',
          ai_sessions: 0, ai_conversions: 0, ai_pipeline_usd: 0,
          answer_excerpt: `(demo) ${list.slice(0, 3).join(', ')}…`,
          written_at: new Date(snap.date + 'T12:00:00Z').toISOString()
        });
      }
    }
  }
  return rows;
}

// ── Talking to the app ────────────────────────────────────────────────────────────────────────
let SESSION = arg('session', '');

async function call(method, p, { body, query } = {}) {
  const url = new URL(BASE + p);
  if (SESSION) url.searchParams.set('session', SESSION);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const opt = { method };
  if (body) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(SESSION ? { ...body, session: SESSION } : body);
  }
  // Retried on 5xx and on a dropped connection. Writing a row drops the derived CSV cache, so a
  // read landing while that rebuilds can take long enough for a proxy in front of the function to
  // give up — the function itself is fine, and the next attempt hits a warm cache. A seed script
  // that reported those as failures would be crying wolf about its own load.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, opt);
      const text = await r.text();
      if (r.status >= 500 && attempt < 4) { await new Promise(x => setTimeout(x, 800 * (attempt + 1))); continue; }
      // `data` is trimmed because it only ever gets logged. `text` is not: /api/results answers
      // with a CSV, and counting its rows from a 200-character excerpt reports every seed as
      // empty — which it did, convincingly, until this line.
      let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
      return { status: r.status, data, text };
    } catch (e) {
      if (attempt === 4) return { status: 'ERR', data: e.message };
      await new Promise(x => setTimeout(x, 800 * (attempt + 1)));
    }
  }
}

async function signIn() {
  if (SESSION) return;
  const username = arg('username'), password = arg('password'), code = arg('code');
  if (!username || !password) {
    console.error('Need either --session <token>, or --username --password --code for a staff admin.');
    process.exit(1);
  }
  const r = await call('POST', '/api/login', { body: { username, password, code } });
  if (!r.data || !r.data.session) {
    console.error('Sign-in failed:', JSON.stringify(r.data).slice(0, 200));
    process.exit(1);
  }
  SESSION = r.data.session;
}

const INTAKE = {
  company: COMPANY,
  website: 'https://demo-industrial.example',
  industry: 'Hidráulica industrial / refacciones y servicio',
  contact: 'Demo Contact', role: 'Gerente de Mantenimiento',
  email: 'demo@demo-industrial.example',
  language: 'both',
  competitors: COMPETITORS.join(', '),
  services: 'Venta de refacciones hidráulicas, rectificación de cilindros, servicio en sitio.',
  locations: 'Querétaro, Guanajuato, Estado de México',
  personas: 'Gerentes de mantenimiento, compradores industriales, jefes de planta.'
};

async function main() {
  console.log(`Demo customer "${COMPANY}" → ${BASE}\n`);
  const rows = buildRows();
  if (DRY) {
    const byDate = {};
    rows.forEach(r => { byDate[r.snapshot_date] = (byDate[r.snapshot_date] || 0) + 1; });
    console.log(`${rows.length} rows across ${TIMELINE.length} snapshots:`);
    for (const s of TIMELINE) {
      const cited = rows.filter(r => r.snapshot_date === s.date && r.brand_cited === 1).length;
      const all = byDate[s.date];
      console.log(`  ${s.date}  ${s.type.padEnd(11)} ${String(all).padStart(3)} rows  cited ${String(Math.round(100 * cited / all)).padStart(3)}%`);
    }
    return;
  }

  await signIn();

  // 1. The customer. Already there is fine — this is a reset, not a first run.
  let created = await call('POST', '/api/intake-codes', { body: { company: COMPANY } });
  let credentials = null;
  if (created.status === 200) {
    credentials = created.data;
    console.log(`✓ created        ${credentials.username} / ${credentials.password}`);
    console.log('  ↑ the password is shown once; save it now if you want to log in as the client.');
  } else if (created.status === 409) {
    console.log('• customer already exists — resetting its data');
  } else {
    console.error('✗ could not create:', created.status, JSON.stringify(created.data).slice(0, 160));
    process.exit(1);
  }

  // The generated password is shown once and then hashed, so a second run has no way to tell you
  // what it is. For a demo account that is just friction: set a known one every time, so the
  // login on the last line of this output is always true.
  const clientPassword = arg('client-password', 'DemoIndustrial-2026');
  const slugName = COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const pw = await call('PATCH', '/api/intake-codes', {
    body: { username: slugName, adminReset: true, newPassword: clientPassword } });
  console.log(`${pw.status === 200 ? '✓' : '✗'} client password set (${pw.status})`);

  // 2. Intake and prompts, so the customer page and the Prompts screen are not blank.
  const intake = await call('POST', '/api/intake', { body: { company: COMPANY, intake: INTAKE } });
  // Saving the answers is not the same as the form being submitted: `submittedAt` lives on the
  // customer record and is set by markSubmitted, and without it the client portal greets the
  // demo with "finish your form" above a finished dashboard.
  // Keyed by the member's username, not the company — that branch resolves a member first.
  const marked = await call('PATCH', '/api/intake-codes', { body: { username: slugName, markSubmitted: true } });
  console.log(`${intake.status === 200 && marked.status === 200 ? '✓' : '✗'} intake saved    ${intake.status}/${marked.status} (saved/submitted)`);
  const promptsText = PROMPTS.map(([cat, , text]) => `${cat}: ${text}`).join('\n');
  const prompts = await call('POST', '/api/prompts', {
    body: { company: COMPANY, promptsText, languages: ['Spanish', 'English'] } });
  console.log(`${prompts.status === 200 ? '✓' : '✗'} prompts saved   ${prompts.status} (${PROMPTS.length} prompts)`);
  // Released to the customer, then approved on their behalf — a demo that opens with "there are
  // prompts waiting for your review" above six months of finished measurements is telling two
  // stories at once. Staff approving for a customer is a path the server already allows.
  await call('PATCH', '/api/prompts', { body: { company: COMPANY, internalApprove: true, promptsText } });
  const approved = await call('PATCH', '/api/prompts', { body: { company: COMPANY, comments: 'Aprobado (demo)' } });
  console.log(`${approved.status === 200 ? '✓' : '✗'} prompts approved ${approved.status}`);

  // 3. Clear whatever is there, then write the demo set. Re-running must not double the data.
  const wipe = await call('DELETE', '/api/results', { query: { company: COMPANY } });
  console.log(`✓ cleared old    ${wipe.status}`);

  let done = 0, failed = 0;
  for (const row of rows) {
    const r = await call('POST', '/api/results', { body: row });
    if (r.status === 200) done++; else { failed++; if (failed < 3) console.error('   row failed:', r.status, JSON.stringify(r.data).slice(0, 120)); }
    if (done % 50 === 0 && done) process.stdout.write(`\r  rows ${done}/${rows.length}`);
  }
  process.stdout.write(`\r✓ rows written   ${done}/${rows.length}${failed ? ` (${failed} failed)` : ''}\n`);

  // 4. Both dashboards visible to the client, and monitoring ON with a schedule.
  //
  //    Off would be the cautious choice, but the monitoring dashboard then says "Monitoring off"
  //    to everyone — the client too, not just staff — which is a poor thing to have on screen
  //    while showing someone the monitoring product. On is safe here: the daily cron will try a
  //    real audit when the schedule comes due, and this customer has no Claude key, so
  //    run-audit-background refuses before it calls anything and before it clears any rows. The
  //    cost is an error badge on the staff page, weeks from now, cleared by re-running this.
  const startDate = TIMELINE[TIMELINE.length - 1].date;
  const rel = await call('PATCH', '/api/intake-codes', {
    body: { company: COMPANY, diagnosisReleased: true, monitoringReleased: true,
            monitoringEnabled: true, monitoringCadence: 'monthly', monitoringStartDate: startDate } });
  console.log(`${rel.status === 200 ? '✓' : '✗'} dashboards released, monitoring monthly from ${startDate} (${rel.status})`);

  // Warm the derived CSV before anyone opens a dashboard. Every row write drops that cache, so
  // the first read after a seed pays for the whole rebuild — and on a slow link that first read
  // is a person watching a dashboard say it has no data. Better this script waits than they do.
  //
  // It reads until the rows actually come back, rather than once. A listing taken immediately
  // after a few hundred writes can come back short, and a rebuild from a short listing produces
  // a short CSV. It self-heals — a rebuild that finds nothing for a company writes no entry, so
  // the next read misses and rebuilds again — but "self-heals on the next read" is no good if
  // the next read is a person opening a dashboard.
  let warmRows = 0, warmStatus = 0;
  for (let i = 0; i < 6; i++) {
    const warm = await call('GET', '/api/results', { query: { company: COMPANY } });
    warmStatus = warm.status;
    warmRows = Math.max(0, (warm.text || '').split('\n').filter(Boolean).length - 1);
    if (warmRows >= rows.length) break;
    await new Promise(x => setTimeout(x, 1500));
  }
  console.log(`${warmRows >= rows.length ? '✓' : '!'} cache warmed   ${warmStatus} (${warmRows}/${rows.length} rows readable)`);
  if (warmRows < rows.length) {
    console.log('  ! the dashboards may read short on the first open; load one and reload once.');
  }

  const slug = COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  console.log('\nOpen it:');
  console.log(`  staff view    ${BASE}/index.html?company=${encodeURIComponent(COMPANY)}`);
  console.log(`  diagnostic    ${BASE}/dashboard-diagnostic.html?company=${encodeURIComponent(COMPANY)}`);
  console.log(`  monitoring    ${BASE}/dashboard-monitoring.html?company=${encodeURIComponent(COMPANY)}`);
  console.log(`  client portal ${BASE}/client-portal.html?username=${slug}`);
  console.log(`\n  client login  ${slug} / ${clientPassword}`);
  console.log('  note          a customer enrols an authenticator on first sign-in, so logging in as');
  console.log('                the client needs a phone once. To show the client view without that,');
  console.log('                open the client portal link above while signed in as staff.');
}

main().catch(e => { console.error(e); process.exit(1); });
