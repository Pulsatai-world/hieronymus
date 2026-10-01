/* Citation rate and share of voice, one row per engine that answered.
 *
 * Brand-cluster rows are excluded for the same reason they are excluded from the headline KPIs: a
 * prompt that names the company is trivially "cited" and would flatter every engine equally.
 */
AkoreBlocks.define('perEngine', {
  render(ctx) {
    const { rows, t, esc, fmt, pct, sum, properCase, doc } = ctx;
    const enginesIn = [...new Set(rows.map(r => r.engine))].filter(Boolean).sort();
    const engSec = doc.createElement('div'); engSec.className = 'cat';
    let engHtml = `<div class="cat-h"><div class="cat-titles"><span class="q">${t('perEngineTitle')}</span><span class="ask">${t('perEngineSub')}</span></div></div>`;
    engHtml += `<div class="etbl"><div class="erow hd"><div>${t('perEngineEngine')}</div><div class="m">${t('kpiCitationRate')}</div><div class="m">${t('kpiShareOfVoice')}</div></div>`;
    enginesIn.forEach(e => {
      const er = rows.filter(r => r.engine === e && r.topic_cluster !== 'Brand');
      const cr = pct(sum(er, 'brand_cited'), er.length);
      const sv = pct(sum(er, 'brand_cited'), sum(er, 'total_brands_cited'));
      engHtml += `<div class="erow"><div class="ename">${esc(properCase(e))}</div>` +
        `<div class="m"><span class="mv">${fmt(cr.value, '%')}</span><div class="ml">${cr.basis}</div></div>` +
        `<div class="m"><span class="mv">${fmt(sv.value, '%')}</span><div class="ml">${sv.basis}</div></div></div>`;
    });
    engHtml += `</div>`;
    engSec.innerHTML = engHtml;
    return engSec;
  }
});
