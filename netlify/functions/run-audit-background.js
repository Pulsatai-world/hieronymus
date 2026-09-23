import { getStore } from '@netlify/blobs';
import { requireStaff } from './lib/authorize.js';
import { createStaffSession } from './lib/session.js';

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
    call: (apiKey, body, signal) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal
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
    call: (apiKey, body, signal) => fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal
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
    call: (apiKey, body, signal) => fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal
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

// Node's fetch carries a 300-second headers timeout by default, so a wedged upstream request sits
// there for five minutes before it throws. In a background function with a ~15 minute budget three
// of those end the whole run, and everything it never reached gets written as an error row — which
// is how an audit "completes" with most rows unusable. Bound the wait instead.
// Answering and grading get different budgets, because they fail differently and cost differently.
//
// One setting of 90s × 4 retries meant a single wedged call could occupy SIX MINUTES before giving
// up. Under the old batch loop that held eleven finished prompts hostage, and it is also what made
// the run-length budget below unsafe: the handoff reserved four minutes for work that could take
// seven. Answers are the volume — three per prompt, usually quick, and a slow one is rarely worth
// waiting on. Grading is one call per prompt and the only thing that turns answers into data, so it
// keeps the longer window (adaptive thinking shares its token budget and it genuinely runs long),
// but fewer attempts.
const ANSWER_TIMEOUT_MS = 45 * 1000;
const ANSWER_RETRIES = 2;
const GRADE_TIMEOUT_MS = 90 * 1000;
const GRADE_RETRIES = 1;

// Kept for anything that does not say which it is.
const ENGINE_TIMEOUT_MS = ANSWER_TIMEOUT_MS;

