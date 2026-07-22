import { getStore } from '@netlify/blobs';

// Generating a large prompt set (e.g. 100 prompts, especially split across languages) is a
// single long Claude call that can run past a regular Netlify Function's ~10-26s execution
// limit, which was surfacing as a 504 from Netlify's own gateway (the function was still
// working, the client just gave up waiting). Converted to a Background Function (note the
// -background filename) for the same reason run-audit-background.js is one — it gets a much
// longer execution window. The HTTP response here resolves quickly regardless of how long the
// work takes, so callers must NOT await it for completion; poll /api/generate-job instead.

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

// One category per Claude call instead of one big call for the whole set — gives real
// "N of 5 done" progress to report to the UI (a single 100-prompt call has no natural
// checkpoint partway through), and each individual call is smaller/faster as a side benefit.
const CATEGORIES = [
  { key: 'CAT1', desc: (company) => `direct questions naming "${company}" (e.g. "who is X", "X reviews", "is X legit")` },
  { key: 'CAT2', desc: () => 'generic category/service searches that do NOT name any brand' },
  { key: 'CAT3', desc: () => 'a customer describing a problem or need, without naming any brand or category term' },
  { key: 'CAT4', desc: (company) => `comparisons between "${company}" and named competitors, or "alternatives to X"` },
  { key: 'CAT5', desc: () => 'searches phrased the way a specific buyer persona / job title would search' }
];

function buildCategoryPrompt(cat, company, businessContext, perCategory, languages) {
  const langList = languages.join(', ');
  const languageInstruction = languages.length > 1
    ? `Distribute the prompts evenly across these languages: ${langList}. Write each prompt's full text entirely in its assigned language, using natural native phrasing — but always keep the "${cat.key}:" prefix in English exactly as shown.`
    : `Write every prompt's text in ${langList}.`;
  return `You are helping audit how visible a business is to AI assistants (Claude, ChatGPT, Perplexity). Generate a realistic set of search/chat prompts that potential customers or AI assistants might use.

Business: "${company}"
${businessContext}

Generate exactly ${perCategory} prompts in this single category:
${cat.key}: ${cat.desc(company)}

${languageInstruction} Output ONLY the prompts, one per line, each prefixed exactly like "${cat.key}: <prompt text>". No numbering, no headers, no commentary, no markdown.`;
}

async function updateJob(store, key, patch) {
  const existing = (await store.get(key, { type: 'json' })) || {};
  await store.setJSON(key, { ...existing, ...patch });
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
  await jobsStore.setJSON(jobKey, { status: 'running', company, startedAt: new Date().toISOString(), completed: 0, total: CATEGORIES.length });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Server is missing ANTHROPIC_API_KEY — set it in Netlify site environment variables.');

    const count = parseInt(body.count) || 100;
    const languages = Array.isArray(body.languages) && body.languages.length ? body.languages : ['English'];
    const engines = Array.isArray(body.engines) && body.engines.length ? body.engines : ['claude', 'chatgpt', 'gemini'];
    const perCategory = Math.max(1, Math.round(count / CATEGORIES.length));

    const intakeStore = getStore('hieronymus-intake');
    const intakeRecord = await intakeStore.get(jobKey, { type: 'json' });
    if (!intakeRecord) throw new Error('No submitted intake found for this client yet.');

    let jsonText = JSON.stringify(intakeRecord.intake, null, 2);
    if (jsonText.length > 12000) jsonText = jsonText.slice(0, 12000) + '\n...(truncated)';
    const businessContext = `Full business intake answers (JSON, may be in English or Spanish):\n${jsonText}`;

    const categoryLines = [];
    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      const catPrompt = buildCategoryPrompt(cat, company, businessContext, perCategory, languages);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1536,
          messages: [{ role: 'user', content: catPrompt }]
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

      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) throw new Error(`Claude returned an empty response for ${cat.key}.`);
      categoryLines.push(text);

      await updateJob(jobsStore, jobKey, { completed: i + 1 });
    }

    const promptsText = categoryLines.join('\n');
    const promptsStore = getStore('hieronymus-prompts');
    await promptsStore.setJSON(jobKey, { company, promptsText, generatedAt: new Date().toISOString(), languages, engines });

    await updateJob(jobsStore, jobKey, { status: 'done', finishedAt: new Date().toISOString() });
  } catch (err) {
    await updateJob(jobsStore, jobKey, { status: 'error', message: err.message, finishedAt: new Date().toISOString() });
  }

  return new Response(JSON.stringify({ status: 'done' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
