/* Per-customer dashboard specs.
 *
 * A dashboard is the base design plus, optionally, one customer's overrides. The overrides are
 * CODE IN THIS REPO — specs/customers/<slug>.js — not rows in a store. Git is the version history
 * and the rollback, review is the gate, and a deploy is the publish. That also means a customer
 * can ship a genuinely new visual as a real block, which no amount of stored configuration could
 * express and which could never be loaded safely from a database into a client-facing page.
 *
 * A customer module registers itself:
 *
 *   AkoreSpec.register('acme', {
 *     diagnostic: {
 *       layouts:      { summary: ['geoScoreHero', 'perEngine'] },   // arrays REPLACE
 *       blockOptions: { competitorLeaderboard: { rowLimit: 10 } },
 *       copy:         { yourRank: { en: 'Your position', es: 'Tu posición' } },
 *       theme:        { '--navy': '#123456' },
 *       tabs:         { prompts: { hidden: true } }
 *     },
 *     monitoring: { ... },
 *     blocks:   { acmeWhatever: { render(ctx) { ... } } },  // new blocks, this customer only
 *     replaces: { sentimentDonut: { render(ctx) { ... } } } // or swap a core one outright
 *   });
 *
 * Nothing here runs for a customer without a spec. That is the whole safety property: an absent
 * entry means the base design renders, untouched, exactly as it does today.
 */
