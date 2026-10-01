/* Every <script src> and <link href> a page asks for must actually exist in the repo.
 *
 * The dashboards used to carry their whole renderer inline — one request, all or nothing. They now
 * load it from a dozen small files, which is what makes a single customer's dashboard changeable
 * without forking the page, but it also means a path typo or an uncommitted file is newly able to
 * produce a blank dashboard in production. Neither would fail any other suite: pages-load.test.cjs
 * deliberately substitutes '' for a <script src> it cannot resolve, so a page missing half its
 * renderer still "loads" there.
 *
 * This is the cheap guard against the failure mode that is actually likely.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));

test('every local script and stylesheet a page references exists', () => {
  const problems = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const refs = [
      ...[...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]),
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1])
    ].filter(src => src.startsWith('/'));   // local only; CDNs are not ours to assert on
    for (const src of refs) {
      const onDisk = path.join(ROOT, src.replace(/^\//, '').split('?')[0]);
      if (!fs.existsSync(onDisk)) problems.push(`${page} -> ${src}`);
    }
  }
  assert.deepEqual(problems, [], 'referenced but missing:\n  ' + problems.join('\n  '));
});

test('the dashboards load their modules in a workable order', () => {
  // registry.js must precede the blocks that call AkoreBlocks.define() at load time, and spec.js
  // must precede specs/customers/index.js, which calls AkoreSpec.setManifest().
  for (const page of ['dashboard-diagnostic.html', 'dashboard-monitoring.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    const at = s => order.findIndex(x => x === s || x.startsWith(s));

    const registry = at('/js/dash/registry.js');
    const firstBlock = order.findIndex(x => x.startsWith('/js/dash/blocks/'));
    assert.ok(registry >= 0, page + ' loads the registry');
    assert.ok(firstBlock > registry, page + ': blocks must load after the registry they register into');

    const spec = at('/js/dash/spec.js');
    const manifest = at('/specs/customers/index.js');
    assert.ok(spec >= 0 && manifest > spec, page + ': the manifest must load after spec.js defines AkoreSpec');
  }
});

test('a dashboard tells the viewer when its renderer did not load', () => {
  // A blank page was not possible before this refactor. The guard converts the new failure mode
  // into something a client can act on, in both languages.
  for (const page of ['dashboard-diagnostic.html', 'dashboard-monitoring.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(/Startup guard/.test(html), page + ' has no startup guard');
    assert.ok(/did not finish loading/.test(html), page + ': no English message');
    assert.ok(/no terminó de cargar/.test(html), page + ': no Spanish message');
    for (const g of ['AkoreDashUtil', 'AkoreI18n', 'AkoreDashControls', 'AkoreBrands', 'AkoreSpec', 'AkoreBlocks']) {
      assert.ok(new RegExp(g + ':').test(html), `${page}: guard does not check for ${g}`);
    }
    // The guard has to run before anything that would throw on a missing module.
    assert.ok(html.indexOf('Startup guard') < html.indexOf('function makeContext'),
      page + ': the guard must come first in the inline script');
  }
});

test('the no-cache rule covers the new module paths', () => {
  // netlify.toml already refuses to serve stale /js/* because a browser running older login code
  // than the server is indistinguishable from a broken login. The dashboard renderer and the
  // per-customer specs have the same property now.
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  for (const pattern of ['/js/*', '/*.html', '/specs/*']) {
    const re = new RegExp('for\\s*=\\s*"' + pattern.replace(/[*/]/g, c => '\\' + c) + '"');
    assert.ok(re.test(toml), 'netlify.toml has no cache rule for ' + pattern);
  }
  // /js/* is a splat, so it must cover the nested module directory too.
  assert.ok(fs.existsSync(path.join(ROOT, 'js', 'dash', 'registry.js')),
    'js/dash lives under /js/, so the existing /js/* rule applies to it');
});
