// Answers were stored truncated at 500 characters, so a 2-5 sentence reply arrived cut off and the
// dashboard had nothing more to show. And the prompts table only ever looked at the latest snapshot,
// so there was no way to see how an engine's answer changed. Both covered here.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const check = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '   -> ' + d)); if (!c) failures++; };

// ── Storage no longer clips a normal answer ──
const audit = fs.readFileSync('netlify/functions/run-audit-background.js', 'utf8');
const m = audit.match(/response: \(p\.rawText \|\| ''\)\.slice\(0, (\d+)\)/);
check('the stored excerpt limit is discoverable', !!m, 'slice not found');
check('a 2-5 sentence answer fits inside the limit', m && Number(m[1]) >= 2000, m && m[1]);

// ── answerHistory: the data side of the comparison ──
const dash = fs.readFileSync('dashboard-monitoring.html', 'utf8');
const start = dash.indexOf('function answerHistory(');
const end = dash.indexOf('\n}', start) + 2;
const ctx = { console, TAPE: [] };
vm.createContext(ctx);
vm.runInContext(dash.slice(start, end), ctx);

const row = (date, engine, text, extra = {}) => ({
  prompt_id: 'Q01', engine, snapshot_date: date, answer_excerpt: text, sentiment: 'positive', ...extra,
});

ctx.TAPE = [
  row('2026-08-01', 'Claude', 'August answer'),
  row('2026-06-01', 'Claude', 'June answer'),
  row('2026-07-01', 'Claude', 'July answer'),
  row('2026-07-01', 'ChatGPT', 'ChatGPT July'),
  row('2026-07-01', 'Claude', '', { answer_excerpt: '' }),                 // nothing captured
  row('2026-05-01', 'Claude', 'failed', { sentiment: 'error' }),           // failed measurement
  { prompt_id: 'Q02', engine: 'Claude', snapshot_date: '2026-07-01', answer_excerpt: 'other prompt', sentiment: 'positive' },
];

let h = ctx.answerHistory('Q01', 'Claude');
check('history is scoped to one prompt and one engine',
  h.every(r => r.prompt_id === 'Q01' && r.engine === 'Claude'), JSON.stringify(h.map(r => r.engine)));
check('history is oldest-first so "now" is last',
  h.map(r => r.snapshot_date).join(',') === '2026-06-01,2026-07-01,2026-08-01', h.map(r => r.snapshot_date).join(','));
check('an error row is not offered as a past answer', !h.some(r => r.sentiment === 'error'));
check('a row with no captured answer is skipped', !h.some(r => !r.answer_excerpt));
check("another prompt's answers are excluded", !h.some(r => r.answer_excerpt === 'other prompt'));
check("another engine's answers are excluded", !h.some(r => r.answer_excerpt === 'ChatGPT July'));

// A single run must not offer a comparison against itself.
ctx.TAPE = [row('2026-08-01', 'Claude', 'only answer')];
check('one run yields a history of one (comparison suppressed)', ctx.answerHistory('Q01', 'Claude').length === 1);

// No data must not throw.
ctx.TAPE = [];
check('empty data yields an empty history', ctx.answerHistory('Q01', 'Claude').length === 0);

// ── The UI wiring must exist, or the data work is invisible ──
check('the compare button is rendered per response', /class="cmp-btn"[^>]*onclick="openCompare/.test(dash));
check('it is only offered when there is an earlier answer', /canCompare\s*=\s*history\.length > 1/.test(dash));
check('a date picker is built from the earlier runs', /class="cmp-pick"/.test(dash));
check('both sides show whether the brand was recommended', /compareCited/.test(dash) && /compareNotCited/.test(dash));
check('the comparison collapses on a second click', /host\.style\.display = 'none'; host\.innerHTML = ''/.test(dash));

console.log(failures ? '\n' + failures + ' FAILING' : '\nall green');
process.exit(failures ? 1 : 0);
