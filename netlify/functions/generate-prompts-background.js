import { getStore } from '@netlify/blobs';

// Generating a large prompt set (e.g. 100 prompts, especially split across languages) is a
// single long Claude call that can run past a regular Netlify Function's ~10-26s execution
// limit, which was surfacing as a 504 from Netlify's own gateway (the function was still
// working, the client just gave up waiting). Converted to a Background Function (note the
// -background filename) for the same reason run-audit-background.js is one — it gets a much
// longer execution window. The HTTP response here resolves quickly regardless of how long the
// work takes, so callers must NOT await it for completion; poll /api/generate-job instead.

// ── Why this is a two-stage pipeline ──
// The first version handed Claude the whole intake JSON (truncated to 12k chars) and asked for
// prompts. That produced unusable output: bare noun phrases with no intent ("empresa de
// manufactura hidráulica"), generic problems ("my machine broke"), no location, and — worst —
// prompts that stuffed in intake facts a searcher could not possibly know ("What is a company
// located in Toluca with 38 years of experience..."). The fix is to stop treating the intake as
// prompt material. Stage 1 distills it into a tight brief that separates what a *searcher* knows
// (category words, place names, failure symptoms, competitor names, job titles) from what only
// the *company* knows (years in business, awards, review counts, slogans) and marks the latter
// as forbidden. Stage 2 generates from the brief only, never from the raw intake.

const MODEL = 'claude-opus-5';

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

async function callClaude(apiKey, { prompt, maxTokens, effort, jsonSchema }) {
  const outputConfig = { effort };
  if (jsonSchema) outputConfig.format = { type: 'json_schema', schema: jsonSchema };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: outputConfig,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('Upstream non-JSON response: ' + rawText.slice(0, 200));
  }
  if (!res.ok) throw new Error(data.error?.message || 'Claude API error ' + res.status);
  // Safety classifiers can decline a request with a 200 + stop_reason "refusal" and an empty
  // content array, so this has to be checked before reading content.
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined this request (' + (data.stop_details?.category || 'unspecified') + ').');
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('Claude returned an empty response.');
  return text;
}

// ── Stage 1: the brief ──

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    whatTheySell: { type: 'string' },
    categoryTerms: { type: 'array', items: { type: 'string' } },
    location: {
      type: 'object',
      properties: {
        primaryCity: { type: 'string' },
        region: { type: 'string' },
        country: { type: 'string' },
        serviceArea: { type: 'array', items: { type: 'string' } },
        nearbyPlaces: { type: 'array', items: { type: 'string' } }
      },
      required: ['primaryCity', 'region', 'country', 'serviceArea', 'nearbyPlaces'],
      additionalProperties: false
    },
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { role: { type: 'string' }, situation: { type: 'string' }, priority: { type: 'string' } },
        required: ['role', 'situation', 'priority'],
        additionalProperties: false
      }
    },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { symptom: { type: 'string' }, whoNotices: { type: 'string' }, stakes: { type: 'string' } },
        required: ['symptom', 'whoNotices', 'stakes'],
        additionalProperties: false
      }
    },
    competitors: { type: 'array', items: { type: 'string' } },
    brandsAndEquipment: { type: 'array', items: { type: 'string' } },
    buyingTriggers: { type: 'array', items: { type: 'string' } },
    verbatimQuestions: { type: 'array', items: { type: 'string' } },
    forbiddenFacts: { type: 'array', items: { type: 'string' } },
    languageNotes: { type: 'string' }
  },
  required: [
    'whatTheySell', 'categoryTerms', 'location', 'personas', 'problems',
    'competitors', 'brandsAndEquipment', 'buyingTriggers', 'verbatimQuestions',
    'forbiddenFacts', 'languageNotes'
  ],
  additionalProperties: false
};

