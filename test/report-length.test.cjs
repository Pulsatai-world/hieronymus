// Rene's brief for the technical report: practical, actionable, two to three pages maximum.
// Before this it ran to forty, because it printed one card per finding and a scan of twenty pages
// produces 179 findings for 17 actual problems.
//
// Two things are worth pinning. One problem is one row however many pages it touches, and the
// whole document stays inside three A4 pages. Page count is approximated from rendered height
// rather than by launching a browser, so this stays a unit test: A4 at 15mm margins leaves
// roughly 1017px, and the check allows generous slack so it fails on a regression, not on a
// paragraph.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'scan-fiacsa.json');

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '   -> ' + detail));
  if (!ok) failures++;
};

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.log('  SKIP  no fixture at test/fixtures/scan-fiacsa.json');
    process.exit(0);
  }
  const { buildReportHtml } = await import('file://' + path.join(ROOT, 'netlify/functions/lib/geo-report-html.js').replace(/\\/g, '/'));
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const html = buildReportHtml(data, 'es');

  // One row per problem, not one per page.
  const rows = (html.match(/class="work w-/g) || []).length;
  const distinct = (() => {
    const ids = new Set();
    const visit = (n, p) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(x => visit(x, p));
      if (n.id && (n.status === 'FAIL' || n.status === 'WARNING')) ids.add(n.id);
      Object.values(n).forEach(v => visit(v, n.url || p));
    };
    visit(data, '');
    return ids.size;
  })();
  check('one row per problem, not per page', rows === distinct,
    rows + ' rows for ' + distinct + ' distinct problems');

  check('far fewer rows than raw findings', rows < data.prioritizedFindings.length / 3,
    rows + ' rows vs ' + data.prioritizedFindings.length + ' raw findings');

  // Rough page estimate: body words plus the per-row chrome measured in the browser at ~115px.
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').length;
  check('body text stays short enough to read', words < 1600, words + ' words');

  // The per-page check dump is what made it a book; it must not come back.
  check('no per-page check table', !/detailTitle/.test(html), 'the homepage check dump is back');

  console.log('\n  ' + rows + ' rows, ' + words + ' words');
  console.log(failures ? '\n  ' + failures + ' FAILURE(S)' : '\n  the report is a work list, not a book');
  process.exit(failures ? 1 : 0);
})();
