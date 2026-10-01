/* Shared brand identity + competitor leaderboard model.
 *
 * This lived twice — once in dashboard-diagnostic.html and once in dashboard-monitoring.html, with
 * a comment in each asking the next person to keep them in sync by hand. They did not always stay
 * in sync, and every per-customer refinement would have had to be written (and fixed) twice. The
 * pure-data half of the leaderboard now lives here; the two pages keep their own rendering, which
 * is genuinely different between a point-in-time snapshot and a trend.
 *
 * Nothing here touches the DOM, translations, or page globals, so it is also directly testable.
 */
(function (global) {
  'use strict';

  function properCase(s) {
    return String(s || '').trim().toLowerCase().replace(/\p{L}+/gu, w => w[0].toUpperCase() + w.slice(1));
  }

  // Engines name the same company inconsistently — "Bosch Rexroth", "Bosch Rexroth México" and
  // "Bosch Rexroth S.A. de C.V." are one competitor. Counting them separately splits that company's
  // share of voice across several rows and pushes it down the leaderboard, which also inflates the
  // client's own relative position. Only legal-entity and geography tails are stripped, never a word
  // that carries meaning: "Bosch" and "Bosch Rexroth" remain different companies, as they should.
  //
  // That conservatism is deliberate and is also this function's limit: it cannot know that "Parker"
  // and "Parker Hannifin" are one company while "Bosch" and "Bosch Rexroth" are two. That judgement
  // is per-customer and belongs in configuration, not in a regex.
  const BRAND_ENTITY_TAIL = /\b(s\s?a(\s+de\s+c\s?v)?|s\s+de\s+r\s?l(\s+de\s+c\s?v)?|sapi|inc|incorporated|llc|ltd|limited|gmbh|srl|corp|corporation|company|co|group|grupo|holding|holdings)\b/g;
  const BRAND_GEO_TAIL = /\b(de\s+)?(mexico|mx|mex|latinoamerica|latam|usa|us|espana|colombia|peru|chile|argentina|brasil|brazil|international|global|worldwide)\b/g;

  function canonicalBrand(name) {
    const raw = String(name || '').trim();
    let out = raw.toLowerCase()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[.,()]/g, ' ')
      .replace(/&/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Looped because one name can carry several tails ("... S.A. de C.V. México").
    for (let i = 0; i < 3; i++) {
      const before = out;
      out = out.replace(BRAND_ENTITY_TAIL, ' ').replace(BRAND_GEO_TAIL, ' ').replace(/\s+/g, ' ').trim();
      if (out === before) break;
    }
    // Never collapse a name to nothing: a company actually called "Grupo México" keeps its identity.
    return out || raw.toLowerCase();
  }

  // A long tail of one-off brand mentions made the leaderboard unreadable, so only this many brands
  // get their own row — everything below folds into a single "Others" line.
  const COMPETITOR_ROW_LIMIT = 25;

  /* Turn result rows into the ranked leaderboard both dashboards draw.
   *
   * Returns { brands, maxCited, you, yourRank, topRival, leaderRows, others, totalCitations },
   * where `brands` is every distinct brand (so "#N of M" reports the true field size, not the
   * number of visible rows) and `leaderRows` is what to draw.
   */
  function buildLeaderboard(rows, company, opts) {
    const rowLimit = (opts && opts.rowLimit) || COMPETITOR_ROW_LIMIT;
    const YOU = company;
    const youKey = canonicalBrand(YOU);
    const tally = {};
    let totalCitations = 0;

    const add = (name, field) => {
      const k = canonicalBrand(name);
      tally[k] = tally[k] || { variants: {}, cited: 0, leader: 0 };
      const v = properCase(name);
      tally[k].variants[v] = (tally[k].variants[v] || 0) + 1;
      tally[k][field]++;
    };

    rows.forEach(r => {
      (r.brands_cited_list || '').split(';').filter(Boolean).forEach(b => { add(b, 'cited'); totalCitations++; });
      if (r.top_cited_brand) add(r.top_cited_brand, 'leader');
    });

    const brands = Object.keys(tally).map(k => ({
      key: k,
      // Most-cited spelling wins the label; ties break toward the shorter name.
      name: Object.keys(tally[k].variants).sort((a, b) =>
        (tally[k].variants[b] - tally[k].variants[a]) || (a.length - b.length))[0] || k,
      cited: tally[k].cited,
      leader: tally[k].leader,
      sov: totalCitations ? 100 * tally[k].cited / totalCitations : 0
    })).sort((a, b) => b.cited - a.cited);

    const maxCited = Math.max(...brands.map(b => b.cited), 1);
    const you = brands.find(b => b.key === youKey) || { name: YOU, cited: 0, leader: 0, sov: 0 };
    const yourRank = brands.findIndex(b => b.key === youKey) + 1;
    const topRival = brands.find(b => b.key !== youKey);

    // Two deliberate exceptions to the cut: the client's own brand always keeps a row, showing its
    // real rank, even when it places below the cut — a client should never be missing from their own
    // leaderboard. And the summary cards still count every distinct brand.
    const leaderRows = brands.slice(0, rowLimit).map((b, i) => ({ b, rank: i + 1 }));
    const tail = brands.slice(rowLimit);
    const youInTail = tail.find(b => b.key === youKey);
    if (youInTail) leaderRows.push({ b: youInTail, rank: yourRank });
    const folded = tail.filter(b => b !== youInTail);
    const others = folded.length ? {
      count: folded.length,
      cited: folded.reduce((s, b) => s + b.cited, 0),
      leader: folded.reduce((s, b) => s + b.leader, 0),
      sov: folded.reduce((s, b) => s + b.sov, 0)
    } : null;

    return { brands, maxCited, you, youKey, yourRank, topRival, leaderRows, others, totalCitations, rowLimit };
  }

  const api = { properCase, canonicalBrand, buildLeaderboard, COMPETITOR_ROW_LIMIT };

  // Browser (both dashboards) and Node (tests) load this the same way.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AkoreBrands = api;
})(typeof window !== 'undefined' ? window : null);
