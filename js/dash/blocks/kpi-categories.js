/* The KPI grid, grouped into its categories (Visibility, Competitiveness, Quality & Trust).
 *
 * Contributes one section per category as siblings, with no wrapper of its own — hence the
 * fragment. Categories containing a brand-excluded KPI carry the note explaining the exclusion.
 */
AkoreBlocks.define('kpiCategories', {
  render(ctx) {
    const { rows, t, fmt, val, basisOf, CATS, KPIS, CAT_ICONS, doc } = ctx;
    const frag = doc.createDocumentFragment();

    CATS.forEach(C => {
      const catKpis = KPIS.filter(k => k.cat === C.name);
      const hasExcludeBrand = catKpis.some(k => k.excludeBrand);
      const sec = doc.createElement('div'); sec.className = 'cat';
      sec.innerHTML = `<div class="cat-h"><div class="cat-icon">${CAT_ICONS[C.name] || ''}</div><div class="cat-titles"><span class="q">${t(C.tkey)}</span><span class="ask">${t(C.askKey)}</span></div>${hasExcludeBrand ? `<span class="cat-note">${t('brandExcludedNote')}</span>` : ''}</div>`;
      const grid = doc.createElement('div'); grid.className = 'grid';
      catKpis.forEach(k => {
        const inputRows = k.excludeBrand ? rows.filter(r => r.topic_cluster !== 'Brand') : rows;
        const o = k.fn(inputRows); const v = val(o), b = basisOf(o);
        const card = doc.createElement('div'); card.className = 'card';
        card.innerHTML = `<div class="kpi-name">${t(k.tkey)}</div><div class="kpi-formula">${t(k.formulaKey)}</div><div class="val">${fmt(v, k.unit)}</div><div class="kpi-basis">${b ? (t('baseLabel') + b) : '&nbsp;'}</div>`;
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      frag.appendChild(sec);
    });

    return frag;
  }
});