function buildBriefPrompt(company, intakeJson) {
  return `You are preparing a research brief that will be used to write realistic AI-search prompts — the kind of things real people actually type into ChatGPT, Claude, Perplexity or Google when they are looking for a business like this one.

Below is the raw intake questionnaire "${company}" filled out. It is written from the company's point of view and contains a lot of information a prospective customer would never know. Your job is to separate the two.

Extract:

- whatTheySell: one or two plain sentences. No marketing language. How a customer would describe it, not how the company describes itself.
- categoryTerms: the words real people use for this category — including informal, regional and equipment-level terms. NOT the company's preferred positioning language.
- location: the city, region and country they operate from, plus the places they actually serve and nearby places a customer might name instead. Read this out of the free-text answers (addresses, client stories, service-area mentions). Leave a field as an empty string only if the intake genuinely never says.
- personas: the specific job titles / roles who look for this, what situation they are in, and what they care most about. Use their real titles from the intake.
- problems: concrete, specific failure symptoms — what actually breaks, stalls, leaks, fails inspection, or costs money, described the way the person experiencing it would describe it. "The line stopped" is too vague; name the part, the behaviour and the consequence. Include who notices it first and what it costs them.
- competitors: named competitors, exactly as named.
- brandsAndEquipment: equipment, machine, software or component brands they work with or service — people search by these.
- buyingTriggers: the events that make someone start looking right now.
- verbatimQuestions: questions the intake says customers actually ask, copied close to verbatim. These are the most valuable input you can give me, so pull as many as the intake supports.
- forbiddenFacts: everything in this intake that a searcher could NOT know before finding the company, and would therefore never put in a query — years in business, employee counts, revenue, award names, client logos, review counts, internal slogans, certifications the buyer wouldn't think to ask about, founder biography. List them explicitly so they can be excluded.
- languageNotes: how this audience actually writes — language(s), formality, regional phrasing, whether they use accents and technical jargon.

Raw intake:
${intakeJson}`;
}

// ── Stage 2: per-category generation ──
// One Claude call per category rather than one big call for the whole set — gives real "N of 6
// done" progress to report to the UI, and lets each category carry its own worked examples
// without blowing up a single prompt.

