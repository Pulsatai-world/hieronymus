/* The GEO Visibility Score, and the KPI definitions it is built from.
 *
 * Shared because the number has to be the same number everywhere it appears. The client portal's
 * home screen leads with this score and the diagnostic dashboard explains it; computing it twice
 * is how two screens one click apart end up disagreeing about the same company.
 *
 * Nothing here renders. The KPI entries carry translation *keys*, never text, so the same
 * definitions serve both languages and both pages.
 */
(function (global) {
  'use strict';
  const U = (typeof module !== 'undefined' && module.exports) ? require('./util.js') : global.AkoreDashUtil;
  const { sum, avg, pct, val, basisOf, clamp } = U;

  /* A few KPIs label their basis with translated text ("12 cites"), so the definitions are not
   * translation-free. Each page hands its own translator in once; the default returns the key so
   * the module is still usable, and testable, with no page attached. */
  let t = k => k;
  function setTranslator(fn) { if (typeof fn === 'function') t = fn; }

  const CATS = [
    { name: 'Visibility', ask: 'Do AI engines see you?', tkey: 'catVisibility', askKey: 'askVisibility' },
    { name: 'Competitiveness', ask: 'How do you stack up?', tkey: 'catCompetitiveness', askKey: 'askCompetitiveness' },
    { name: 'Quality & Trust', ask: 'Do they describe you well?', tkey: 'catQuality', askKey: 'askQuality' }
  ];

  const KPIS = [
    // Mention rate is shown as a card but excluded from the composite GEO score (inScore:false)
    // so adding it doesn't shift or double-count the score alongside the Recommendation rate.
    { cat: 'Visibility', name: 'Mention rate', tkey: 'kpiMentionRate', formulaKey: 'kpiMentionRateFormula', unit: '%', excludeBrand: true, inScore: false, fn: rs => pct(sum(rs, 'brand_mentioned'), rs.length) },
    { cat: 'Visibility', name: 'Citation rate', tkey: 'kpiCitationRate', formulaKey: 'kpiCitationRateFormula', unit: '%', excludeBrand: true, fn: rs => pct(sum(rs, 'brand_cited'), rs.length) },
    { cat: 'Visibility', name: 'Target-question coverage', tkey: 'kpiTargetCoverage', formulaKey: 'kpiTargetCoverageFormula', unit: '%', excludeBrand: true, fn: rs => { const q = new Set(rs.map(r => r.prompt_id)), c = new Set(rs.filter(r => r.brand_cited).map(r => r.prompt_id)); return pct(c.size, q.size); } },
    { cat: 'Visibility', name: 'Average citation position', tkey: 'kpiAvgCitationPosition', formulaKey: 'kpiAvgCitationPositionFormula', unit: 'rank', excludeBrand: true, fn: rs => { const v = rs.filter(r => r.brand_citation_rank).map(r => r.brand_citation_rank); return { value: v.length ? avg(v) : 0, basis: t('citesLabel', v.length) }; } },
    { cat: 'Competitiveness', name: 'Share of Voice', tkey: 'kpiShareOfVoice', formulaKey: 'kpiShareOfVoiceFormula', unit: '%', excludeBrand: true, fn: rs => pct(sum(rs, 'brand_cited'), sum(rs, 'total_brands_cited')) },
    { cat: 'Competitiveness', name: 'First-mention rate', tkey: 'kpiFirstMentionRate', formulaKey: 'kpiFirstMentionRateFormula', unit: '%', excludeBrand: true, fn: rs => pct(sum(rs, 'brand_is_leader'), rs.length) },
    { cat: 'Competitiveness', name: 'Answers ranking a competitor above you', tkey: 'kpiCompetitorAbove', formulaKey: 'kpiCompetitorAboveFormula', unit: '%', excludeBrand: true, fn: rs => { const c = rs.filter(r => r.brand_cited); return pct(c.filter(r => !r.brand_is_leader).length, c.length); } },
    { cat: 'Competitiveness', name: "Topic clusters you're mentioned in", tkey: 'kpiClustersCitedIn', formulaKey: 'kpiClustersCitedInFormula', unit: 'count', excludeBrand: true, fn: rs => { const cl = new Set(rs.filter(r => r.brand_mentioned).map(r => r.topic_cluster)); return { value: cl.size, basis: t('ofClustersBasis', new Set(rs.map(r => r.topic_cluster)).size) }; } },
    { cat: 'Quality & Trust', name: 'Positive sentiment', tkey: 'kpiPositiveSentiment', formulaKey: 'kpiPositiveSentimentFormula', unit: '%', fn: rs => { const m = rs.filter(r => r.brand_mentioned && r.sentiment); return pct(m.filter(r => r.sentiment === 'positive').length, m.length); } },
    { cat: 'Quality & Trust', name: 'Verified-fact accuracy', tkey: 'kpiVerifiedAccuracy', formulaKey: 'kpiVerifiedAccuracyFormula', unit: '%', fn: rs => {
        const m = rs.filter(r => r.brand_mentioned);
        let got = 0, assessed = 0;
        ['services_correct', 'location_correct', 'contact_correct'].forEach(k => m.forEach(r => { if (r[k] !== null) { assessed++; got += (r[k] || 0); } }));
        return pct(got, assessed);
      } },
    { cat: 'Quality & Trust', name: 'Answers flagged for review', tkey: 'kpiFlaggedForReview', formulaKey: 'kpiFlaggedForReviewFormula', unit: '%', fn: rs => { const m = rs.filter(r => r.brand_mentioned); return pct(sum(m, 'has_incorrect_claim'), m.length); } },
    { cat: 'Quality & Trust', name: 'Negative sentiment', tkey: 'kpiNegativeSentiment', formulaKey: 'kpiNegativeSentimentFormula', unit: '%', fn: rs => { const m = rs.filter(r => r.brand_mentioned && r.sentiment); return pct(m.filter(r => r.sentiment === 'negative').length, m.length); } },
    { cat: 'Quality & Trust', name: 'Answers linking to your site', tkey: 'kpiLinkingToSite', formulaKey: 'kpiLinkingToSiteFormula', unit: '%', fn: rs => { const m = rs.filter(r => r.brand_mentioned); return pct(sum(m, 'linked_to_site'), m.length); } }
  ];

  const GEO_WEIGHTS = { 'Visibility': 0.40, 'Competitiveness': 0.35, 'Quality & Trust': 0.25 };
  // KPIs where a LOWER raw value is better, so goodness = 100 − value.
  const LOWER_BETTER = ['kpiCompetitorAbove', 'kpiFlaggedForReview', 'kpiNegativeSentiment'];

  // Per-KPI "goodness" on a 0–100 scale, plus whether the KPI had any data (denominator > 0).
  //  · %-higher-better KPIs        → value
  //  · %-lower-better KPIs         → 100 − value
  //  · Average citation position   → clamp(100*(5 − rank)/4, 0, 100), and 0 if no citations
  //  · Topic clusters mentioned in → 100 * clustersMentionedIn / totalClusters
  function kpiGoodness(k, rows) {
    const inputRows = k.excludeBrand ? rows.filter(r => r.topic_cluster !== 'Brand') : rows;
    const o = k.fn(inputRows);
    const v = val(o);
    if (k.tkey === 'kpiAvgCitationPosition') {
      const nCites = inputRows.filter(r => r.brand_citation_rank).length;
      return { goodness: nCites ? clamp(100 * (5 - v) / 4, 0, 100) : 0, hasData: nCites > 0 };
    }
    if (k.tkey === 'kpiClustersCitedIn') {
      const total = new Set(inputRows.map(r => r.topic_cluster)).size;
      return { goodness: total ? 100 * v / total : 0, hasData: total > 0 };
    }
    // Percentage KPIs: the denominator is the number after '/' in pct()'s basis string.
    const d = parseInt((basisOf(o).split('/')[1] || '').trim(), 10);
    const goodness = LOWER_BETTER.includes(k.tkey) ? (100 - v) : v;
    return { goodness, hasData: d > 0 };
  }

  function computeGeoScore(rows) {
    const subs = {};
    CATS.forEach(C => {
      const good = KPIS.filter(k => k.cat === C.name && k.inScore !== false).map(k => kpiGoodness(k, rows)).filter(g => g.hasData);
      subs[C.name] = good.length ? avg(good.map(g => g.goodness)) : null;
    });
    let wsum = 0, acc = 0;
    CATS.forEach(C => { if (subs[C.name] != null) { const w = GEO_WEIGHTS[C.name]; wsum += w; acc += w * subs[C.name]; } });
    return { composite: wsum ? Math.round(acc / wsum) : null, subs };
  }

  const api = { CATS, KPIS, GEO_WEIGHTS, LOWER_BETTER, kpiGoodness, computeGeoScore, setTranslator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AkoreScore = api;
})(typeof window !== 'undefined' ? window : null);
