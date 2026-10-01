/* Tone of the answers that mention the brand, as a donut.
 *
 * Only answers with an assessed tone count. Rows written as `sentiment: error` (a failed engine
 * call or a failed grading) are excluded rather than counted as neutral, because a measurement
 * that did not happen is not a neutral opinion.
 */
AkoreBlocks.define('sentimentDonut', {
  render(ctx) {
    const { rows, t, esc, doc } = ctx;
    const sm = rows.filter(r => r.brand_mentioned && ['positive', 'neutral', 'negative'].includes(r.sentiment));
    const sPos = sm.filter(r => r.sentiment === 'positive').length;
    const sNeu = sm.filter(r => r.sentiment === 'neutral').length;
    const sNeg = sm.filter(r => r.sentiment === 'negative').length;
    const sTot = sm.length;

    const sentSec = doc.createElement('div'); sentSec.className = 'cat sent-col';
    let sentHtml = `<div class="cat-h"><div class="cat-titles"><span class="q">${t('sentimentTitle')}</span><span class="ask">${t('sentimentSub')}</span></div></div>`;
    if (sTot === 0) { sentHtml += `<div class="empty">${t('sentimentNone')}</div>`; }
    else {
      const COL_POS = 'var(--emerald)', COL_NEU = 'var(--muted)', COL_NEG = 'var(--red, #c74b4b)';
      const R = 60, CIRC = 2 * Math.PI * R;
      let acc = 0;
      const arc = (n, color, label) => {
        if (!n) return '';
        const len = CIRC * n / sTot;
        const tip = esc(`${label}: ${n} · ${(100 * n / sTot).toFixed(0)}%`);
        const s = `<circle data-tip="${tip}" cx="80" cy="80" r="${R}" fill="none" stroke="${color}" stroke-width="24" stroke-dasharray="${len.toFixed(3)} ${(CIRC - len).toFixed(3)}" stroke-dashoffset="${(-acc).toFixed(3)}"/>`;
        acc += len;
        return s;
      };
      const litem = (label, n, color) => `<div class="sitem"><span class="sdot" style="background:${color}"></span><span class="slab">${label}</span><span class="snum">${n} · ${(100 * n / sTot).toFixed(0)}%</span></div>`;
      sentHtml += `<div class="donut-wrap">` +
        `<div class="donut"><svg viewBox="0 0 160 160" width="100%" height="100%" role="img" aria-label="${esc(t('sentimentTitle'))}">${arc(sPos, COL_POS, t('sentPositive'))}${arc(sNeu, COL_NEU, t('sentNeutral'))}${arc(sNeg, COL_NEG, t('sentNegative'))}</svg>` +
          `<div class="center"><div class="dt">${sTot}</div><div class="dl">${t('sentAssessed')}</div></div></div>` +
        `<div class="dlegend">${litem(t('sentPositive'), sPos, COL_POS)}${litem(t('sentNeutral'), sNeu, COL_NEU)}${litem(t('sentNegative'), sNeg, COL_NEG)}</div>` +
      `</div>`;
    }
    sentSec.innerHTML = sentHtml;
    return sentSec;
  }
});