const CATEGORIES = [
  {
    key: 'CAT1',
    brief: (company) => `Someone who already knows the name "${company}" and is checking them out — reputation, fit, capability, availability, price, contact.`,
    rules: (company) => `Name "${company}" in every prompt. Mix: bare reputation checks, capability questions ("do they work on X"), fit questions, availability/logistics, and price questions. Someone at this stage knows the name and maybe one thing they need — nothing else.`,
    good: (company) => [
      `${company} reviews`,
      `Is ${company} any good for walk-in cooler repair?`,
      `Does ${company} service Copeland compressors?`,
      `¿Alguien ha trabajado con ${company}? Necesito servicio en Guadalajara`,
      `${company} emergency service hours`,
      `How much does ${company} charge for a preventive maintenance contract?`
    ],
    bad: (company) => [
      `${company}, a company located in Guadalajara with 38 years of experience and ISO certification — what do they do? (nobody knows those facts before they find the company, so nobody types them)`,
      `${company} integral refrigeration solutions market leader (that is the company's own marketing copy, not a question a person asks)`
    ]
  },
  {
    key: 'CAT2',
    brief: () => 'Someone who does not know this company exists, searching for the category of thing they need.',
    rules: () => `Never name the client company. Every line must be an actual request — a question or an explicit ask — never a bare noun phrase. Roughly two thirds should carry a place: the city, the region, a nearby city, or "near me" / "cerca de mí". Include some price questions, some "who does X" questions, some urgency/availability questions, and some that name a specific brand or piece of equipment.`,
    good: () => [
      'Who repairs walk-in coolers in Guadalajara?',
      'Commercial refrigeration service near me open on Sundays',
      '¿Quién da servicio a cámaras de refrigeración en Zapopan?',
      'Best company for supermarket refrigeration maintenance in Jalisco',
      'How much does it cost to replace the compressor on a commercial freezer in Mexico?',
      'Necesito un técnico certificado para equipos Copeland en Guadalajara'
    ],
    bad: () => [
      'Commercial refrigeration company (a bare noun phrase — no intent, no question, no place; nobody types this into anything)',
      'Empresa de refrigeración comercial (same problem in Spanish — it is a category label, not a search)',
      'Industrial refrigeration solutions provider (vendor language, and still not a question)'
    ]
  },
  {
    key: 'CAT3',
    brief: () => 'Someone researching a problem they have not resolved — a recurring failure, a repair they keep paying for, a symptom they want to understand before they commit money. They are deliberating, not dispatching.',
    rules: () => `Never name the client company. Two things to get right here, because this category fails more than any other:

First, WHO this is. Someone whose line stopped five minutes ago picks up the phone — they do not open ChatGPT. The person actually typing is thinking ahead: the same part has failed three times, a quote looks wrong, they want to know what a job should cost or whether they are being sold the wrong fix. Write that person. Urgency is fine as context ("this has cost us two shifts this month"), never as the whole prompt.

Second, WHAT they know. They do not know the name of the service category or the kind of vendor they need — that is what they are searching for, so do not use it as the framing. But they absolutely know their own equipment and they will name it: "our 200-tonne press", "the injection moulding machine", the brand on the nameplate, their industry, their city. Writing "the system" or "the machine" as the subject is the single worst failure in this category — it makes the prompt untestable. Every prompt must carry the operation or equipment, the specific symptom from the brief, and the place.`,
    good: () => [
      'The compressor on our walk-in freezer keeps cutting out after about 20 minutes and the temperature climbs to 4°C before it kicks back on. Who can come look at it today in Guadalajara?',
      "We're throwing out product every week because the display cases won't hold below 8°C, and the technician we've been using keeps replacing the thermostat and charging us for it. What should we do?",
      'Se congela el evaporador de nuestra cámara cada dos o tres días y ya perdimos producto dos veces este mes. ¿A quién le puedo llamar en Zapopan?',
      'Health inspector flagged our cooler temperatures last visit and we have a re-inspection in two weeks — who can certify the equipment in Jalisco?'
    ],
    bad: () => [
      'My machine broke (no symptom, no equipment, no consequence, no place — this matches nothing and points nowhere)',
      'I have a problem with my equipment and need help (same problem, longer)',
      'Refrigeration problem in Guadalajara (a label, not a person describing their situation)',
      "The oil in the system is running hotter than normal and the cycles got very slow, we think the cooler isn't pulling anymore. Who can check it? (what system, on what machine, in what city? A floating symptom — reads like the middle of a conversation, and an engine answers it with generic troubleshooting and names nobody)",
      'I need someone at the plant today, the line is down (no equipment, no place, and this person would be phoning, not typing)',
      'How do I get a quote for a diagnostic? (a process question — answerable with generic advice, so no company ever gets named)'
    ]
  },
  {
    key: 'CAT4',
    brief: (company) => `Someone comparing "${company}" against named competitors, or looking for alternatives to a competitor.`,
    rules: (company) => `Use the real competitor names from the brief. Mix three shapes: head-to-head comparisons naming "${company}" and a competitor, "alternatives to <competitor>" searches that do not name ${company} at all, and questions about which to pick for a specific need. If the brief lists few or no competitors, use "other options besides <competitor>" and category-level comparisons rather than inventing company names. Always attach a real reason for the comparison — price, response time, a specific capability, a specific location.`,
    good: (company) => [
      `${company} vs Refrigeración Industrial Ramírez — who's better for supermarket chains?`,
      'Alternatives to Refrigeración Industrial Ramírez in Guadalajara',
      `¿Es mejor contratar a ${company} o a Servicios Térmicos del Norte para mantenimiento preventivo?`,
      'Who else besides Refrigeración Industrial Ramírez does 24-hour emergency refrigeration service in Jalisco?',
      `We're deciding between ${company} and Servicios Térmicos del Norte for an annual contract on eight stores. Which one handles multi-site better?`
    ],
    bad: (company) => [
      'Compare all refrigeration companies (nobody asks it this abstractly — comparisons are always between named options)',
      `${company} vs the competition (a placeholder, not a real query)`
    ]
  },
  {
    key: 'CAT5',
    brief: () => 'A specific buyer persona searching the way their role actually makes them search.',
    rules: () => `Use the real job titles from the brief, but treat the brief's "situation" text as background only — never as words to reuse. The role shows through what they say they need and the constraints they carry: downtime windows, sign-off, lead times, compliance, multi-site, invoicing. Write in first person where it reads naturally.

Do not open with the job title as a label ("As the purchasing lead…", "Como responsable de mantenimiento…"). A real person either introduces themselves with substance — role AND operation AND place, "Soy responsable de mantenimiento en una planta de inyección en Toluca" — or just states what they need. And never narrate internal process: "I'm raising the purchase order and they asked me to confirm stock first" is a message to a colleague, not a question for an AI. Convert the constraint into an actual ask: what they need, where, and under what conditions.`,
    good: () => [
      "I'm the maintenance manager at a food processing plant in Guadalajara and I need a refrigeration contractor who can work weekends without shutting the line down.",
      'As purchasing lead, what should I ask a refrigeration supplier before signing an annual maintenance contract?',
      'Soy dueño de un restaurante en Zapopan y necesito alguien de confianza para el mantenimiento de mis cámaras frías. ¿Cómo elijo?',
      'My plant director wants three quotes for refrigeration maintenance before the end of the quarter — who serves Jalisco at that scale?'
    ],
    bad: () => [
      'Persona: Plant Director. Query: refrigeration services (the persona label leaked into the query)',
      'Plant director looking for refrigeration company in Guadalajara (describing a persona in the third person instead of writing what they would type)',
      "I'm raising the purchase order and they asked me to confirm immediate stock of compressors before I issue it — who handles that inventory? (internal workflow narration, and \"that inventory\" points at something the reader cannot see. Ask for what you need instead: a supplier, in a named city, with stock)",
      'As the maintenance manager I have intermittent pressure faults and want to contract a diagnostic. How do I quote that? (job title bolted on the front, no equipment, no city, and "how do I quote that" gets a generic answer that names no company)'
    ]
  }
];

