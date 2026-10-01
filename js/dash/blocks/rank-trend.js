/* The client's place on the leaderboard over time, plotted with the axis inverted so that
 * "moving up the rankings" moves up the chart.
 *
 * Null when there is one run, when fewer than two runs actually produced a rank, or when the
 * filter matches nothing — same reasoning as competitorTrend.
 */
AkoreBlocks.define('rankTrend', {
  render(ctx) {
    if (ctx.rows.length === 0) return null;
    return ctx.buildRankTrend();
  }
});