(function (global) {
  'use strict';

  const specs = Object.create(null);
  let manifest = null;          // slugs known to have a module; null until index.js loads
  const loaded = Object.create(null);
  const LOAD_TIMEOUT_MS = 5000;

  /* Must match slugify() in netlify/functions/intake-codes.js — the customer's username is derived
   * from the company name by that rule, and the spec file is named for the same slug. */
  function slugify(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  }

  function setManifest(list) { manifest = Array.isArray(list) ? list.slice() : []; }
  function register(slug, spec) { specs[slugify(slug)] = spec || {}; }
  function registered() { return Object.keys(specs); }

  /* Fetch one customer's module by injecting a script tag.
   *
   * Deliberately not dynamic import(): a classic script works in every browser this app targets
   * and, unlike import(), can be exercised in the test harness. The slug is re-slugified before it
   * reaches the URL, so a crafted ?company= cannot walk out of the directory.
   */
  function loadModule(slug, doc) {
    const d = doc || global.document;
    if (loaded[slug]) return loaded[slug];
    loaded[slug] = new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; resolve(v); } };
      const el = d.createElement('script');
      el.src = '/specs/customers/' + slug + '.js';
      el.async = false;
      el.onload = () => done(true);
      // A missing file is a normal outcome, not an error worth shouting about.
      el.onerror = () => done(false);
      // The dashboard waits on this before its first render, so it must not be able to wait
      // forever. A spec that cannot be fetched costs a customisation, not the whole page.
      setTimeout(() => { if (!settled) console.warn('[dash] spec for ' + slug + ' timed out'); done(false); }, LOAD_TIMEOUT_MS);
      (d.head || d.documentElement).appendChild(el);
    });
    return loaded[slug];
  }

  /* Deep merge, with rules chosen so an override is predictable rather than clever:
   *   - plain objects merge key by key
   *   - arrays REPLACE wholesale; half-merging a layout is never what anyone means
   *   - null removes the key
   *   - anything else replaces
   */
  function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function'; }

  function merge(base, over) {
    if (over === undefined) return base;
    if (over === null) return undefined;
    if (!isPlain(base) || !isPlain(over)) return Array.isArray(over) ? over.slice() : over;
    const out = Object.assign({}, base);
    for (const k of Object.keys(over)) {
      const v = merge(base[k], over[k]);
      if (v === undefined && over[k] === null) delete out[k];
      else out[k] = v;
    }
    return out;
  }

  /* Resolve the spec for one company on one dashboard. Returns the always-present shape, so
   * callers never have to null-check a branch. */
  function resolve(company, dashboard) {
    const slug = slugify(company);
    const spec = specs[slug];
    const empty = { slug, customised: false, layouts: {}, blockOptions: {}, copy: {}, theme: {}, tabs: {} };
    if (!spec) return empty;
    const per = spec[dashboard] || {};
    return {
      slug,
      customised: true,
      layouts: per.layouts || {},
      blockOptions: per.blockOptions || {},
      copy: per.copy || {},
      theme: per.theme || {},
      tabs: per.tabs || {}
    };
  }

  /* Load this company's module if the manifest says it has one, then resolve. */
  async function forCompany(company, dashboard, doc) {
    const slug = slugify(company);
    // The manifest exists so the common case — a customer with no spec — costs no request and
    // logs no 404, and so the set of customised dashboards is greppable in one file.
    if (manifest && manifest.indexOf(slug) !== -1 && !specs[slug]) {
      await loadModule(slug, doc);
      if (!specs[slug]) console.warn('[dash] ' + slug + ' is in the manifest but registered no spec');
    }
    return resolve(company, dashboard);
  }

  /* The effective layout for a region: the customer's list if they named one, else the base. */
  function layout(spec, region, base) {
    const over = spec && spec.layouts && spec.layouts[region];
    return Array.isArray(over) ? over : base;
  }

  /* Fold a customer's copy overrides into the page's dictionary, in place.
   *
   * Specs are reviewed code in this repo, not user input, so an override may carry the same inline
   * markup the built-in strings already use. It is still refused if it is not a {en, es} shape,
   * because a bare string here would silently render "undefined" in the other language.
   */
  function applyCopy(spec, dict) {
    let n = 0;
    for (const key of Object.keys((spec && spec.copy) || {})) {
      const v = spec.copy[key];
      if (!isPlain(v) || (v.en == null && v.es == null)) {
        console.warn('[dash] copy override for "' + key + '" ignored: expected { en, es }');
        continue;
      }
      dict[key] = Object.assign({}, dict[key], v);
      n++;
    }
    return n;
  }

  /* Theme overrides become custom properties on :root. Values are validated rather than trusted
   * into a stylesheet: a spec is reviewed code, but a typo that injects a brace would break every
   * rule after it, and the failure would look like a rendering bug rather than a bad value. */
  const SAFE_VALUE = /^[#a-zA-Z0-9\s,.()%\-_/]*$/;

  function applyTheme(spec, doc) {
    const theme = (spec && spec.theme) || {};
    const keys = Object.keys(theme);
    if (!keys.length) return 0;
    const d = doc || global.document;
    const decls = [];
    for (const k of keys) {
      if (!/^--[a-zA-Z0-9-]+$/.test(k)) { console.warn('[dash] theme key ignored, not a custom property: ' + k); continue; }
      const v = String(theme[k]);
      if (!SAFE_VALUE.test(v) || v.indexOf(';') !== -1) { console.warn('[dash] theme value ignored for ' + k + ': ' + v); continue; }
      decls.push(k + ':' + v);
    }
    if (!decls.length) return 0;
    const style = d.createElement('style');
    style.id = 'akore-spec-theme';
    style.textContent = ':root{' + decls.join(';') + '}';
    (d.head || d.documentElement).appendChild(style);
    return decls.length;
  }

  /* Rename, hide or reorder the tab strip. Tabs are markup today; this edits that markup in place
   * rather than re-rendering it, so a customer with no tab overrides keeps byte-identical DOM. */
  function applyTabs(spec, lang, doc) {
    const tabs = (spec && spec.tabs) || {};
    if (!Object.keys(tabs).length) return 0;
    const d = doc || global.document;
    const strip = d.querySelector('.tabs');
    if (!strip) return 0;
    let n = 0;
    const order = [];
    for (const btn of [...strip.querySelectorAll('.tab')]) {
      const id = btn.dataset.panel;
      const cfg = tabs[id];
      if (!cfg) { order.push([btn, Number.MAX_SAFE_INTEGER]); continue; }
      if (cfg.hidden) {
        btn.remove();
        const panel = d.getElementById('panel-' + id);
        if (panel) panel.remove();
        n++;
        continue;
      }
      if (cfg.label) {
        // Drop data-t, or the next language repaint would overwrite the override with the
        // built-in label. paintTabLabels() takes over keeping it in the right language.
        btn.removeAttribute('data-t');
        n++;
      }
      order.push([btn, cfg.order == null ? Number.MAX_SAFE_INTEGER : cfg.order]);
    }
    if (order.some(([, o]) => o !== Number.MAX_SAFE_INTEGER)) {
      order.sort((a, b) => a[1] - b[1]);
      order.forEach(([btn]) => strip.appendChild(btn));
      n++;
    }
    paintTabLabels(spec, lang, d);
    return n;
  }

  /* Write the overridden tab labels in the current language. Called by applyTabs and again after
   * every language switch, since that repaints every [data-t] element. */
  function paintTabLabels(spec, lang, doc) {
    const tabs = (spec && spec.tabs) || {};
    const d = doc || global.document;
    for (const id of Object.keys(tabs)) {
      const cfg = tabs[id];
      if (!cfg || !cfg.label || cfg.hidden) continue;
      const btn = d.querySelector('.tabs .tab[data-panel="' + id + '"]');
      if (btn) btn.textContent = cfg.label[lang] != null ? cfg.label[lang] : (cfg.label.en || '');
    }
  }

  /* Register a customer's own blocks, and any core blocks they replace outright. */
  function installBlocks(slug, Blocks) {
    const spec = specs[slugify(slug)];
    if (!spec || !Blocks) return 0;
    let n = 0;
    for (const id of Object.keys(spec.blocks || {})) {
      if (Blocks.has(id)) { console.warn('[dash] ' + slug + ' block "' + id + '" clashes with an existing block; use `replaces` to swap one'); continue; }
      Blocks.define(id, spec.blocks[id]); n++;
    }
    for (const id of Object.keys(spec.replaces || {})) {
      if (!Blocks.has(id)) { console.warn('[dash] ' + slug + ' replaces unknown block "' + id + '"'); continue; }
      Blocks.replace(id, spec.replaces[id]); n++;
    }
    return n;
  }

  const api = {
    slugify, setManifest, manifest: setManifest, register, registered,
    resolve, forCompany, layout, applyCopy, applyTheme, applyTabs, paintTabLabels, installBlocks,
    merge, _specs: specs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AkoreSpec = api;
})(typeof window !== 'undefined' ? window : null);
