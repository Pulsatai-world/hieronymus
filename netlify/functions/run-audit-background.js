import { getStore } from '@netlify/blobs';

// Server-side port of index.html's multi-engine answer+grade pipeline. Runs as a Netlify
// Background Function (note the -background filename) so it can keep going well past the
// ~10s limit on regular functions. Raw per-customer API keys are read here directly from
// Blobs and used only for outbound provider calls — they are never written into any HTTP
// response, so they never reach the browser.

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ENGINES ──
const ENGINE_DEFS = [
  {
    name: 'Claude',
    // Deliberately pinned, and NOT upgraded alongside the grading call below. This request
    // simulates what a real person gets when they ask Claude the question, so the monitoring
    // dashboard only trends meaningfully if the answering model stays the same between snapshots
    // — changing it resets the baseline and makes this month incomparable to last month. Change
    // it only when you intend to start a new baseline, and note the change on the snapshot.
    buildAnswerRequest: query => ({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: query }]
    }),
    parseAnswer: data => data.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim(),
    call: (apiKey, body) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    })
  },
  {
    name: 'ChatGPT',
    buildAnswerRequest: query => ({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search' }]
    }),
    parseAnswer: data => {
      if (typeof data.output_text === 'string' && data.output_text) return data.output_text.trim();
      const msg = (data.output || []).find(o => o.type === 'message');
      const block = msg && msg.content && msg.content.find(c => c.type === 'output_text' || c.type === 'text');
      if (block && block.text) return block.text.trim();
      throw new Error('Could not find answer text in ChatGPT response');
    },
    call: (apiKey, body) => fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(body)
    })
  },
  {
    name: 'Gemini',
    // Pro-tier Gemini models commonly ship with a $0 free-tier request quota (a hard "limit: 0",
    // not a burst limit) — no amount of throttling gets past that, it requires billing enabled
    // on the Google Cloud project. Flash-tier models carry real free-tier quota, so that's the
    // default here; switch back to a Pro model once billing is enabled if you want that quality.
    buildAnswerRequest: query => ({
      model: 'gemini-3.5-flash',
      input: query,
      tools: [{ type: 'google_search' }]
    }),
    parseAnswer: data => {
      const modelOutput = (data.steps || []).find(s => s.type === 'model_output');
      const textBlock = modelOutput && modelOutput.content && modelOutput.content.find(c => c.type === 'text');
      if (textBlock && textBlock.text) return textBlock.text.trim();
      const legacyText = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      if (legacyText) return legacyText.trim();
      throw new Error('Could not find answer text in Gemini response');
    },
    call: (apiKey, body) => fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    })
  }
];

// Some engines' free/lower tiers enforce a strict requests-per-minute cap that this
// pipeline's concurrency (multiple prompts in flight at once, each calling every active
// engine) can blow through in a single burst — Gemini's free tier hit exactly this,
// failing every call with a quota error instead of just slowing down. This gate serializes
// calls per engine name and enforces a minimum gap between call starts, without touching
// the concurrency of any other engine. Conservative default; raise/lower per engine once
// you know its actual quota from the provider's dashboard.
// 6s (10 req/min) was a conservative guess made while still on the Pro-tier model (which
// turned out to have a $0 free quota regardless of pacing). Now on Flash tier, which typically
// allows much faster free-tier throughput — tighten this once the real limit is confirmed from
// Google's dashboard, but 2s (30 req/min) is a safer, still-cautious default that keeps a
// 100-prompt run from needlessly ballooning past a background function's execution ceiling.
const ENGINE_MIN_INTERVAL_MS = { Gemini: 2000 };
const engineGateQueue = {};
const engineLastCallAt = {};
function gateEngine(engineName) {
  const minInterval = ENGINE_MIN_INTERVAL_MS[engineName];
  if (!minInterval) return Promise.resolve();
  const prev = engineGateQueue[engineName] || Promise.resolve();
  const next = prev.then(async () => {
    const wait = (engineLastCallAt[engineName] || 0) + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    engineLastCallAt[engineName] = Date.now();
  });
  engineGateQueue[engineName] = next;
  return next;
}

