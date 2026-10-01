/* The GEO Visibility Score headline, with its trend across every run.
 *
 * The chart machinery it relies on (chart, weekly, compositeSeries, wireHover) still lives on the
 * monitoring page and arrives through ctx. Phase 2 moves that machinery into the shared engine;
 * keeping it in place for now is what makes this step verifiably output-identical.
 */
AkoreBlocks.define('compositeHero', {
  render(ctx) {
    return ctx.buildComposite();
  }
});