function renderBrief(brief) {
  const loc = brief.location || {};
  const lines = [
    `What they sell: ${brief.whatTheySell || '—'}`,
    `How people refer to this category: ${(brief.categoryTerms || []).join('; ') || '—'}`,
    `Based in: ${[loc.primaryCity, loc.region, loc.country].filter(Boolean).join(', ') || '—'}`,
    `Serves: ${(loc.serviceArea || []).join('; ') || '—'}`,
    `Nearby places a customer might name: ${(loc.nearbyPlaces || []).join('; ') || '—'}`,
    `Competitors: ${(brief.competitors || []).join('; ') || '—'}`,
    `Brands / equipment people search by: ${(brief.brandsAndEquipment || []).join('; ') || '—'}`,
    `What makes someone start looking: ${(brief.buyingTriggers || []).join('; ') || '—'}`,
    `How this audience writes: ${brief.languageNotes || '—'}`
  ];
  if ((brief.personas || []).length) {
    lines.push('Buyer personas:');
    brief.personas.forEach(p => lines.push(`  - ${p.role} — situation: ${p.situation} — cares most about: ${p.priority}`));
  }
  if ((brief.problems || []).length) {
    lines.push('Specific problems, in the customer\'s terms:');
    brief.problems.forEach(p => lines.push(`  - ${p.symptom} (noticed by: ${p.whoNotices}; costs them: ${p.stakes})`));
  }
  if ((brief.verbatimQuestions || []).length) {
    lines.push('Questions customers actually ask (near-verbatim — reuse this phrasing and register):');
    brief.verbatimQuestions.forEach(q => lines.push(`  - ${q}`));
  }
  if ((brief.forbiddenFacts || []).length) {
    lines.push('FACTS A SEARCHER COULD NOT KNOW — never put any of these in a prompt:');
    brief.forbiddenFacts.forEach(f => lines.push(`  - ${f}`));
  }
  return lines.join('\n');
}

function styleRules(languages, catKey) {
  const langList = languages.join(', ');
  const languageInstruction = languages.length > 1
    ? `Distribute the prompts evenly across these languages: ${langList}. Write each prompt entirely in its assigned language using natural native phrasing — a translated English sentence reads wrong. Keep the "${catKey}:" prefix in English exactly as shown.`
    : `Write every prompt in ${langList}, using natural native phrasing.`;

  return `HOW TO WRITE THEM

Write what a real person types, unprompted, when nobody is watching. Not a keyword. Not a category label. Not marketing copy. A person with a situation.

EVERY PROMPT MUST STAND ALONE. It is the first thing this person types into a brand-new chat, to an AI that knows nothing about them. So it has to carry its own context: what operation or equipment they are talking about, and where they are. A bare symptom with no subject and no place — "the oil is running hot and the cycles got slow, who can check it?" — is a fragment of a conversation, not a prompt anyone would ever send cold. Before you write each line, ask yourself: if this arrived with no prior messages, would the reader know what machine and what city we are talking about? If not, it is wrong. Name the thing. Name the place.

1. Write sentences, not keywords. This is a chat box, not a search box: "Servicio hidráulico en sitio fin de semana" is a Google query, and nobody types it into ChatGPT. Every prompt is at least one complete sentence; many are two or three. Vary the length within that range, but never drop to a bare keyword string.
2. Vary the shape: questions, statements of need, "who does X", "how much does X cost", "is X worth it", "I need someone who can...". Not every line should be a question — but every line must be something a person would send.
3. Ground them in the real world. Where it fits the category, name the place — the city, the region, a nearby city, or "near me" / "cerca de mí". Name real equipment, brands, quantities, timeframes and constraints from the brief. Specificity is what makes a prompt point somewhere.
4. Situational detail is good; stacked search filters are not. Don't chain three or more requirements into one query the way a spec sheet would ("certified, 24-hour, bilingual, ISO-compliant supplier in X with financing"). Real people describe their situation, then ask one thing.
5. NEVER include any fact a searcher could not know before finding the company: years in business, employee count, revenue, awards, review counts, client names, certifications the buyer wouldn't think to ask about, or founder history. A prompt like "What is the company in Toluca with 38 years of experience?" is nonsense — nobody searches that way.
6. No marketing or vendor language. No "soluciones integrales", "líder en", "world-class", "trusted provider". If it sounds like the company wrote it, it is wrong.
7. Do not invent facts. Only use places, brands, competitors, problems and roles that appear in the brief.
8. No two prompts should be paraphrases of each other. Different intent, different phrasing, different length.
9. A good answer to your prompt must be FORCED to name specific companies. If an engine could fully answer it with generic advice ("contact a supplier and ask for a quote", "check the thermostat first"), the prompt tests nothing — it produces an answer with no brands in it at all, which is worthless for this audit. Ask "who", "where can I get", "which company", "what are my options", "is X or Y better" — not "how do I quote this" or "who handles that".
10. The brief is BACKGROUND, not a script. Never quote or transcribe its wording. In particular: never open with a job-title label ("As the maintenance manager…", "Como responsable de mantenimiento…") — a real person introduces themselves with substance ("Soy responsable de mantenimiento en una planta de inyección en Toluca"), or not at all. And never narrate internal company process ("I'm raising the purchase order and they asked me to confirm…") — that is workflow only a colleague would follow.
11. Never use a demonstrative with nothing to point at. "ese inventario", "eso", "el sistema", "la máquina", "the equipment" — with no antecedent, the reader has no idea what you mean, because there is no earlier message. Name the actual thing every time.

${languageInstruction}

FORMATTING (this matters — output goes straight into a review UI)

- One prompt per line, each prefixed exactly "${catKey}: ".
- Start each prompt with a capital letter (in Spanish, capitalise the word after "¿").
- Correct spelling, correct accents and correct punctuation. No all-lowercase lines.
- No numbering, no bullets, no quotation marks around prompts, no emoji, no markdown, no commentary, no headers, no blank lines.`;
}