// Some 429s are a genuine "slow down, try again shortly" — worth retrying. Others are a
// permanent "this will never succeed until you add funds/quota" (depleted prepay balance, a
// hard 0 free-tier allocation, etc.) — retrying those wastes minutes per prompt (up to ~130s
// across 4 backoff attempts) for a call that's guaranteed to fail every time, which is exactly
// what stalled 100-prompt runs out past Netlify's execution window. Detect these by message
// content and fail immediately instead of burning through retries.
function isPermanentQuotaError(message) {
  return /credits are depleted|insufficient (credit|balance|funds)|billing|limit:\s*0\b/i.test(message || '');
}

async function callEngineWithRetry(def, apiKey, body, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    const res = await def.call(apiKey, body);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = err.error?.message || def.name + ' API error ' + res.status;
      const isRetryableStatus = [429, 529, 502, 503, 500].includes(res.status);
      if (isRetryableStatus && !isPermanentQuotaError(message)) {
        attempt++;
        if (attempt > maxRetries) {
          throw new Error(message + ' — gave up after ' + maxRetries + ' retries');
        }
        const retryAfterHeader = res.headers.get('retry-after');
        const waitSec = retryAfterHeader ? parseInt(retryAfterHeader) : Math.min(60, 5 * Math.pow(2, attempt));
        await sleep(waitSec * 1000);
        continue;
      }
      throw new Error(message);
    }
    return res.json();
  }
}

// ── PROMPT PARSING ──
function detectCategory(prompt, company) {
  const p = prompt.toLowerCase();
  if (p.startsWith('cat1:') || p.startsWith('1.') || p.startsWith('category 1')) return 'Brand';
  if (p.startsWith('cat2:') || p.startsWith('category 2')) return 'Category';
  if (p.startsWith('cat3:') || p.startsWith('category 3')) return 'Problem';
  if (p.startsWith('cat4:') || p.startsWith('category 4')) return 'Competitor';
  if (p.startsWith('cat5:') || p.startsWith('category 5')) return 'Persona';
  if (p.includes(' vs ') || p.includes('alternative') || p.includes('alternativa')) return 'Competitor';
  if (p.includes('problem') || p.includes('broken') || p.includes('failed') || p.includes('roto') || p.includes('falla')) return 'Problem';
  if (p.includes('who is') || p.includes('what is ' + (company || '').toLowerCase())) return 'Brand';
  return 'Category';
}
function cleanPrompt(prompt) {
  return prompt.replace(/^(cat[1-5]:|category \d+:|[1-9]\d*\.)\s*/i, '').trim();
}

// ── GRADING ──
const ENGINE_JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    engine: { type: 'string' },
    query_intent: { type: 'string', enum: ['evaluation', 'comparison', 'informational', 'definition', 'local', 'pricing', 'trust', 'feature', 'integration'] },
    brand_mentioned: { type: 'boolean' },
    brand_cited: { type: 'boolean' },
    brands_cited_list: { type: 'array', items: { type: 'string' } },
    linked_to_site: { type: 'boolean' },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'not_mentioned'] },
    claims_about_brand: { type: 'integer' },
    incorrect_claims: { type: 'integer' },
    ranking_note: { type: 'string' },
    services_correct: { type: ['boolean', 'null'] },
    location_correct: { type: ['boolean', 'null'] },
    contact_correct: { type: ['boolean', 'null'] }
  },
  required: ['engine', 'query_intent', 'brand_mentioned', 'brand_cited', 'brands_cited_list', 'linked_to_site', 'sentiment', 'claims_about_brand', 'incorrect_claims', 'ranking_note', 'services_correct', 'location_correct', 'contact_correct'],
  additionalProperties: false
};
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { engines: { type: 'array', items: ENGINE_JUDGMENT_SCHEMA } },
  required: ['engines'],
  additionalProperties: false
};

