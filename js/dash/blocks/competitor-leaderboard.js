/* The competitor leaderboard: summary cards, the intro, and the ranked bar list.
 *
 * The ranking itself is computed by buildLeaderboard() in js/brands.js, shared with the monitoring
 * dashboard — this block only draws it. That split is what will let a customer change how brands
 * are merged or classified without touching any rendering, and vice versa.
 *
 * Callers must pass rows that already exclude prompts naming the company: such a prompt makes the
 * company trivially "most cited" in its own answer and skews the whole ranking.
 *
 * Options — the two places the diagnostic and monitoring dashboards genuinely differ:
 *   rowTooltips  attach the hover tooltip to each bar (diagnostic only)
 *   emptyKey     translation key for "nothing matches the filter"
 *   rowLimit     how many brands get their own row before the rest fold into "Others"
 */
AkoreBlocks.define('competitorLeaderboard', {
  render(ctx) {
    const { rows, company, t, buildLeaderboard, doc, options } = ctx;
    const frag = doc.createDocumentFragment();

    if (rows.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = t((options && options.emptyKey) || 'noMatchFilter');
      frag.appendChild(empty);
      return frag;
    }

    const YOU = company;
    const rowLimit = (options && options.rowLimit) || undefined;
    const { brands, maxCited, you, youKey, yourRank, topRival, leaderRows, others } =
      buildLeaderboard(rows, YOU, { rowLimit });
    const limit = (options && options.rowLimit) || ctx.COMPETITOR_ROW_LIMIT;

    const cards = doc.createElement('div'); cards.className = 'ccards';
    cards.innerHTML =
      `<div class="ccard"><div class="l">${t('yourRank')}</div><div class="b">${yourRank > 0 ? ('#' + yourRank + ' of ' + brands.length) : '—'}</div><div class="s">${t('byNumCitations')}</div></div>` +
      `<div class="ccard"><div class="l">${t('mostCitedBrand')}</div><div class="b">${brands[0] ? brands[0].name : '—'}</div><div class="s">${brands[0] ? t('ofAllCitations', brands[0].sov.toFixed(0)) : ''}</div></div>` +
      `<div class="ccard"><div class="l">${t('yourTopRival')}</div><div class="b">${topRival ? topRival.name : '—'}</div><div class="s">${topRival ? t('citationsVsYours', topRival.cited, you.cited) : ''}</div></div>`;
    frag.appendChild(cards);

    const intro = doc.createElement('div'); intro.className = 'cintro';
    intro.innerHTML = t('competitorsIntro', YOU) + (others ? ' ' + t('leaderboardCapNote', limit) : '');
    frag.appendChild(intro);

    const sec = doc.createElement('div'); sec.className = 'cat';
    const hd = doc.createElement('div'); hd.className = 'crow hd';
    hd.innerHTML = `<div>${t('crowRank')}</div><div>${t('crowBrand')}</div><div>${t('crowTimesCited')}</div><div class="cmetric">${t('crowLeads')}</div>`;
    sec.appendChild(hd);
    leaderRows.forEach(({ b, rank }) => {
      const isYou = b.key === youKey;
      const w = 100 * b.cited / maxCited;
      const row = doc.createElement('div'); row.className = 'crow';
      if (options && options.rowTooltips) row.dataset.tip = t('leaderBarTooltip', b.name, b.cited, b.sov.toFixed(0), b.leader);
      row.innerHTML = `<div class="crank">${rank}</div>` +
        `<div class="cname${isYou ? ' you' : ''}">${b.name}</div>` +
        `<div class="cbar${isYou ? ' you' : ''}"><span style="width:${w.toFixed(1)}%"></span><em>${b.cited} &middot; ${b.sov.toFixed(0)}%</em></div>` +
        `<div class="cmetric"><span class="mv">${b.leader}</span><div class="ml">${t('timesFirst')}</div></div>`;
      sec.appendChild(row);
    });
    if (others) {
      // Combined citations can exceed any single brand's, so the bar is clamped rather than allowed
      // to overflow its track.
      const w = Math.min(100, 100 * others.cited / maxCited);
      const row = doc.createElement('div'); row.className = 'crow others';
      if (options && options.rowTooltips) row.dataset.tip = t('othersTooltip', others.count, others.cited, others.sov.toFixed(0), others.leader);
      row.innerHTML = `<div class="crank">—</div>` +
        `<div class="cname">${t('othersRow', others.count)}</div>` +
        `<div class="cbar"><span style="width:${w.toFixed(1)}%"></span><em>${others.cited} &middot; ${others.sov.toFixed(0)}%</em></div>` +
        `<div class="cmetric"><span class="mv">${others.leader}</span><div class="ml">${t('timesFirst')}</div></div>`;
      sec.appendChild(row);
    }
    frag.appendChild(sec);

    return frag;
  }
});