function buildCategoryPrompt(cat, company, brief, perCategory, languages) {
  const examplesGood = cat.good(company).map(e => `${cat.key}: ${e}`).join('\n');
  const examplesBad = cat.bad(company).map(e => e).join('\n');

  return `You are writing realistic AI-search prompts for a Generative Engine Optimization audit. These prompts get run against Claude, ChatGPT and Gemini to see whether "${company}" gets cited. If a prompt is not something a real person would genuinely type, it tests nothing and the whole audit is worthless.

RESEARCH BRIEF
${renderBrief(brief)}

THIS BATCH: ${cat.key}
${cat.brief(company)}

${cat.rules(company)}

${styleRules(languages, cat.key)}

WORKED EXAMPLES
These are from a completely unrelated business (a commercial refrigeration company in Guadalajara) and exist only to show the shape, length, register and output format I want. Never reuse their industry, city, company names, equipment or wording — write for "${company}" using the brief above.

GOOD — note the exact output format:
${examplesGood}

BAD — never write anything like these. The parenthetical says why, and must not appear in your output:
${examplesBad}

Now write exactly ${perCategory} ${cat.key} prompts. Output only the prompt lines, nothing else.`;
}

// ── Stage 3: cold validation ──
// Three rounds of tightening the generation instructions produced three new flavours of the same
// failure (keyword fragments, floating symptoms, internal-process narration), because instructions
// can only pre-empt failure modes already imagined. This pass verifies instead: it re-reads every
// candidate WITHOUT the brief, so it judges each line the way an engine receiving it cold would,
// and rewrites or drops whatever fails. Deliberately blind — a validator holding the brief would
// fill in the missing context itself and wave the prompt through.

const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'rewrite', 'drop'] },
          text: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['index', 'verdict', 'text', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['prompts'],
  additionalProperties: false
};

function buildValidationPrompt(candidates, company) {
  const numbered = candidates.map((c, i) => `${i}. ${c}`).join('\n');
  return `Below are candidate AI-search prompts written for a visibility audit of "${company}". They will be sent to Claude, ChatGPT and Gemini exactly as written, each one alone in a brand-new conversation with no other context.

Judge each one strictly, using ONLY what the line itself says. You do not have the client's background material, and that is deliberate: you are standing in for an engine receiving this cold. If you find yourself guessing what the writer meant, the prompt has already failed.

Four tests. A prompt must pass all four.

1. SELF-SUFFICIENT. Reading only this line, is it clear what is being asked about? Any demonstrative with nothing to point at — "ese inventario", "eso", "el sistema", "la máquina", "the equipment", "that inventory" — fails, because there is no earlier message for it to refer to. A symptom with no named equipment fails.
2. FORCES A RECOMMENDATION. Would a good answer HAVE to name specific companies, suppliers or brands? If the question can be fully answered with generic advice — "contact a supplier for a quote", "check the thermostat first", "here is how to request pricing" — it fails. An answer with no company in it teaches this audit nothing.
3. A REAL PERSON WOULD SEND THIS COLD. Not a Google keyword string ("Servicio hidráulico en sitio fin de semana"). Not a message to a colleague. Not internal workflow narration ("I'm raising the purchase order and they asked me to confirm…"). Not a job title bolted on the front ("As the maintenance manager…", "Como responsable de mantenimiento…"). Also: would this person really be typing into a chat box at all? Someone whose line stopped minutes ago is on the phone, not here.
4. CLEAN. Correct spelling, correct accents (Spanish especially — "hidraulico" must be "hidráulico"), starts with a capital letter, no stray numbering or quotes.

For each prompt return:
- verdict "keep" — passes all four. Return the text unchanged in "text".
- verdict "rewrite" — the intent is worth keeping but the execution fails. Return the fixed version in "text": same language, same underlying intent, minimum necessary change. You may only use facts already present in the line — if the missing piece is a city or a machine you were never told, you cannot invent it, so drop instead.
- verdict "drop" — unsalvageable, or a near-duplicate of an earlier prompt in this list. Return "" in "text".

Give a short "reason" for every non-keep verdict. Be strict: dropping a weak prompt costs nothing, keeping one corrupts the audit.

Candidates:
${numbered}`;
}