function buildClassifyRequest(cleanedPrompt, company, truthNote, engineAnswers) {
  const answersBlock = engineAnswers.map(a => `--- ${a.engine}'s answer ---\n${a.text}`).join('\n\n');
  const query = `You are grading AI-visibility audit answers for the company "${company}".

The original question a user asked different AI engines was: "${cleanedPrompt}"

Below are the raw, independently-generated answers from each engine to that same question. Grade EACH one separately using the exact same rules, and return one entry per engine in the "engines" array (set "engine" to the exact name labeled below, so results can be matched back).

${answersBlock}

For each engine's answer report:
- engine: the engine name exactly as labeled above.
- query_intent: classify the ORIGINAL QUESTION (not the answer) as one of evaluation, comparison, informational, definition, local, pricing, trust, feature, integration.
- brand_mentioned: true if "${company}" is named anywhere in that answer.
- brand_cited: true if "${company}" is named as a recommended/qualifying option in that answer (not just mentioned in passing).
- brands_cited_list: every company/brand that answer cites as a recommended option, in the order cited (include "${company}" at its actual position if it's cited).
- linked_to_site: true if that answer includes a link/URL to "${company}"'s own website.
- sentiment: positive / neutral / negative / not_mentioned — that answer's tone toward "${company}" if mentioned.
- claims_about_brand: how many distinct factual claims that answer makes about "${company}".
- incorrect_claims: of those, how many seem questionable, unverifiable, or likely wrong — flag for human review, don't assert they're false.
- ranking_note: one sentence on how "${company}" compares to any competitors named in that answer.${truthNote}`;

  return {
    // This is the interpretation step that builds the dataset — every figure on both dashboards
    // derives from it, so it runs on the newest Sonnet rather than 4.6: better rubric consistency
    // at the same list price, and structured outputs are documented as supported here (they are
    // not documented for Sonnet 4.6, which this call was previously relying on).
    // Sonnet 5 runs adaptive thinking by default and max_tokens caps thinking + JSON together,
    // so the old 3072 would truncate the response and break the JSON.parse in
    // parseClassifyResponse. Hence the larger ceiling, plus an explicit medium effort — rubric
    // application doesn't need the default 'high', and this call runs once per prompt.
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    messages: [{ role: 'user', content: query }]
  };
}
function parseClassifyResponse(data) {
  const textBlock = data.content.find(b => b.type === 'text');
  const parsed = JSON.parse(textBlock.text);
  const byEngine = {};
  (parsed.engines || []).forEach(e => { byEngine[e.engine] = e; });
  return byEngine;
}

// ── RESULT ROW BUILDERS ──
function buildSuccessResult(p) {
  const j = p.judgment;
  const cited = !!j.brand_cited;
  const brandsCitedList = Array.isArray(j.brands_cited_list) ? j.brands_cited_list.filter(Boolean) : [];
  const citationIdx = brandsCitedList.findIndex(b => b.toLowerCase() === p.company.toLowerCase());
  const topCitedBrand = brandsCitedList[0] || '';
  const competitorsMentioned = brandsCitedList.filter(b => b.toLowerCase() !== p.company.toLowerCase());
  return {
    promptId: p.promptId, prompt: p.cleanedPrompt, category: p.category, engine: p.engine,
    queryIntent: j.query_intent || '', cited, brandMentioned: !!j.brand_mentioned, brandCited: cited,
    brandsCitedList, totalBrandsCited: brandsCitedList.length,
    brandCitationRank: citationIdx >= 0 ? citationIdx + 1 : '', topCitedBrand,
    brandIsLeader: topCitedBrand && topCitedBrand.toLowerCase() === p.company.toLowerCase() ? 1 : 0,
    linkedToSite: !!j.linked_to_site, sentiment: j.sentiment || 'not_mentioned',
    claimsAboutBrand: Number.isFinite(j.claims_about_brand) ? j.claims_about_brand : 0,
    incorrectClaims: Number.isFinite(j.incorrect_claims) ? j.incorrect_claims : 0,
    hasIncorrectClaim: (j.incorrect_claims || 0) > 0 ? 1 : 0,
    servicesCorrect: j.services_correct ?? null, locationCorrect: j.location_correct ?? null, contactCorrect: j.contact_correct ?? null,
    response: (p.rawText || '').slice(0, 500), snapshotDate: p.snapshotDate,
    aiSessions: 0, aiConversions: 0, aiPipelineUsd: 0, company: p.company, runType: p.runType
  };
}
function buildErrorResult(p) {
  return {
    promptId: p.promptId, prompt: p.cleanedPrompt, category: p.category, engine: p.engine,
    queryIntent: '', cited: false, brandMentioned: false, brandCited: false, brandsCitedList: [], totalBrandsCited: 0,
    brandCitationRank: '', topCitedBrand: '', brandIsLeader: 0, linkedToSite: false, sentiment: 'error',
    claimsAboutBrand: 0, incorrectClaims: 0, hasIncorrectClaim: 0,
    servicesCorrect: null, locationCorrect: null, contactCorrect: null,
    response: p.message, snapshotDate: p.snapshotDate,
    aiSessions: 0, aiConversions: 0, aiPipelineUsd: 0, company: p.company, runType: p.runType, error: true
  };
}

