/* Share of voice over time: the client against whichever rival led most recently.
 *
 * Returns null when there is only one run (nothing to trend) and also when the active filter
 * matches no rows — in that case the leaderboard above has already said "nothing matches", and a
 * trend drawn underneath it would be describing a different, unfiltered population.
 */
AkoreBlocks.define('competitorTrend', {
  render(ctx) {
    if (ctx.rows.length === 0) return null;
    return ctx.buildCompetitorTrend();
  }
});