async function callEngineWithRetry(def, apiKey, body, maxRetries = ANSWER_RETRIES, timeoutMs = ANSWER_TIMEOUT_MS) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await def.call(apiKey, body, AbortSignal.timeout(timeoutMs));
    } catch (err) {
      // Thrown fetch failures — timeouts, resets, DNS — were previously not retried at all: only
      // HTTP status codes were, so a single blip produced an error row on the first attempt.
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(timedOut
          ? `${def.name} timed out after ${Math.round(timeoutMs / 1000)}s — gave up after ${maxRetries} attempts`
          : `${def.name} request failed: ${err.message} — gave up after ${maxRetries} attempts`);
      }
      await sleep(Math.min(30, 3 * Math.pow(2, attempt)) * 1000);
      continue;
    }
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
// Grades are matched to engines by the label the grader puts in its `engine` field, and that used to
// be an exact string comparison against 'Claude' / 'ChatGPT' / 'Gemini'. A grader that answered
// 'claude' in lowercase — or 'GPT-5.5' instead of 'ChatGPT' — produced "missing from grader response"
// for every engine on that prompt: the answer was fetched, the grading was done, both were paid for,
// and the result was discarded on a case mismatch. Match case-insensitively, then fall back to
// position, which is safe only when the grader returned exactly one entry per engine (it is asked for
// one each, in order).
function parseClassifyResponse(data, expectedEngines) {
  const textBlock = data.content.find(b => b.type === 'text');
  const parsed = JSON.parse(textBlock.text);
  const entries = Array.isArray(parsed.engines) ? parsed.engines : [];
  const expected = Array.isArray(expectedEngines) ? expectedEngines : [];
  const norm = v => String(v || '').trim().toLowerCase();

  const byEngine = {};
  const unmatched = [];
  for (const e of entries) {
    const hit = expected.find(name => norm(name) === norm(e.engine) && !byEngine[name]);
    if (hit) byEngine[hit] = e;
    else unmatched.push(e);
  }

  // Positional rescue, only when nothing was dropped or duplicated — otherwise a grade could be
  // attributed to the wrong engine, which is worse than losing it.
  const missing = expected.filter(name => !byEngine[name]);
  if (missing.length && entries.length === expected.length && unmatched.length === missing.length) {
    missing.forEach((name, i) => { byEngine[name] = unmatched[i]; });
  }
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
    // Answers are asked for in 2-5 sentences, which routinely exceeds 500 characters — so the stored
    // excerpt was cutting real answers off mid-sentence, and the dashboard had nothing more to show.
    // 4000 is generous enough for any answer this pipeline asks for while keeping a row small.
    response: (p.rawText || '').slice(0, 4000), snapshotDate: p.snapshotDate,
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

// Rows are written straight to the store rather than POSTed back to this site's own /api/results.
// That HTTP hop existed when results were one shared CSV blob needing a single writer; each row has
// had its own key for a while, so the round trip bought nothing — and it forced POST /api/results to
// stay open to unauthenticated callers, which meant anyone could inject fabricated rows into any
// customer's dataset. Writing directly removes the hop, the failure mode, and the open endpoint.
function saveResultRow(row) {
  return getStore('hieronymus-results-rows').setJSON(row.run_id, row).catch(err => {
    console.error('SAVE_ROW_FAILED', JSON.stringify({ run_id: row.run_id, error: err.message }));
    throw err;
  });
}

// With CONCURRENCY=12, up to a dozen processPrompt() calls finish in parallel and each calls
// updateJob() independently. Unserialized, their get()s interleave before either setJSON()
// commits, so whichever write lands last clobbers whatever the other just set (e.g. status
// silently reverting to an earlier value) — a lost-update race, not just Blobs propagation lag.
// Serializing through a single queue makes each read-modify-write cycle atomic relative to the
// others. (saveResultRow needs no such queue: every row has its own key, so writes never collide.)
let jobUpdateQueue = Promise.resolve();
function updateJob(store, key, patch) {
  const run = async () => {
    const existing = (await store.get(key, { type: 'json' })) || {};
    const next = { ...existing, ...patch, seq: ((existing.seq || 0) + 1) };

    // Progress only ever moves forward. This is a read-modify-write, and at the platform's time
    // limit two invocations of the same run briefly overlap — each with its own write queue — so
    // one could read before the other's write and put a smaller `completed` back. That is what made
    // the bar jump backwards at a handoff.
    if (Number.isFinite(existing.completed) && Number.isFinite(next.completed)
        && next.completed < existing.completed) {
      next.completed = existing.completed;
    }

    // A heartbeat the reader can trust. "Stalled" used to mean the browser noticing a number had
    // not changed, which is indistinguishable from a chunk legitimately taking minutes; the server
    // is the only thing that knows the difference between quiet and dead.
    if (patch.completed !== undefined || patch.phase !== undefined) {
      next.lastProgressAt = new Date().toISOString();
    }
    await store.setJSON(key, next);
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
  // Staff only. This ran for anyone who could name a company: an anonymous POST spent that
  // customer's API key — dozens of calls, count chosen by the caller — and replaced their prompt
  // set or wiped their diagnostic rows. Every legitimate caller is one of our own pages; the
  // monthly cron signs itself in server-side for exactly this reason.
  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
  const denied = await requireStaff(new URL(request.url), body, json);
  if (denied) return denied;

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
  // A continuation is this same run picking itself up after the platform's time limit, so it must be
  // allowed past the in-flight guard — the job it "conflicts" with is itself. The guard still blocks
  // what it was built for: a second run started by hand while one is genuinely in progress, which
  // never carries this flag.
  const isContinuation = body.continuation === true && startIndex > 0;
  const existingJob = await jobsStore.get(jobKey, { type: 'json' });
  if (existingJob && existingJob.status === 'running' && !isContinuation) {
    return new Response(JSON.stringify({ status: 'error', message: 'An audit is already running for this customer.' }), {
      status: 409, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Mark as running immediately so a poll moments after triggering already sees 'running'.
  // A continuation must not reset the counters or the start time — it is the same run, and zeroing
  // them here would make the progress bar restart from nothing at every handoff.
  //
  // `seq` climbs on every write and never restarts, including across a fresh run. Blobs can answer
  // a read with an older version of a record, and the panel used to re-decide the whole state from
  // whatever each poll happened to return — so a stale read mid-run rendered "hasn't started", the
  // next read put it back, and the status appeared to flap. A reader that ignores anything older
  // than what it has already seen cannot be fooled that way.
  const nextSeq = ((existingJob && existingJob.seq) || 0) + 1;
  if (isContinuation && existingJob) {
    await jobsStore.setJSON(jobKey, { ...existingJob, status: 'running', message: '', seq: nextSeq, lastProgressAt: new Date().toISOString() });
  } else {
    // A resume is not a fresh run. Writing completed: 0 here — before the engine count is known and
    // the real baseline can be worked out — made a run picking up at prompt 18 announce zero
    // progress first, which is precisely what starting over looks like. Only a run that really does
    // begin at the first prompt claims zero; a resume leaves the field alone until it can be seeded
    // correctly a few lines below.
    const fromScratch = startIndex === 0;
    await jobsStore.setJSON(jobKey, {
      status: 'running', company, startedAt: new Date().toISOString(),
      ...(fromScratch ? { completed: 0, total: 0, cited: 0 } : {}),
      message: '', seq: nextSeq, lastProgressAt: new Date().toISOString()
    });
  }

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
    // Which engines to ask is a per-run decision made when Run Audit is clicked, so the request wins.
    // The engine list stored with the prompts is only a fallback, for the monthly cron (which sends
    // none) and for older records generated while that choice still lived in the generate step.
    const requestedEngines = Array.isArray(body.engines) && body.engines.length
      ? body.engines.map(e => String(e).toLowerCase())
      : null;
    const storedEngines = Array.isArray(promptsRecord.engines) && promptsRecord.engines.length
      ? promptsRecord.engines.map(e => String(e).toLowerCase())
      : null;
    const selectedEngines = requestedEngines || storedEngines;

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

    // total counts prompt×engine units, which on its own can't tell the UI which *prompt* to resume
    // from. Recording the shape of the run lets the status panel offer an exact resume point instead
    // of forcing a full re-run (and re-spending the API budget) whenever one stalls.
    // Progress is accounted for the WHOLE run, not this invocation. A run that continues itself past
    // the platform's time limit spans several invocations, and counting each from zero against a
    // shrinking total made the progress bar rewind at every handoff. Deriving the baseline from
    // startIndex keeps it exact without trusting the previous record, which the manual Resume button
    // deletes before re-triggering.
    const totalUnits = prompts.length * activeEngines.length;
    // startIndex covers everything below it; the skip list covers finished prompts above it.
    const skipCount = (Array.isArray(body.skip) ? body.skip : []).filter(Number.isInteger).length;
    const baseCompleted = (startIndex + skipCount) * activeEngines.length;
    const baseCited = isContinuation ? ((existingJob && existingJob.cited) || 0) : 0;
    await updateJob(jobsStore, jobKey, {
      total: totalUnits,
      promptsTotal: prompts.length,
      engineCount: activeEngines.length,
      startIndex,
      // Seeded with the work already done, so a resume does not read as a restart.
      //
      // The run genuinely picks up at startIndex — the loop starts there and existing rows are not
      // cleared — but `completed` was left at 0 until the FIRST prompt of the resumed segment
      // finished. For that whole window the panel showed "Prompt 0 of 100" at 0%, which is exactly
      // what starting over looks like, and then it jumped to the real figure. Nothing was being
      // re-run; the number just told you it was.
      completed: baseCompleted,
      cited: baseCited
    });

    // A fresh diagnostic run REPLACES the previous diagnosis instead of accumulating beside it.
    // Without this, re-running after regenerating prompts changes nothing on screen: the diagnostic
    // dashboard pins to the earliest snapshot_date it can find (BASELINE_DATE = DATES[0]), so the
    // old prompt set would keep being displayed forever. Clearing first also means the new run is
    // the only diagnostic snapshot, so it becomes that baseline.
    //
    // Two guards carry real weight:
    //  - Monitoring rows are never touched. They are the trend history the monitoring dashboard is
    //    built from, and wiping them would destroy months of snapshots. Rows with no run_type are
    //    treated as diagnostic, matching how the diagnostic dashboard itself filters them.
    //  - Skipped entirely on a resume (startIndex > 0). Those rows were written by this same run
    //    minutes ago; deleting them would throw away exactly the work being resumed.
    let clearedRows = 0;
    if (runType === 'diagnostic' && startIndex === 0) {
      const rowsStore = getStore('hieronymus-results-rows');
      const { blobs } = await rowsStore.list();
      const existing = await Promise.all(blobs.map(async b => ({ key: b.key, data: await rowsStore.get(b.key, { type: 'json' }) })));
      const stale = existing.filter(r => r.data && r.data.brand === company && r.data.run_type !== 'monitoring');
      await Promise.all(stale.map(r => rowsStore.delete(r.key)));
      clearedRows = stale.length;
      await updateJob(jobsStore, jobKey, { clearedRows, phase: 'clearing' });
    }

    let completed = 0, citedCount = 0, erroredCount = 0;

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
          const data = await callEngineWithRetry(claudeDef, claudeKey, classifyBody, GRADE_RETRIES, GRADE_TIMEOUT_MS);
          judgments = parseClassifyResponse(data, okEngines.map(e => e.def.name));
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
        if (result.error) erroredCount++;
        try {
          await saveResultRow(buildDbRow(result));
        } catch { /* one failed save shouldn't abort the whole run */ }
        completed++;
      }
      await updateJob(jobsStore, jobKey, { completed: baseCompleted + completed, cited: baseCited + citedCount, phase: 'running' });
    }

    // A Netlify Background Function is capped at roughly 15 minutes by the platform — that ceiling is
    // not ours to raise, so a long run (many prompts across several engines) cannot finish inside one
    // invocation no matter what timeout we set. Instead of dying at the ceiling and leaving the last
    // prompts unprocessed, the run hands off to a fresh invocation of itself, continuing from the
    // next unprocessed prompt. The same startIndex machinery the manual Resume button uses, only
    // automatic — so a run of any length completes without anyone watching it.
    //
    // The reserve is CALCULATED, not picked. It used to be a flat 11 minutes, which quietly assumed
    // the work already in flight would finish within four — while a single prompt could occupy
    // nearly seven on retries. A run could therefore start work at 10:59, sail past the ceiling and
    // be killed with no handoff at all, which is one of the ways a run "never reported".
    const PLATFORM_CAP_MS = 15 * 60 * 1000;
    const WORST_PROMPT_MS = ANSWER_TIMEOUT_MS * (ANSWER_RETRIES + 1)
                          + GRADE_TIMEOUT_MS * (GRADE_RETRIES + 1);
    const HANDOFF_RESERVE_MS = 60 * 1000;      // writing the record and firing the next invocation
    // Without this the worst case lands exactly ON the ceiling, which is not a reserve at all.
    const SAFETY_MARGIN_MS = 60 * 1000;
    const RUN_BUDGET_MS = PLATFORM_CAP_MS - WORST_PROMPT_MS - HANDOFF_RESERVE_MS - SAFETY_MARGIN_MS;
    const runStartedAt = Date.now();
    let handedOffAt = null;

    // ── A worker pool, not batches ──
    // This was `for (i += CONCURRENCY) { await Promise.all(chunk) }` — a barrier every 12 prompts,
    // so nothing in the next batch could start until the slowest prompt in the current one finished.
    // Eleven prompts sat idle behind one slow call, twelve times over, and wall-clock was the sum of
    // each batch's slowest prompt rather than the average.
    //
    // That is also what "stuck at exactly 22" was. Progress is written as each prompt lands, so the
    // number climbed to the batch's near-total and then froze there — not because reporting was
    // coarse, but because eleven workers had genuinely stopped and were waiting on the twelfth.
    //
    // Here CONCURRENCY prompts stay in flight continuously: a worker finishing picks up the next
    // index immediately, so a slow call costs only its own slot. Same calls, same pacing, no idling.
    const doneIdx = new Set();
    let nextIdx = startIndex;
    let outOfTime = false;

    // Prompts a previous invocation already finished ABOVE its resume point. Completion is out of
    // order in a pool — if prompt 0 is slow and 1-11 finish, the run can only resume from 0, and
    // without this the continuation would redo 1-11. The rows are keyed by a hash of
    // date|prompt|engine so redoing them overwrites rather than duplicates, but it is still a dozen
    // prompts' worth of API spend per handoff, paid for nothing.
    const skipIdx = new Set((Array.isArray(body.skip) ? body.skip : []).filter(Number.isInteger));

    async function worker() {
      while (true) {
        if (outOfTime) return;
        // Per prompt, not per batch — so the decision to stop is made with a reserve that actually
        // covers the work about to be started.
        if (nextIdx > startIndex && Date.now() - runStartedAt > RUN_BUDGET_MS) { outOfTime = true; return; }
        const i = nextIdx++;
        if (i >= prompts.length) return;
        if (skipIdx.has(i)) { doneIdx.add(i); continue; }
        // One prompt failing must not take the pool down with it. processPrompt guards its engine
        // calls, its grading and its row write, but the progress write at the end is unguarded — and
        // under Promise.all a single rejected worker aborts every other one still in flight.
        try {
          // processPrompt already writes progress as it finishes each prompt — a second write here
          // would just double the traffic to the job record for nothing.
          await processPrompt(prompts[i], i);
          doneIdx.add(i);
        } catch (err) {
          console.error('PROMPT_FAILED', JSON.stringify({ index: i, error: err && err.message }));
          // Deliberately not added to doneIdx: it becomes the resume point rather than being lost.
        }
      }
    }
    const workerCount = Math.max(1, Math.min(CONCURRENCY, prompts.length - startIndex));
    await Promise.all(Array.from({ length: workerCount }, worker));

    // Prompts finish out of order, so the resume point is the lowest index NOT completed — not
    // simply where the workers stopped handing out work. Resuming from anything higher would skip
    // a prompt that was still in flight when the clock ran out.
    let carryDone = [];
    if (outOfTime) {
      let resumeFrom = startIndex;
      while (doneIdx.has(resumeFrom)) resumeFrom++;
      if (resumeFrom < prompts.length) {
        handedOffAt = resumeFrom;
        // Everything finished above the resume point, so the next invocation does not redo it.
        carryDone = [...doneIdx].filter(i => i > resumeFrom).sort((a, b) => a - b);
      }
    }

    if (handedOffAt !== null) {
      const base = process.env.URL || process.env.DEPLOY_URL || '';
      await updateJob(jobsStore, jobKey, {
        status: 'running',
        continuedFrom: handedOffAt,
        continuations: ((await jobsStore.get(jobKey, { type: 'json' }))?.continuations || 0) + 1,
        message: ''
      });
      try {
        // The continuation is this run calling itself, and /api/run-audit is staff-only — so it
        // signs itself in, exactly as the monthly cron does. Without this the handoff was refused
        // and every run longer than the platform's time limit died here, at the 11-minute mark,
        // with the record still saying "running" because a 401 is a perfectly ordinary response
        // and never reached the catch below.
        const relaySession = await createStaffSession('system-continuation', 'admin');
        const res = await fetch(base + '/api/run-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company, startIndex: handedOffAt, skip: carryDone, engines: selectedEngines || undefined, run_type: runType, continuation: true, session: relaySession })
        });
        // A refused or failed handoff must not look like a successful one. fetch only throws on a
        // transport failure, so the status has to be checked or the job sits at "running" forever
        // with no invocation behind it.
        if (!res.ok) {
          throw new Error('the handoff was refused (HTTP ' + res.status + ')');
        }
      } catch (err) {
        // The handoff itself failed, so nothing else will pick this up. Say so plainly rather than
        // leaving a job that looks alive but has no invocation behind it.
        await updateJob(jobsStore, jobKey, {
          status: 'error',
          message: 'Could not continue past the platform time limit at prompt ' + (handedOffAt + 1) + ': ' + err.message,
          finishedAt: new Date().toISOString()
        });
      }
      return new Response(JSON.stringify({ status: 'continued', startIndex: handedOffAt }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // A run where every single row failed collected no data at all. Reporting that as 'done' is how
    // a failed monitoring run ended up on the trend as a month of zero visibility — it looked like a
    // completed measurement. Call it what it is, and record the counts either way so a partial
    // failure is visible without digging through the CSV.
    const totalRows = baseCompleted + completed;
    const allFailed = totalRows > 0 && erroredCount >= totalRows;
    await updateJob(jobsStore, jobKey, {
      status: allFailed ? 'error' : 'done',
      errored: erroredCount,
      message: allFailed
        ? 'Every row failed — no data was collected. Check the failure reasons below before trusting anything from this run.'
        : '',
      finishedAt: new Date().toISOString()
    });
  } catch (err) {
    await updateJob(jobsStore, jobKey, { status: 'error', message: err.message, finishedAt: new Date().toISOString() });
  }

  return new Response(JSON.stringify({ status: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
