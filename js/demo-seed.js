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

  // 300 questions, the size of a real prompt set — too many to write out, so they are built from
  // the pieces a generated set is built from: equipment, symptoms, cities, buyer roles. Five
  // categories, sixty each, Spanish and English mixed the way a bilingual customer's set is.
  const EQUIPMENT = ['bombas de pistón', 'cilindros hidráulicos', 'prensas hidráulicas', 'válvulas proporcionales',
    'centrales hidráulicas', 'mangueras de alta presión', 'motores hidráulicos', 'acumuladores',
    'sistemas de filtración', 'bombas de engranes'];
  const SYMPTOMS = ['perdió presión de un día para otro', 'tira aceite por los sellos',
    'se sobrecalienta después de dos horas', 'hace ruido y vibra al arrancar',
    'baja la fuerza a medio ciclo', 'no sostiene carga'];
  const CITIES = ['Querétaro', 'León', 'el Bajío', 'Monterrey', 'Puebla', 'Toluca', 'Guadalajara', 'San Luis Potosí'];
  const ROLES = ['gerente de mantenimiento', 'comprador industrial', 'jefe de planta',
    'supervisor de producción', 'ingeniero de confiabilidad', 'encargado de refacciones'];
  const EN_EQUIP = ['hydraulic cylinders', 'piston pumps', 'proportional valves', 'power units', 'hydraulic presses'];

  function buildPrompts() {
    // Built from a cross-product and de-duplicated rather than by cycling each list with its own
    // modulo: the strides collide, and the first version produced 300 questions of which only 159
    // were distinct. A demo that lists the same question twice reads as carelessness.
    const take = (cat, intent, makers, n) => {
      const seen = new Set(), out = [];
      for (const make of makers) {
        for (const text of make()) {
          if (out.length >= n) break;
          if (seen.has(text)) continue;
          seen.add(text); out.push([cat, intent, text]);
        }
        if (out.length >= n) break;
      }
      if (out.length < n) throw new Error(`only ${out.length} distinct prompts for ${cat}, needed ${n}`);
      return out;
    };
    const cross = (a, b, fn) => function* () { for (const x of a) for (const y of b) yield fn(x, y); };
    const over = (a, fn) => function* () { for (const x of a) yield fn(x); };

    return [].concat(
      take('CAT1', 'brand', [
        cross(EQUIPMENT, CITIES, (e, c) => `¿${COMPANY} vende ${e} en ${c}?`),
        over(EQUIPMENT, e => `¿Qué opiniones hay de ${COMPANY}? ¿Alguien les ha comprado ${e}?`),
        over(EQUIPMENT, e => `¿${COMPANY} repara ${e} o sólo los vende?`),
        over(EN_EQUIP, e => `Is ${COMPANY} a reliable supplier for ${e}?`)
      ], 60),
      take('CAT2', 'category', [
        cross(EQUIPMENT, CITIES, (e, c) => `¿Cuáles son los mejores proveedores de ${e} en ${c}?`),
        cross(EQUIPMENT, CITIES, (e, c) => `¿Quién distribuye ${e} en ${c}?`),
        over(EN_EQUIP, e => `Best industrial suppliers for ${e} in Mexico`)
      ], 60),
      take('CAT3', 'problem', [
        cross(EQUIPMENT, SYMPTOMS, (e, sy) => `Mi equipo con ${e} ${sy}, ¿quién puede diagnosticarlo?`),
        cross(EQUIPMENT, CITIES, (e, c) => `Tengo ${e} fuera de servicio en ${c}. ¿A quién le hablo?`),
        over(EN_EQUIP, e => `${e} losing pressure mid-cycle — who can service them in Mexico?`)
      ], 60),
      take('CAT4', 'competitor', [
        cross(COMPETITORS, EQUIPMENT, (r, e) => `¿${COMPANY} o ${r} para ${e}?`),
        cross(COMPETITORS, CITIES, (r, c) => `¿Quién es mejor en ${c}, ${COMPANY} o ${r}?`),
        over(COMPETITORS, r => `${COMPANY} vs ${r} for industrial hydraulics — which is better?`)
      ], 60),
      take('CAT5', 'persona', [
        cross(ROLES, EQUIPMENT, (r, e) => `Soy ${r} y busco proveedor de ${e} con servicio en sitio.`),
        cross(ROLES, CITIES, (r, c) => `Como ${r} en ${c}, ¿qué proveedor de hidráulica me recomiendan?`),
        over(EN_EQUIP, e => `As a maintenance manager, which supplier should I use for ${e}?`)
      ], 60)
    );
  }
  const PROMPTS = buildPrompts();

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

    // The question set the customer is served. A customer with nothing released gets the default
    // set, but the staff page still reads as unfinished — there is a form sitting there waiting to
    // be published, which is a job the demo should not be handing anyone. Saved as a draft and
    // then released, which is the same two steps the editor performs.
    const tpl = await call('GET', '/intake-template.default.json', {});
    let template = null;
    try { template = JSON.parse(tpl.text || 'null'); } catch (e) { template = null; }
    if (template) {
      await call('POST', '/api/intake-template', { body: { company: COMPANY, template } });
      const rel = await call('PATCH', '/api/intake-template', { body: { company: COMPANY } });
      log(rel.status === 200 ? 'intake form released to the customer'
                             : 'intake form NOT released (' + rel.status + ' ' + JSON.stringify(rel.data).slice(0, 90) + ')');
    } else {
      log('could not read the default intake template — the form stays unreleased');
    }

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

    // Written BEFORE anything is removed. This used to clear the customer's rows and then write,
    // which is fine until a write fails — and the first time it did, it failed for every row at
    // once (a build started against a deploy whose /api/results did not take a batch yet), so the
    // clear had already happened and the dashboard was simply empty. Row keys are deterministic
    // — company, date, prompt, engine — so writing over a previous build replaces it in place and
    // there is nothing to clear first. Stale dates are swept afterwards, once the new set is
    // safely stored.
    // In batches. Every write drops the derived CSV, so six thousand rows sent one per request is
    // six thousand rebuilds, each one reading more than the last — hours, and most of it spent
    // rebuilding a cache that the next row immediately drops again.
    const BATCH = 150;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const r = await call('POST', '/api/results', { body: { rows: slice } });
      if (r.status === 200) written += (r.data && r.data.written) || slice.length;
      else throw new Error('row batch refused: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 140));
      log(written + '/' + rows.length + ' rows');
    }
    log(written + '/' + rows.length + ' rows written');

    // Now that this build is stored, remove snapshots from any earlier one whose dates this
    // timeline no longer has. Deleting by date rather than wholesale, so a failure here leaves
    // the demo built rather than gutted.
    const mine = new Set(TIMELINE.map(t => t.date));
    const current = await call('GET', '/api/results', { query: { company: COMPANY } });
    const lines = String(current.text || '').split('\n').filter(Boolean).slice(1);
    const header = String(current.text || '').split('\n')[0].split(',');
    const dateAt = header.indexOf('snapshot_date');
    const stale = new Set();
    if (dateAt !== -1) {
      for (const line of lines) {
        const d = line.split(',')[dateAt];
        if (d && !mine.has(d)) stale.add(d);
      }
    }
    for (const d of stale) {
      await call('DELETE', '/api/results', { query: { company: COMPANY, snapshot_date: d } });
    }
    if (stale.size) log('removed ' + stale.size + ' snapshot(s) from an earlier build');

    // Monitoring ON with a schedule, not off. Off is the cautious choice, but the monitoring
    // dashboard then reads "Monitoring off" to the client as well as to staff. On is safe here:
    // when the schedule comes due the cron tries a real audit, this customer has no Claude key,
    // and run-audit-background refuses before it calls anything and before it clears any rows.
    // Two requests, not one. The PATCH handler matches a monitoring-cadence branch first and
    // returns from it, so a request carrying both the schedule and the release flags sets the
    // schedule and silently drops the releases — the dashboards then read "No liberado" and the
    // customer page says there is still a step to do, which is the opposite of the point.
    const rel = await call('PATCH', '/api/intake-codes', {
      body: { company: COMPANY, diagnosisReleased: true, monitoringReleased: true } });
    const sched = await call('PATCH', '/api/intake-codes', {
      body: { company: COMPANY, monitoringEnabled: true, monitoringCadence: 'monthly',
              monitoringStartDate: TIMELINE[TIMELINE.length - 1].date } });
    if (rel.status !== 200) throw new Error('dashboards not released: ' + rel.status +
      ' ' + JSON.stringify(rel.data).slice(0, 140));
    log('both dashboards released, monitoring scheduled (' + sched.status + ')');

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