async function validateCategory(apiKey, catKey, candidates, company) {
  const raw = await callClaude(apiKey, {
    prompt: buildValidationPrompt(candidates, company),
    maxTokens: Math.min(16000, 4000 + candidates.length * 120),
    effort: 'medium',
    jsonSchema: VALIDATION_SCHEMA
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A validator that returns junk must not silently discard a whole category — fall back to the
    // unvalidated candidates rather than losing them.
    return { kept: candidates, dropped: 0, rewritten: 0, validatorFailed: true };
  }

  const kept = [];
  const judged = new Set();
  let dropped = 0, rewritten = 0;
  for (const v of (parsed.prompts || [])) {
    // Verdicts are only honoured for indices that actually exist in the candidate list, and only
    // once each. Without this, an entry the validator invented (or a stray duplicate) would be
    // accepted as a prompt on the strength of its own "text" field.
    const original = candidates[v.index];
    if (typeof original !== 'string' || judged.has(v.index)) continue;
    judged.add(v.index);

    if (v.verdict === 'drop') { dropped++; continue; }
    // On "keep" the original text is used, not the echoed copy — a keep verdict is permission to
    // pass through unchanged, not licence to alter it. Only "rewrite" may supply new text, and it
    // still has to survive the same formatting pass an original does.
    const text = cleanPrompt(v.verdict === 'rewrite' ? (v.text || '') : original);
    if (!text) { dropped++; continue; }
    if (v.verdict === 'rewrite') rewritten++;
    kept.push(text);
  }

  // A truncated or lazy response that judged only a handful of candidates would otherwise silently
  // discard the rest. Treat that as a validator failure and fall back to the unvalidated set rather
  // than throwing most of a category away.
  if (judged.size < Math.ceil(candidates.length / 2)) {
    return { kept: candidates, dropped: 0, rewritten: 0, validatorFailed: true };
  }
  // Anything the validator simply never mentioned has not passed, so it does not ship.
  dropped += candidates.length - judged.size;
  return { kept, dropped, rewritten, validatorFailed: false };
}

// ── Cleanup ──
// Formatting is enforced in code rather than trusted to the model: capitalisation, stray list
// markers and near-duplicates were all showing up in real output, and a deterministic pass is
// cheaper and more reliable than another round trip.

const LABEL_PREFIX = /^(?:prompt|query|search|ejemplo|pregunta|prompt\s*\d+)\s*[:\-–]\s*/i;
const LIST_PREFIX = /^(?:[-*•–—]\s*|\d+\s*[.)]\s*)/;

// Facts a searcher can't know keep leaking back in via numbers, so they get a second gate here.
const FORBIDDEN_PATTERNS = [
  /\b\d{1,3}\s*(?:años|anos|years)\s+(?:de\s+experiencia|of\s+experience|in\s+business|en\s+el\s+mercado)/i,
  /\b(?:con|with)\s+\d{1,3}\s*(?:años|anos|years)\b/i,
  /\b\d{2,5}\s*(?:reseñas|resenas|reviews|empleados|employees|clientes\s+satisfechos)\b/i
];

function capitalizeFirst(text) {
  // Spanish opens questions and exclamations with ¿ / ¡, so the letter to capitalise is the
  // first actual letter, not necessarily index 0.
  const i = text.search(/[\p{L}\p{N}]/u);
  if (i === -1) return text;
  return text.slice(0, i) + text.charAt(i).toLocaleUpperCase() + text.slice(i + 1);
}

