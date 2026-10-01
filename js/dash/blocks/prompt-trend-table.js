/* Per-prompt statistics for the latest run, expandable to the raw answers.
 *
 * The monitoring counterpart of promptTable: same statistics, but each stored answer can also be
 * compared against the same engine's answer from an earlier run — which only exists here, because
 * only monitoring has earlier runs to compare against.
 *
 * Both the expand toggle and the compare button call page-level globals from generated markup, so
 * the page mounting this block must still expose toggleResponses() and openCompare().
 */
AkoreBlocks.define('promptTrendTable', {
  render(ctx) {
    const { rows, t, esc, promptMap, doc,
            INTENT_LABEL, intentLabel, statusChip, mdLite, nextRespId, answerHistory } = ctx;
    const frag = doc.createDocumentFragment();

    if (rows.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = t('noMatchFilterPrompts');
      frag.appendChild(empty);
      return frag;
    }

    const byIntent = {};
    rows.forEach(r => { (byIntent[r.query_intent] = byIntent[r.query_intent] || []).push(r); });
    const order = Object.keys(INTENT_LABEL).filter(k => byIntent[k]);
    Object.keys(byIntent).forEach(k => { if (!order.includes(k)) order.push(k); });

    order.forEach(intent => {
      const irows = byIntent[intent]; const byPrompt = {};
      irows.forEach(r => { (byPrompt[r.prompt_id] = byPrompt[r.prompt_id] || []).push(r); });
      const pids = Object.keys(byPrompt).sort();
      const sec = doc.createElement('div'); sec.className = 'pcat';
      sec.innerHTML = `<div class="pcat-h"><span class="q">${intentLabel(intent)}</span><span class="n">${t('promptsCountLine', pids.length, irows.length)}</span></div>`;
      const hd = doc.createElement('div'); hd.className = 'prow hd';
      hd.innerHTML = `<div>${t('prowId')}</div><div>${t('prowPrompt')}</div><div class="m">${t('prowCitationRate')}</div><div class="m">${t('prowAvgPos')}</div><div class="m">${t('prowSentiment')}</div><div class="m">${t('prowResponses')}</div>`;
      sec.appendChild(hd);
      pids.forEach(pid => {
        const pr = byPrompt[pid]; const n = pr.length;
        const cited = pr.filter(r => r.brand_cited).length;
        const ranks = pr.filter(r => r.brand_citation_rank).map(r => r.brand_citation_rank);
        const avgRank = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length) : null;
        const sm = pr.filter(r => r.brand_mentioned && r.sentiment);
        const pos = sm.filter(r => r.sentiment === 'positive').length, neu = sm.filter(r => r.sentiment === 'neutral').length, neg = sm.filter(r => r.sentiment === 'negative').length;
        const citeRate = 100 * cited / n;
        let sentLabel, sentCls;
        if (sm.length === 0) { sentLabel = '—'; sentCls = ''; }
        else { const posShare = pos / sm.length; if (posShare >= 0.6) { sentLabel = t('sentGood'); sentCls = 'g'; } else if (posShare >= 0.35 || neg <= neu) { sentLabel = t('sentMixed'); sentCls = 'm'; } else { sentLabel = t('sentPoor'); sentCls = 'b'; } }
        const respId = nextRespId();
        const row = doc.createElement('div'); row.className = 'prow';
        row.innerHTML =
          `<div class="code">${esc(pid)}</div><div class="txt">${esc(promptMap[pid] || '')}</div>` +
          `<div class="m" data-l="${t('prowCitationRate')}">${statusChip(citeRate)}<div class="ml">${cited}/${n}</div></div>` +
          `<div class="m" data-l="${t('prowAvgPos')}"><span class="mv">${avgRank ? ('#' + avgRank.toFixed(1)) : '—'}</span><div class="ml">${t('citesLabel', ranks.length)}</div></div>` +
          `<div class="m" data-l="${t('prowSentiment')}">${sentCls ? (`<span class="chip ${sentCls}">${sentLabel}</span>`) : '<span class="ml">—</span>'}</div>` +
          `<div class="m" data-l="${t('prowResponses')}"><button type="button" class="resp-toggle" onclick="toggleResponses('${respId}', this)">${t('viewResponsesBtn', n)}</button></div>`;
        sec.appendChild(row);

        const respPanel = doc.createElement('div');
        respPanel.className = 'presp';
        respPanel.id = respId;
        respPanel.style.display = 'none';
        respPanel.innerHTML = pr.map(r => {
          // Only offer the comparison when there is actually an earlier answer to compare against.
          const history = answerHistory(pid, r.engine);
          const canCompare = history.length > 1;
          return `
        <div class="presp-item">
          <div class="presp-meta">${esc(r.engine)} &middot; ${esc(r.snapshot_date)}${canCompare
            ? `<button type="button" class="cmp-btn" onclick="openCompare(this, '${esc(pid)}', '${esc(r.engine)}')">${t('compareDatesBtn')}</button>`
            : ''}</div>
          <div class="presp-text">${r.answer_excerpt ? mdLite(r.answer_excerpt) : t('noResponseCaptured')}</div>
          <div class="cmp" style="display:none;"></div>
        </div>`;
        }).join('');
        sec.appendChild(respPanel);
      });
      frag.appendChild(sec);
    });

    return frag;
  }
});
