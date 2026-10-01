/* The KPI cards, grouped by category, each carrying its own sparkline across runs.
 *
 * A single run has nothing to trend, so the whole grid is replaced by an explanatory note rather
 * than drawing a dozen flat lines that look like stagnation instead of a missing second data point.
 */
AkoreBlocks.define('kpiTrendGrid', {
  render(ctx) {
    const { t, CATS, KPIS, CAT_ICONS, DATES, buildCard, doc } = ctx;

    if (DATES.length < 2) {
      const note = doc.createElement('div');
      note.className = 'empty';
      note.style.marginTop = '20px';
      note.innerHTML = t('onlyOneRun');
      return note;
    }

    const frag = doc.createDocumentFragment();
    CATS.forEach(C => {
      const catKpis = KPIS.filter(k => k.cat === C.name);
      const hasExcludeBrand = catKpis.some(k => k.excludeBrand);
      const sec = doc.createElement('div'); sec.className = 'cat';
      sec.innerHTML = `<div class="cat-h"><div class="cat-icon">${CAT_ICONS[C.name] || ''}</div><div class="cat-titles"><span class="q">${t(C.tkey)}</span><span class="ask">${t(C.askKey)}</span></div>${hasExcludeBrand ? `<span class="cat-note">${t('brandExcludedNote')}</span>` : ''}</div>`;
      const grid = doc.createElement('div'); grid.className = 'grid';
      catKpis.forEach(k => grid.appendChild(buildCard(k)));
      sec.appendChild(grid);
      frag.appendChild(sec);
    });
    return frag;
  }
});