function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function nullableFlag(v) { return v === null || v === undefined ? '' : (v ? 1 : 0); }
function buildDbRow(r) {
  return {
    run_id: hashId(`${r.snapshotDate}|${r.promptId}|${r.engine}`), run_type: r.runType || 'diagnostic', snapshot_date: r.snapshotDate, engine: r.engine,
    prompt_id: r.promptId, prompt_text: r.prompt, query_intent: r.queryIntent || '', topic_cluster: r.category, brand: r.company,
    brand_mentioned: r.brandMentioned ? 1 : 0, brand_cited: r.brandCited ? 1 : 0, brand_citation_rank: r.brandCitationRank || '',
    total_brands_cited: r.totalBrandsCited || 0, brands_cited_list: (r.brandsCitedList || []).join(';'), top_cited_brand: r.topCitedBrand || '',
    brand_is_leader: r.brandIsLeader ? 1 : 0, linked_to_site: r.linkedToSite ? 1 : 0, sentiment: r.sentiment,
    claims_about_brand: r.claimsAboutBrand || 0, incorrect_claims: r.incorrectClaims || 0, has_incorrect_claim: r.hasIncorrectClaim ? 1 : 0,
    services_correct: nullableFlag(r.servicesCorrect), location_correct: nullableFlag(r.locationCorrect), contact_correct: nullableFlag(r.contactCorrect),
    ai_sessions: r.aiSessions || 0, ai_conversions: r.aiConversions || 0, ai_pipeline_usd: r.aiPipelineUsd || 0, answer_excerpt: r.response
  };
}

// Serialize writes: /api/results appends to one shared CSV blob via optimistic concurrency,
// so firing many saves at once just makes them collide and retry against each other. Queuing
// them here means the concurrent engine/grading calls still overlap (where the real latency is),
// but the DB writes themselves happen one at a time.
let saveQueue = Promise.resolve();
function saveResultRow(row) {
  const run = async () => {
    const base = process.env.URL || process.env.DEPLOY_URL || '';
    const target = base + '/api/results';
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
      if (!res.ok) throw new Error('Failed to save result row (HTTP ' + res.status + ')');
    } catch (err) {
      console.error('SAVE_ROW_FAILED', JSON.stringify({ target, base, envURL: process.env.URL, envDEPLOY_URL: process.env.DEPLOY_URL, run_id: row.run_id, error: err.message }));
      throw err;
    }
  };
  const result = saveQueue.then(run);
  saveQueue = result.catch(() => {}); // one failed save shouldn't block the rest of the queue
  return result;
}

// With CONCURRENCY=12, up to a dozen processPrompt() calls finish in parallel and each calls
// updateJob() independently. Unserialized, their get()s interleave before either setJSON()
// commits, so whichever write lands last clobbers whatever the other just set (e.g. status
// silently reverting to an earlier value) — a lost-update race, not just Blobs propagation lag.
// Serializing through a single queue (same pattern as saveResultRow below) makes each
// read-modify-write cycle atomic relative to the others.
let jobUpdateQueue = Promise.resolve();
function updateJob(store, key, patch) {
  const run = async () => {
    const existing = (await store.get(key, { type: 'json' })) || {};
    await store.setJSON(key, { ...existing, ...patch });
  };
  const result = jobUpdateQueue.then(run);
  jobUpdateQueue = result.catch(() => {});
  return result;
}

