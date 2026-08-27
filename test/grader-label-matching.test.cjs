// "ERROR (grading): missing from grader response" meant the grading call succeeded and its result was
// then discarded because the engine label did not match by exact string. The work was done and paid
// for; only the lookup failed. These assertions pin the matching so a casing or naming variation
// cannot throw a grade away again.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('netlify/functions/run-audit-background.js', 'utf8');
const start = src.indexOf('function parseClassifyResponse(');
const end = src.indexOf('\n}', src.indexOf('return byEngine;', start)) + 2;
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);
const parse = ctx.parseClassifyResponse;

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + detail));
  if (!cond) failures++;
};

const resp = engines => ({ content: [{ type: 'text', text: JSON.stringify({ engines }) }] });
const j = (engine, extra = {}) => ({ engine, brand_cited: true, sentiment: 'positive', ...extra });

// The exact case that was failing in production.
let out = parse(resp([j('claude'), j('chatgpt')]), ['Claude', 'ChatGPT']);
check('lowercase labels still match their engines', !!out.Claude && !!out.ChatGPT, JSON.stringify(out));

out = parse(resp([j('CLAUDE'), j('ChatGPT ')]), ['Claude', 'ChatGPT']);
check('uppercase and trailing whitespace match', !!out.Claude && !!out.ChatGPT, JSON.stringify(out));

out = parse(resp([j('Claude'), j('ChatGPT')]), ['Claude', 'ChatGPT']);
check('exact labels still work', !!out.Claude && !!out.ChatGPT);

// A grader that renames an engine entirely: full set returned, so position is safe.
out = parse(resp([j('Claude'), j('GPT-5.5')]), ['Claude', 'ChatGPT']);
check('an unrecognised label is rescued by position when the set is complete',
  !!out.Claude && !!out.ChatGPT, JSON.stringify(out));

// A grade must never be attributed to the wrong engine when the set is INCOMPLETE.
out = parse(resp([j('Something Else')]), ['Claude', 'ChatGPT']);
check('a single unmatched entry is NOT guessed onto two engines',
  !out.Claude && !out.ChatGPT, JSON.stringify(out));

// Partial: one recognised, one missing entirely — the missing one stays missing.
out = parse(resp([j('Claude')]), ['Claude', 'ChatGPT']);
check('a genuinely absent engine stays absent', !!out.Claude && !out.ChatGPT, JSON.stringify(out));

// Duplicates must not overwrite or double-assign.
out = parse(resp([j('claude', { sentiment: 'first' }), j('Claude', { sentiment: 'second' })]), ['Claude']);
check('a duplicate label does not clobber the first match', out.Claude.sentiment === 'first', JSON.stringify(out));

// Degenerate inputs must not throw.
check('empty engines array yields no grades', Object.keys(parse(resp([]), ['Claude'])).length === 0);
check('missing expected list does not throw', typeof parse(resp([j('Claude')])) === 'object');

// Three engines, all mislabelled but complete — position covers it.
out = parse(resp([j('a'), j('b'), j('c')]), ['Claude', 'ChatGPT', 'Gemini']);
check('three mislabelled entries map positionally', !!out.Claude && !!out.ChatGPT && !!out.Gemini);

console.log(failures ? '\n' + failures + ' FAILING' : '\nall green');
process.exit(failures ? 1 : 0);
