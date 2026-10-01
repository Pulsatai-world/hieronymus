/* The block registry.
 *
 * A dashboard is a list of blocks rendered into a region, and a block is the smallest thing a
 * customer might want to reorder, hide, restyle or replace. Keeping each one behind a single
 * contract is what makes "change this for FIACSA only" possible without forking the page.
 *
 * A block:
 *
 *   AkoreBlocks.define('perEngine', {
 *     render(ctx) { return element | fragment | null; }   // null = draw nothing
 *   });
 *
 * `ctx` carries the filtered rows plus the page's formatting and metric helpers — see makeContext
 * in the dashboard that mounts them. Returning a DocumentFragment lets one block contribute
 * several siblings without introducing a wrapper element, which matters because the existing
 * markup has no wrapper and the rendered DOM must not change.
 *
 * A layout entry is a block id, a block with options, or a group wrapping several in a container:
 *
 *   [ 'geoScoreHero',
 *     { block: 'competitorLeaderboard', options: { rowTooltips: true } },
 *     { group: 'dual', blocks: ['clusterBars', 'sentimentDonut'] } ]
 *
 * Options are how one block serves two pages that want it drawn slightly differently, and later
 * how a customer's spec tunes a block without replacing it. They arrive as ctx.options.
 */
(function (global) {
  'use strict';

  const defs = Object.create(null);

  function define(id, def) {
    if (defs[id]) throw new Error('block already defined: ' + id);
    if (!def || typeof def.render !== 'function') throw new Error('block needs a render(ctx): ' + id);
    defs[id] = def;
  }

  /* Swap a core block for a customer's own implementation. Separate from define() on purpose:
   * define() refuses a duplicate id so two blocks cannot silently fight over one name, and
   * replacing something that already works should have to say so out loud. */
  function replace(id, def) {
    if (!defs[id]) throw new Error('cannot replace a block that is not defined: ' + id);
    if (!def || typeof def.render !== 'function') throw new Error('replacement needs a render(ctx): ' + id);
    defs[id] = def;
  }

  function get(id) { return defs[id] || null; }
  function has(id) { return !!defs[id]; }
  function ids() { return Object.keys(defs); }

  /* Render one block. A block that throws must not take the whole dashboard down with it — a
   * customer seeing five of six sections is far better than a blank page — but the failure has to
   * be loud enough to find, so it is re-reported on the console and surfaced to the caller. */
  function renderBlock(id, ctx, options) {
    const def = defs[id];
    if (!def) { console.error('[dash] unknown block: ' + id); return null; }
    // Three layers, least specific first: the page's defaults, the options this layout entry
    // carries, and the customer's spec. The customer wins — that is the whole point of a spec.
    const fromSpec = ctx && ctx.blockOptions && ctx.blockOptions[id];
    const blockCtx = (options || fromSpec)
      ? Object.assign({}, ctx, { options: Object.assign({}, ctx.options, options, fromSpec) })
      : ctx;
    if (def.visible && !def.visible(blockCtx)) return null;
    try {
      return def.render(blockCtx) || null;
    } catch (err) {
      console.error('[dash] block "' + id + '" failed to render:', err);
      if (ctx && typeof ctx.onBlockError === 'function') ctx.onBlockError(id, err);
      return null;
    }
  }

  /* Render a layout list into a host element, in order. */
  function renderLayout(layout, host, ctx, doc) {
    const d = doc || (host && host.ownerDocument) || global.document;
    for (const entry of layout) {
      if (typeof entry === 'string') {
        const el = renderBlock(entry, ctx);
        if (el) host.appendChild(el);
        continue;
      }
      if (entry.block) {
        const el = renderBlock(entry.block, ctx, entry.options);
        if (el) host.appendChild(el);
        continue;
      }
      // A group: one container holding whatever its children draw.
      const kids = entry.blocks.map(e => typeof e === 'string'
        ? renderBlock(e, ctx)
        : renderBlock(e.block, ctx, e.options)).filter(Boolean);
      if (!kids.length && entry.omitWhenEmpty) continue;
      const box = d.createElement(entry.tag || 'div');
      if (entry.group) box.className = entry.group;
      kids.forEach(k => box.appendChild(k));
      host.appendChild(box);
    }
  }

  global.AkoreBlocks = { define, replace, get, has, ids, renderBlock, renderLayout };
})(typeof window !== 'undefined' ? window : globalThis);