// Claude/ChatGPT calls aren't rate-gated, so a small chunk size just forces them to sit idle
// waiting on Gemini's paced-out calls before the next batch of prompts can even start queuing.
// A bigger window lets many more prompts' Gemini calls queue up front, so the throttle queue
// stays continuously busy instead of stalling at each chunk boundary — this doesn't change how
// many API calls get made, just how much unrelated waiting happens between them.
const CONCURRENCY = 12;

export default async (request, context) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
  const company = (body.company || '').trim();
  if (!company) return new Response('Missing company', { status: 400 });
  // Tags every row from this run. Monitoring (cron) runs pass run_type:'monitoring'; the manual
  // "Run Audit" button (and anything else) defaults to 'diagnostic', which is the only data the
  // diagnostic dashboard ever reads — so monitoring runs never alter the diagnosis snapshot.
  const runType = body.run_type === 'monitoring' ? 'monitoring' : 'diagnostic';
  // Recovery path for a run killed mid-flight by the platform's background-function execution
  // limit (single long invocation, no resume logic otherwise): skip prompts before this index
  // instead of reprocessing everything, so a partial stall doesn't cost double the API usage
  // to fix.
  const startIndex = Number.isInteger(body.startIndex) && body.startIndex > 0 ? body.startIndex : 0;

  const jobKey = slugify(company);
  const jobsStore = getStore('hieronymus-audit-jobs');

  // Reject a second run for the same customer while one is already in flight — two overlapping
  // invocations racing on the same job-status record is exactly what previously corrupted the
  // displayed progress/completion numbers (stale startedAt, completed counts jumping backward).
  const existingJob = await jobsStore.get(jobKey, { type: 'json' });
  if (existingJob && existingJob.status === 'running') {
    return new Response(JSON.stringify({ status: 'error', message: 'An audit is already running for this customer.' }), {
      status: 409, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Mark as running immediately so a poll moments after triggering already sees 'running'.
  await jobsStore.setJSON(jobKey, { status: 'running', company, startedAt: new Date().toISOString(), completed: 0, total: 0, cited: 0, message: '' });

  // Background Functions get their long execution window from Netlify itself — the platform
  // already responds to the original caller right away, so the actual work below is directly
  // awaited here (NOT fired-and-forgotten in a detached promise). A detached, un-awaited async
  // block would let this handler's `return` end the invocation before the work finished,
  // silently killing the run — which is exactly what happened before this fix (jobs stuck at
  // completed:0/total:0 forever).
  try {
    const intakeStore = getStore('hieronymus-intake');
    const promptsStore = getStore('hieronymus-prompts');
    const keysStore = getStore('hieronymus-customer-keys');

    const [intakeRecord, promptsRecord, keysRecord] = await Promise.all([
      intakeStore.get(jobKey, { type: 'json' }),
      promptsStore.get(jobKey, { type: 'json' }),
      keysStore.get(jobKey, { type: 'json' })
    ]);

    if (!promptsRecord || !promptsRecord.promptsText) {
      await updateJob(jobsStore, jobKey, { status: 'error', message: 'No generated prompts found for this customer — generate them first.', finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ status: 'error' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Engines selected at "Generate Prompts" time (if any were stored) further narrow which
    // configured keys actually get used — e.g. a customer might have all 3 keys set but the
    // user only wanted this run to use Claude + ChatGPT.
    const selectedEngines = Array.isArray(promptsRecord.engines) && promptsRecord.engines.length
      ? promptsRecord.engines.map(e => String(e).toLowerCase())
      : null;

    const activeEngines = ENGINE_DEFS
      .map(def => ({ def, apiKey: keysRecord && keysRecord[def.name.toLowerCase()] }))
      .filter(e => e.apiKey)
      .filter(e => !selectedEngines || selectedEngines.includes(e.def.name.toLowerCase()));

    const claudeKey = keysRecord && keysRecord.claude;
    if (!claudeKey) {
      await updateJob(jobsStore, jobKey, { status: 'error', message: "A Claude API key is required to grade every engine's answers — configure it for this customer first.", finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ status: 'error' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const claudeDef = ENGINE_DEFS.find(e => e.name === 'Claude');

    const prompts = promptsRecord.promptsText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    const snapshotDate = new Date().toISOString().slice(0, 10);

    const intake = intakeRecord?.intake;
    const groundTruth = {
      services: intake?.general?.industry || '',
      contact: intake?.general?.website || intake?.websites?.primarySite || ''
    };
    const truthLines = [];
    if (groundTruth.services) truthLines.push(`Correct services/industry: ${groundTruth.services}`);
    if (groundTruth.contact) truthLines.push(`Correct contact/site: ${groundTruth.contact}`);
    const truthNote = truthLines.length
      ? `\n\nGround truth to check each answer against (only assess the fields below that have ground truth given; return null for the rest):\n${truthLines.join('\n')}`
      : '\n\nNo ground truth was provided — return null for services_correct, location_correct, and contact_correct.';

    const totalUnits = (prompts.length - startIndex) * activeEngines.length;
    await updateJob(jobsStore, jobKey, { total: totalUnits });

    let completed = 0, citedCount = 0;

    async function processPrompt(rawPrompt, index) {
      const category = detectCategory(rawPrompt, company);
      const cleanedPrompt = cleanPrompt(rawPrompt);
      const promptId = 'Q' + String(index + 1).padStart(2, '0');
      const answerQuery = `${cleanedPrompt}\n\n(Answer as you normally would for a real user asking this. Search the web if useful. Keep it to 2-5 sentences.)`;

      const rawAnswers = {};
      await Promise.all(activeEngines.map(async engine => {
        try {
          await gateEngine(engine.def.name);
          const reqBody = engine.def.buildAnswerRequest(answerQuery);
          const data = await callEngineWithRetry(engine.def, engine.apiKey, reqBody);
          rawAnswers[engine.def.name] = { text: engine.def.parseAnswer(data) };
        } catch (err) {
          rawAnswers[engine.def.name] = { error: err.message };
        }
      }));

      const okEngines = activeEngines.filter(e => rawAnswers[e.def.name] && !rawAnswers[e.def.name].error);
      let judgments = {};
      let classifyError = null;
      if (okEngines.length > 0) {
        try {
          const classifyBody = buildClassifyRequest(cleanedPrompt, company, truthNote,
            okEngines.map(e => ({ engine: e.def.name, text: rawAnswers[e.def.name].text })));
          const data = await callEngineWithRetry(claudeDef, claudeKey, classifyBody);
          judgments = parseClassifyResponse(data);
        } catch (err) {
          classifyError = err.message;
        }
      }

      for (const engine of activeEngines) {
        const name = engine.def.name;
        const raw = rawAnswers[name];
        const base = { promptId, cleanedPrompt, category, engine: name, snapshotDate, company, runType };
        let result;
        if (raw.error) {
          result = buildErrorResult({ ...base, message: 'ERROR (answer): ' + raw.error });
        } else if (!judgments[name]) {
          result = buildErrorResult({ ...base, message: 'ERROR (grading): ' + (classifyError || 'missing from grader response') });
        } else {
          result = buildSuccessResult({ ...base, judgment: judgments[name], rawText: raw.text });
        }
        if (result.cited) citedCount++;
        try {
          await saveResultRow(buildDbRow(result));
        } catch { /* one failed save shouldn't abort the whole run */ }
        completed++;
      }
      await updateJob(jobsStore, jobKey, { completed, cited: citedCount });
    }

    for (let i = startIndex; i < prompts.length; i += CONCURRENCY) {
      const chunk = prompts.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((p, j) => processPrompt(p, i + j)));
      if (i + CONCURRENCY < prompts.length) await sleep(1200);
    }

    await updateJob(jobsStore, jobKey, { status: 'done', finishedAt: new Date().toISOString() });
  } catch (err) {
    await updateJob(jobsStore, jobKey, { status: 'error', message: err.message, finishedAt: new Date().toISOString() });
  }

  return new Response(JSON.stringify({ status: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
