/* The demo customer: what it contains, and the order it has to be built in.
 *
 * One definition, two callers — the button in the staff console and scripts/seed-demo-customer.mjs
 * — because the alternative is the same demo described twice and drifting. Only the transport
 * differs between them, so the transport is injected: `call(method, path, { body, query })`
 * resolving to `{ status, data, text }`. Everything else, including the order of operations and
 * the reasons for it, lives here.
 *
 * There are no engine calls. The rows are written straight to the results store through the same
 * staff-only endpoint a manual import uses, so the dashboards render the demo exactly as they
 * render a real customer — it is the real storage path, not a special case the product knows about.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AkoreDemoSeed = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Invented, deliberately — competitors included. A demo that could be mistaken for a customer's
  // real numbers is a demo that gets quoted back at you, and a leaderboard ranks whatever is in it.
  const COMPANY = 'Demo Industrial';
  const COMPETITORS = ['Hidráulica Vertex', 'Grupo Meridian', 'Industrias Calder', 'Bomba Norte', 'Selmec Pro'];
  const ENGINES = ['claude', 'chatgpt', 'gemini'];
  const SLUG = COMPANY.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const CLIENT_PASSWORD = 'DemoIndustrial-2026';

  // The five categories the generator produces, so the prompt list and the dashboard's
  // "type of question" filter look like a real set rather than one note repeated.
  const PROMPTS = [
    ['CAT1', 'brand',      '¿Qué opiniones hay de Demo Industrial? ¿Alguien les ha comprado refacciones hidráulicas?'],
    ['CAT1', 'brand',      '¿Demo Industrial repara bombas de pistón o sólo vende refacciones?'],
    ['CAT1', 'brand',      'Is Demo Industrial a reliable supplier for hydraulic cylinders?'],
    ['CAT2', 'category',   '¿Cuáles son los mejores proveedores de sistemas hidráulicos industriales en México?'],
    ['CAT2', 'category',   '¿Quién distribuye bombas hidráulicas de alta presión en el Bajío?'],
    ['CAT2', 'category',   'Best industrial hydraulics suppliers for manufacturing plants'],
    ['CAT3', 'problem',    'Mi prensa hidráulica perdió presión de un día para otro, ¿quién puede diagnosticarla?'],
    ['CAT3', 'problem',    'Tengo un cilindro de 6 pulgadas tirando aceite por los sellos, ¿quién hace rectificación?'],
    ['CAT3', 'problem',    'Hydraulic pump overheating after 2 hours of operation — who can service it?'],
    ['CAT4', 'competitor', '¿Demo Industrial o Hidráulica Vertex para mantenimiento de prensas?'],
    ['CAT4', 'competitor', 'Comparación entre proveedores de hidráulica industrial en el centro de México'],
    ['CAT5', 'persona',    'Soy gerente de mantenimiento y busco un proveedor de hidráulica con servicio en sitio']
  ];

  // A weak baseline, then six months of steady improvement: 17% of answers citing the brand at the
  // diagnostic, 68% by November, with the rank it lands at improving alongside.
  const TIMELINE = [
    { date: '2026-05-04', type: 'diagnostic', citeRate: 0.17, rank: 4.4, leadRate: 0.04 },
    { date: '2026-06-01', type: 'monitoring', citeRate: 0.24, rank: 4.1, leadRate: 0.06 },
    { date: '2026-07-01', type: 'monitoring', citeRate: 0.33, rank: 3.6, leadRate: 0.10 },
    { date: '2026-08-03', type: 'monitoring', citeRate: 0.41, rank: 3.1, leadRate: 0.16 },
    { date: '2026-09-01', type: 'monitoring', citeRate: 0.52, rank: 2.7, leadRate: 0.23 },
    { date: '2026-10-01', type: 'monitoring', citeRate: 0.61, rank: 2.3, leadRate: 0.31 },
    { date: '2026-11-02', type: 'monitoring', citeRate: 0.68, rank: 1.9, leadRate: 0.38 }
  ];

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

  // The same hash the audit uses, so a demo row sits on the key a real row would.
  function hashId(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function buildRows() {
    // Deterministic, so two runs produce the same demo and a screenshot stays true.
    let seed = 20260511;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const rows = [];
    for (const snap of TIMELINE) {
      // Exactly this many answers cite the brand, rather than each one rolling the dice. With 36
      // answers in a snapshot a probability lands anywhere — the first draft dipped in September
      // and flattened in November, which is not the story this is for. Which answers cite it
      // still varies month to month; how many does not.
      const slots = PROMPTS.length * ENGINES.length;
      const target = Math.round(snap.citeRate * slots);
      const order = Array.from({ length: slots }, (_, i) => i).sort(() => rnd() - 0.5);
      const cited = new Set(order.slice(0, target));
      let slot = -1;
      for (let i = 0; i < PROMPTS.length; i++) {
        const [cat, intent, text] = PROMPTS[i];
        const promptId = 'Q' + String(i + 1).padStart(2, '0');
        for (const engine of ENGINES) {
          slot++;
          const hit = cited.has(slot);
          const rank = hit ? Math.max(1, Math.round(snap.rank + (rnd() - 0.5) * 1.6)) : '';
          const leads = hit && rnd() < snap.leadRate;
          const others = COMPETITORS.slice().sort(() => rnd() - 0.5).slice(0, 2 + Math.round(rnd()));
          const list = hit ? (leads ? [COMPANY].concat(others)
                                    : [others[0], COMPANY].concat(others.slice(1))) : others;
          rows.push({
            run_id: hashId(COMPANY + '|' + snap.date + '|' + promptId + '|' + engine),
            run_type: snap.type, snapshot_date: snap.date, engine,
            prompt_id: promptId, prompt_text: text, query_intent: intent, topic_cluster: cat,
            brand: COMPANY,
            brand_mentioned: hit || rnd() < 0.12 ? 1 : 0,
            brand_cited: hit ? 1 : 0,
            brand_citation_rank: rank,
            total_brands_cited: list.length,
            brands_cited_list: list.join(';'),
            top_cited_brand: list[0],
            brand_is_leader: leads ? 1 : 0,
            linked_to_site: hit && rnd() < 0.5 ? 1 : 0,
            sentiment: hit ? (rnd() < 0.82 ? 'positive' : 'neutral') : 'neutral',
            claims_about_brand: hit ? 1 + Math.round(rnd() * 3) : 0,
            incorrect_claims: 0, has_incorrect_claim: 0,
            services_correct: hit ? 1 : '', location_correct: hit ? 1 : '', contact_correct: '',
            ai_sessions: 0, ai_conversions: 0, ai_pipeline_usd: 0,
            answer_excerpt: '(demo) ' + list.slice(0, 3).join(', ') + '…',
            written_at: new Date(snap.date + 'T12:00:00Z').toISOString()
          });
        }
      }
    }
    return rows;
  }

  const promptsText = () => PROMPTS.map(p => p[0] + ': ' + p[2]).join('\n');

  /**
   * Build it, or rebuild it. Every step is idempotent: an existing customer is reused and its
   * rows cleared, so running this twice produces one demo, not two.
   */
  async function seed(opts) {
    const call = opts.call;
    const log = opts.log || function () {};
    const rows = buildRows();

    const created = await call('POST', '/api/intake-codes', { body: { company: COMPANY } });
    if (created.status === 200) log('customer created');
    else if (created.status === 409) log('customer exists — resetting it');
    else throw new Error('could not create the customer: ' + created.status +
      ' ' + JSON.stringify(created.data).slice(0, 140));

    // The generated password is shown once and then hashed, so a rebuild has no way to report it.
    // A known one instead, so the login printed at the end is always true.
    await call('PATCH', '/api/intake-codes', {
      body: { username: SLUG, adminReset: true, newPassword: CLIENT_PASSWORD } });

    await call('POST', '/api/intake', { body: { company: COMPANY, intake: INTAKE } });
    // Saving the answers is not the same as the form being submitted: submittedAt lives on the
    // customer record, keyed by the member's username, and without it the client portal greets
    // the demo with "finish your form" above a finished dashboard.
    await call('PATCH', '/api/intake-codes', { body: { username: SLUG, markSubmitted: true } });
    log('intake saved and submitted');

    const text = promptsText();
    await call('POST', '/api/prompts', {
      body: { company: COMPANY, promptsText: text, languages: ['Spanish', 'English'] } });
    await call('PATCH', '/api/prompts', { body: { company: COMPANY, internalApprove: true, promptsText: text } });
    // Approved on the customer's behalf too, or it opens with "there are prompts waiting for your
    // review" above six months of finished measurements — two stories at once.
    await call('PATCH', '/api/prompts', { body: { company: COMPANY, comments: 'Aprobado (demo)' } });
    log(PROMPTS.length + ' prompts released and approved');

    await call('DELETE', '/api/results', { query: { company: COMPANY } });
    let written = 0;
    for (const row of rows) {
      const r = await call('POST', '/api/results', { body: row });
      if (r.status === 200) written++;
      if (written % 60 === 0 && written) log(written + '/' + rows.length + ' rows');
    }
    log(written + '/' + rows.length + ' rows written');

    // Monitoring ON with a schedule, not off. Off is the cautious choice, but the monitoring
    // dashboard then reads "Monitoring off" to the client as well as to staff. On is safe here:
    // when the schedule comes due the cron tries a real audit, this customer has no Claude key,
    // and run-audit-background refuses before it calls anything and before it clears any rows.
    await call('PATCH', '/api/intake-codes', {
      body: { company: COMPANY, diagnosisReleased: true, monitoringReleased: true,
              monitoringEnabled: true, monitoringCadence: 'monthly',
              monitoringStartDate: TIMELINE[TIMELINE.length - 1].date } });
    log('both dashboards released');

    // Warm the derived CSV before anyone opens a dashboard, and read until the rows come back
    // rather than once: writing a row drops that cache, so the first read pays for the whole
    // rebuild, and a listing taken straight after a few hundred writes can come back short.
    let readable = 0;
    for (let i = 0; i < 6; i++) {
      const warm = await call('GET', '/api/results', { query: { company: COMPANY } });
      readable = Math.max(0, String(warm.text || '').split('\n').filter(Boolean).length - 1);
      if (readable >= rows.length) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    log('cache warmed — ' + readable + '/' + rows.length + ' rows readable');
    return { company: COMPANY, username: SLUG, password: CLIENT_PASSWORD, rows: written, readable };
  }

  /**
   * Take it away completely.
   *
   * Deleting a customer does not delete what is keyed by their company — results, prompts and
   * intake all outlive the record, so a customer recreated under the same name inherits them.
   * For a demo that means yesterday's numbers reappearing under today's rebuild; the order here
   * is deliberate.
   */
  async function remove(opts) {
    const call = opts.call;
    const log = opts.log || function () {};
    const r1 = await call('DELETE', '/api/results', { query: { company: COMPANY } });
    log('results cleared (' + r1.status + ')');
    const r2 = await call('DELETE', '/api/intake-codes', { query: { username: SLUG } });
    log('customer removed (' + r2.status + ')');
    return { results: r1.status, customer: r2.status };
  }

  return { COMPANY, SLUG, CLIENT_PASSWORD, COMPETITORS, ENGINES, PROMPTS, TIMELINE, INTAKE,
           hashId, buildRows, promptsText, seed, remove };
});
