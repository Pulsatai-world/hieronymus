import { getStore } from '@netlify/blobs';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

const DEFAULT_INTERVAL_DAYS = 30;

// Runs daily so per-customer schedules (2 weeks / 1 month / 2 months, set from the Monitoring
// dashboard) land on the right day rather than only ever lining up with a monthly boundary —
// each customer's own nextRunAt decides whether *they're* actually due, not how often this
// function itself executes. Reuses the exact same trigger the Portal's "Run Audit" button
// calls, so there is only ever one audit-running implementation (run-audit-background.js).
export default async (request, context) => {
  const codesStore = getStore('hieronymus-intake-codes');
  const promptsStore = getStore('hieronymus-prompts');
  const base = process.env.URL || process.env.DEPLOY_URL || '';
  const now = Date.now();

  const { blobs } = await codesStore.list();
  const customers = await Promise.all(blobs.map(async b => ({ key: b.key, data: await codesStore.get(b.key, { type: 'json' }) })));
  const monitored = customers.filter(c => c.data && c.data.monitoringEnabled && c.data.submittedAt);

  // A customer enabled via the old plain on/off checkbox (no schedule ever chosen) gets a
  // default cadence established here rather than firing immediately — same conservative
  // behavior as before, just tracked per-customer instead of on a shared calendar boundary.
  const due = [];
  for (const c of monitored) {
    if (!c.data.nextRunAt) {
      c.data.nextRunAt = new Date(now + DEFAULT_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await codesStore.setJSON(c.key, c.data);
      continue;
    }
    if (new Date(c.data.nextRunAt).getTime() <= now) due.push(c);
  }

  let triggered = 0;
  for (const c of due) {
    const customer = c.data;
    const prompts = await promptsStore.get(slugify(customer.company), { type: 'json' });
    if (!prompts || !prompts.promptsText) continue; // nothing generated yet for this customer

    // run-audit-background.js awaits the whole run internally and only resolves its HTTP
    // response once it's fully done (can take minutes) — deliberately not awaited here, so
    // triggering one customer's run doesn't block kicking off the next one.
    fetch(base + '/api/run-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: customer.company })
    }).catch(() => { /* one customer's failure to kick off shouldn't block the rest */ });
    triggered++;

    // Roll the schedule forward by this customer's own interval, so the next check lands on
    // their cadence rather than re-firing every day until manually reset.
    const intervalDays = customer.monitoringIntervalDays || DEFAULT_INTERVAL_DAYS;
    customer.nextRunAt = new Date(now + intervalDays * 24 * 60 * 60 * 1000).toISOString();
    await codesStore.setJSON(c.key, customer);

    // Stagger kickoffs so a large monitoring list doesn't fire them all in the same instant.
    await new Promise(r => setTimeout(r, 2000));
  }

  return new Response(JSON.stringify({ status: 'ok', triggered, checked: monitored.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { schedule: '@daily' };