function cleanPrompt(line) {
  let text = String(line || '').trim();
  if (!text) return null;

  text = text.replace(LIST_PREFIX, '').trim();
  text = text.replace(LABEL_PREFIX, '').trim();
  // Models like to wrap example output in quotes or backticks.
  text = text.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '').trim();
  text = text.replace(/\s+/g, ' ');
  // Trailing separators are an artefact of list output, never part of a real query.
  text = text.replace(/[\s:;,–—-]+$/, '').trim();

  if (!text) return null;
  if (text.length < 8 || text.length > 320) return null;
  if (text.split(' ').length < 2) return null;
  if (FORBIDDEN_PATTERNS.some(re => re.test(text))) return null;

  return capitalizeFirst(text);
}

function dedupeKey(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseCategoryOutput(rawText, catKey, limit, seen) {
  const prefix = new RegExp('^' + catKey + '\\s*[:\\-–]\\s*', 'i');
  const out = [];
  for (const rawLine of String(rawText).split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    // The prefix may sit before or after a stray list marker.
    line = line.replace(LIST_PREFIX, '').trim();
    if (!prefix.test(line)) continue;
    const cleaned = cleanPrompt(line.replace(prefix, ''));
    if (!cleaned) continue;
    const key = dedupeKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(catKey + ': ' + cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Job progress ──

async function updateJob(store, key, patch) {
  const existing = (await store.get(key, { type: 'json' })) || {};
  await store.setJSON(key, { ...existing, ...patch });
}

// The five category calls run concurrently, so their progress writes can interleave and a
// read-modify-write could roll the counter backwards. Progress is cosmetic, so this just refuses
// to write a lower number rather than reaching for locking.
async function bumpProgress(store, key, completed) {
  const existing = (await store.get(key, { type: 'json' })) || {};
  if ((existing.completed || 0) >= completed) return;
  await store.setJSON(key, { ...existing, completed });
}

export default async (request, context) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
  const company = (body.company || '').trim();
  if (!company) return new Response('Missing company', { status: 400 });

  const jobKey = slugify(company);
  const jobsStore = getStore('hieronymus-generate-jobs');
  // One step for the brief, then a generate step and a validate step per category.
  const totalSteps = CATEGORIES.length * 2 + 1;
  await jobsStore.setJSON(jobKey, { status: 'running', company, startedAt: new Date().toISOString(), completed: 0, total: totalSteps });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Server is missing ANTHROPIC_API_KEY — set it in Netlify site environment variables.');

    const count = parseInt(body.count) || 100;
    const languages = Array.isArray(body.languages) && body.languages.length ? body.languages : ['English'];
    const engines = Array.isArray(body.engines) && body.engines.length ? body.engines : ['claude', 'chatgpt', 'gemini'];
    const perCategory = Math.max(1, Math.round(count / CATEGORIES.length));
    // Generate a surplus, because the cold-validation pass rejects a meaningful share. The requested
    // count is a commitment, not a target: if validation leaves a category short, more are generated
    // to fill the gap rather than shipping fewer than asked for. Quality is enforced by the validator
    // on every candidate including top-ups, so filling the gap does not mean lowering the bar.
    const requestPerCategory = Math.ceil(perCategory * 1.6) + 2;
    const MAX_TOPUP_ROUNDS = 3;

    const intakeStore = getStore('hieronymus-intake');
    const intakeRecord = await intakeStore.get(jobKey, { type: 'json' });
    if (!intakeRecord) throw new Error('No submitted intake found for this client yet.');

    let jsonText = JSON.stringify(intakeRecord.intake, null, 2);
    if (jsonText.length > 24000) jsonText = jsonText.slice(0, 24000) + '\n...(truncated)';

    // Stage 1 — distil the intake into a searcher's-eye brief.
    const briefText = await callClaude(apiKey, {
      prompt: buildBriefPrompt(company, jsonText),
      maxTokens: 8000,
      effort: 'high',
      jsonSchema: BRIEF_SCHEMA
    });
    let brief;
    try {
      brief = JSON.parse(briefText);
    } catch {
      throw new Error('Could not parse the research brief returned for this client.');
    }
    await updateJob(jobsStore, jobKey, { completed: 1 });

    // Stages 2 and 3 — generate then cold-validate, one chain per category, all five chains run
    // concurrently. Sequential Opus calls across eleven steps risked running long inside the
    // background function's window.
    let completed = 1;
    async function produceCategory(cat, want) {
      const maxTokens = Math.min(16000, 4000 + want * 70);
      const raw = await callClaude(apiKey, {
        prompt: buildCategoryPrompt(cat, company, brief, want, languages),
        maxTokens,
        effort: 'medium'
      });
      completed += 1;
      await bumpProgress(jobsStore, jobKey, completed);

      // Parse with a generous cap — the validator, not this step, decides what survives.
      const candidates = parseCategoryOutput(raw, cat.key, want, new Set())
        .map(l => l.replace(new RegExp('^' + cat.key + ':\\s*'), ''));
      const result = await validateCategory(apiKey, cat.key, candidates, company);
      completed += 1;
      await bumpProgress(jobsStore, jobKey, completed);
      return { cat, generated: candidates.length, ...result };
    }

    const perCategoryResults = await Promise.all(CATEGORIES.map(cat => produceCategory(cat, requestPerCategory)));

    // De-duplication is shared across categories so the same query can't appear twice under two
    // labels. Each category contributes at most perCategory prompts, but contributes fewer without
    // complaint when validation rejected that many.
    const seen = new Set();
    const byCat = {};
    CATEGORIES.forEach(cat => { byCat[cat.key] = []; });
    const stats = { requested: count, generated: 0, dropped: 0, rewritten: 0, topUpRounds: 0, validatorFailures: [], perCategory: {} };

    // Adds surviving prompts to a category up to its quota, skipping anything already used by an
    // earlier category so the same query can't appear twice under two labels.
    // Anything validated but over a category's quota is kept aside rather than thrown away: the
    // number the operator asked for is a total, so a surplus in one category can legitimately cover
    // a shortfall in another. Everything here has already passed the validator.
    const spare = {};
    CATEGORIES.forEach(cat => { spare[cat.key] = []; });
    function absorb(cat, kept) {
      for (const text of kept) {
        const key = dedupeKey(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (byCat[cat.key].length < perCategory) byCat[cat.key].push(cat.key + ': ' + text);
        else spare[cat.key].push(cat.key + ': ' + text);
      }
    }

    function tally(r) {
      stats.generated += r.generated;
      stats.dropped += r.dropped;
      stats.rewritten += r.rewritten;
      if (r.validatorFailed && !stats.validatorFailures.includes(r.cat.key)) stats.validatorFailures.push(r.cat.key);
    }

    perCategoryResults.forEach(r => { tally(r); absorb(r.cat, r.kept); });

    // Top up anything validation left short, rather than delivering fewer prompts than asked for.
    // Each round asks for double the gap, since some of what comes back will be rejected again.
    for (let round = 0; round < MAX_TOPUP_ROUNDS; round++) {
      const short = CATEGORIES.filter(cat => byCat[cat.key].length < perCategory);
      if (!short.length) break;
      stats.topUpRounds = round + 1;
      // Each top-up is two more Claude calls per short category; keep the progress total honest.
      const job = (await jobsStore.get(jobKey, { type: 'json' })) || {};
      await updateJob(jobsStore, jobKey, { total: (job.total || totalSteps) + short.length * 2 });
      const extra = await Promise.all(short.map(cat =>
        produceCategory(cat, (perCategory - byCat[cat.key].length) * 2 + 2)
      ));
      extra.forEach(r => { tally(r); absorb(r.cat, r.kept); });
    }

    // Final fill: if the per-category quotas still leave the total under what was asked for, draw on
    // the validated surplus, round-robin so the mix stays balanced rather than loading one category.
    let totalNow = CATEGORIES.reduce((n, cat) => n + byCat[cat.key].length, 0);
    let drained = true;
    while (totalNow < count && drained) {
      drained = false;
      for (const cat of CATEGORIES) {
        if (totalNow >= count) break;
        const next = spare[cat.key].shift();
        if (!next) continue;
        byCat[cat.key].push(next);
        totalNow++;
        drained = true;
      }
    }

    const lines = [];
    CATEGORIES.forEach(cat => {
      stats.perCategory[cat.key] = byCat[cat.key].length;
      lines.push(...byCat[cat.key]);
    });
    stats.kept = lines.length;
    stats.short = Math.max(0, count - stats.kept);
    stats.spareUnused = CATEGORIES.reduce((n, cat) => n + spare[cat.key].length, 0);
    if (!lines.length) throw new Error('No prompts survived validation — nothing usable was generated.');

    const promptsText = lines.join('\n');
    const promptsStore = getStore('hieronymus-prompts');
    // Written as a whole new record, which deliberately drops internalApprovedAt and approvedAt:
    // a regenerated set has never been reviewed, so it must go back through internal review before
    // the customer can see it. Do not carry either field forward from a previous record.
    // `stats` records what the validator rejected, so a set that lands well under the requested
    // count is visibly a filtering result rather than a silent failure.
    await promptsStore.setJSON(jobKey, { company, promptsText, generatedAt: new Date().toISOString(), languages, engines, brief, stats });

    await updateJob(jobsStore, jobKey, { status: 'done', finishedAt: new Date().toISOString() });
  } catch (err) {
    await updateJob(jobsStore, jobKey, { status: 'error', message: err.message, finishedAt: new Date().toISOString() });
  }

  return new Response(JSON.stringify({ status: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
