/* Recommendation rate per topic cluster.
 *
 * Returns null when the run contains none of the known clusters, which is why the surrounding
 * layout group must tolerate a missing child.
 */
AkoreBlocks.define('clusterBars', {
  render(ctx) {
    const { rows, t, esc, fmt, pct, sum, doc } = ctx;
    const CLUSTER_ORDER = ['Brand', 'Category', 'Problem', 'Competitor', 'Persona'];
    const CLUSTER_TKEY = { Brand: 'clusterBrand', Category: 'clusterCategory', Problem: 'clusterProblem', Competitor: 'clusterCompetitor', Persona: 'clusterPersona' };
    const clustersIn = CLUSTER_ORDER.filter(c => rows.some(r => r.topic_cluster === c));
    if (!clustersIn.length) return null;

    const clSec = doc.createElement('div'); clSec.className = 'cat';
    let clHtml = `<div class="cat-h"><div class="cat-titles"><span class="q">${t('clusterTitle')}</span><span class="ask">${t('clusterSub')}</span></div></div><div class="bars">`;
    clustersIn.forEach(c => {
      const cr = rows.filter(r => r.topic_cluster === c);
      const n = sum(cr, 'brand_cited'), d = cr.length;
      const p = pct(n, d);
      const label = t(CLUSTER_TKEY[c]);
      const tip = esc(t('clusterBarTooltip', label, p.value.toFixed(1), n, d));
      clHtml += `<div class="barrow" data-tip="${tip}"><div class="blabel">${label}</div>` +
        `<div class="bbar"><span style="width:${p.value.toFixed(1)}%"></span></div>` +
        `<div class="bval">${fmt(p.value, '%')}</div></div>`;
    });
    clHtml += `</div>`;
    clSec.innerHTML = clHtml;
    return clSec;
  }
});
