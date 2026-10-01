'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const brands = require(path.join(__dirname, '..', 'js', 'brands.js'));
const { canonicalBrand, properCase, buildLeaderboard, COMPETITOR_ROW_LIMIT } = brands;

const row = (cited, top) => ({ brands_cited_list: cited.join(';'), top_cited_brand: top || '' });

test('canonicalBrand folds legal-entity and geography tails into one company', () => {
  const k = canonicalBrand('Bosch Rexroth');
  assert.equal(canonicalBrand('Bosch Rexroth México'), k);
  assert.equal(canonicalBrand('Bosch Rexroth S.A. de C.V.'), k);
  assert.equal(canonicalBrand('BOSCH REXROTH, S.A. DE C.V. MEXICO'), k);
});

test('canonicalBrand keeps meaningfully different names apart', () => {
  // The conservative rule this platform chose: a word that carries meaning is never stripped.
  assert.notEqual(canonicalBrand('Bosch'), canonicalBrand('Bosch Rexroth'));
  // ...which is also why "Parker" vs "Parker Hannifin" cannot be merged here. That is a
  // per-customer judgement and must come from configuration, not this function.
  assert.notEqual(canonicalBrand('Parker'), canonicalBrand('Parker Hannifin'));
});

test('canonicalBrand never collapses a name to nothing', () => {
  // "Grupo México" is entirely tail words, but it is a real company.
  assert.ok(canonicalBrand('Grupo México').length > 0);
  assert.ok(canonicalBrand('Mexico').length > 0);
});

test('properCase normalises engine spellings for display', () => {
  assert.equal(properCase('BOSCH rexroth'), 'Bosch Rexroth');
  assert.equal(properCase('  parker  '), 'Parker');
});

test('buildLeaderboard tallies citations, leads and share of voice', () => {
  const rows = [
    row(['Parker', 'SKF'], 'Parker'),
    row(['Parker', 'Northwind'], 'Parker'),
    row(['SKF'], 'SKF')
  ];
  const lb = buildLeaderboard(rows, 'Northwind');
  const byName = Object.fromEntries(lb.brands.map(b => [b.name, b]));

  assert.equal(lb.totalCitations, 5);
  assert.equal(byName.Parker.cited, 2);
  assert.equal(byName.Parker.leader, 2);
  assert.equal(byName.Skf.cited, 2);
  assert.equal(byName.Northwind.cited, 1);
  assert.equal(Math.round(byName.Parker.sov), 40);
  assert.equal(lb.brands[0].name, 'Parker', 'sorted by citations, most cited first');
});

test('buildLeaderboard merges spelling variants and labels with the most-cited form', () => {
  const rows = [
    row(['Bosch Rexroth', 'Bosch Rexroth México', 'Bosch Rexroth']),
    row(['Bosch Rexroth S.A. de C.V.'])
  ];
  const lb = buildLeaderboard(rows, 'Northwind');
  assert.equal(lb.brands.length, 1, 'four spellings are one competitor');
  assert.equal(lb.brands[0].cited, 4);
  assert.equal(lb.brands[0].name, 'Bosch Rexroth', 'most-cited spelling wins the label');
});

test('buildLeaderboard reports the true field size and the client rank', () => {
  const rows = [row(['A', 'A', 'B', 'Northwind'])];
  const lb = buildLeaderboard(rows, 'Northwind');
  assert.equal(lb.brands.length, 3);
  assert.equal(lb.yourRank, 3, 'A leads with 2 cites; B and Northwind trail with 1 each');
  assert.equal(lb.you.name, 'Northwind');
});

test('the client keeps a row at its true rank even below the cut', () => {
  // 30 rivals each cited more than the client, so the client lands well outside the top 25.
  const list = [];
  for (let i = 0; i < 30; i++) for (let n = 0; n < 5; n++) list.push('Rival' + String(i).padStart(2, '0'));
  list.push('Northwind');
  const lb = buildLeaderboard([row(list)], 'Northwind');

  assert.equal(lb.brands.length, 31);
  assert.equal(lb.yourRank, 31, 'client really is last');
  const mine = lb.leaderRows.find(r => r.b.key === lb.youKey);
  assert.ok(mine, 'client is still drawn a row');
  assert.equal(mine.rank, 31, 'and it shows their real rank, not a renumbered one');
  assert.equal(lb.leaderRows.length, COMPETITOR_ROW_LIMIT + 1);
  assert.equal(lb.others.count, 30 - COMPETITOR_ROW_LIMIT, 'client is not folded into Others');
});

test('others folds everything below the cut', () => {
  const list = [];
  for (let i = 0; i < 40; i++) for (let n = 0; n < 40 - i; n++) list.push('B' + String(i).padStart(2, '0'));
  const lb = buildLeaderboard([row(list)], 'Nobody');
  assert.equal(lb.leaderRows.length, COMPETITOR_ROW_LIMIT);
  assert.equal(lb.others.count, 15);
  assert.equal(lb.others.cited, lb.brands.slice(COMPETITOR_ROW_LIMIT).reduce((s, b) => s + b.cited, 0));
});

test('empty input does not throw or divide by zero', () => {
  const lb = buildLeaderboard([], 'Northwind');
  assert.equal(lb.brands.length, 0);
  assert.equal(lb.totalCitations, 0);
  assert.equal(lb.maxCited, 1, 'guarded so a bar width never divides by zero');
  assert.equal(lb.yourRank, 0);
  assert.equal(lb.others, null);
});

test('both dashboards load the shared module and keep no private copy', () => {
  for (const page of ['dashboard-diagnostic.html', 'dashboard-monitoring.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.ok(html.includes('/js/brands.js'), page + ' loads the shared brand module');
    assert.ok(!/function canonicalBrand\s*\(/.test(html), page + ' has no private canonicalBrand');
    assert.ok(!/const BRAND_ENTITY_TAIL/.test(html), page + ' has no private tail regex');
  }
});
