/* The composite GEO Visibility Score, with its per-category breakdown. */
AkoreBlocks.define('geoScoreHero', {
  render(ctx) {
    const { rows, t, CATS, computeGeoScore, doc } = ctx;
    const { composite, subs } = computeGeoScore(rows);
    const scoreLabel = composite == null ? t('scoreNoData')
      : composite >= 67 ? t('scoreStrong') : composite >= 34 ? t('scoreEmerging') : t('scoreLow');
    const hero = doc.createElement('div'); hero.className = 'geo-hero';
    hero.innerHTML =
      `<div class="score-main">` +
        `<div class="score-eyebrow">${t('geoScoreTitle')}</div>` +
        `<div class="score-figure"><span class="score-num">${composite == null ? '—' : composite}</span><span class="score-den">/ 100</span></div>` +
        `<div class="score-label">${scoreLabel} · ${t('geoScoreSub')}</div>` +
      `</div>` +
      `<div class="geo-subs">` +
        CATS.map(C => `<div class="geo-sub"><div class="gl">${t(C.tkey)}</div><div class="gv">${subs[C.name] == null ? t('scoreNoData') : Math.round(subs[C.name])}</div></div>`).join('') +
      `</div>`;
    return hero;
  }
});
