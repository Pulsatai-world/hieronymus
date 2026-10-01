/* The block registry's own guarantees.
 *
 * These matter because the whole point of the registry is isolation: a customer-specific block
 * must not be able to take down the rest of someone's dashboard, and a layout must not be able to
 * name a block that does not exist without anybody noticing.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const REGISTRY = fs.readFileSync(path.join(ROOT, 'js', 'dash', 'registry.js'), 'utf8');

function freshRegistry() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', { runScripts: 'outside-only' });
  const errs = [];
  dom.window.console.error = (...a) => errs.push(a.join(' '));
  dom.window.eval(REGISTRY);
  return { w: dom.window, d: dom.window.document, B: dom.window.AkoreBlocks, errs };
}

test('a block must supply a render function', () => {
  const { B } = freshRegistry();
  assert.throws(() => B.define('bad', {}), /render/);
  assert.throws(() => B.define('bad', null), /render/);
});

test('defining the same id twice is refused rather than silently overwriting', () => {
  const { B } = freshRegistry();
  B.define('x', { render: () => null });
  assert.throws(() => B.define('x', { render: () => null }), /already defined/);
});

test('an unknown block is reported, not thrown', () => {
  const { B, d, errs } = freshRegistry();
  const host = d.getElementById('host');
  B.renderLayout(['nope'], host, { doc: d }, d);
  assert.equal(host.children.length, 0);
  assert.ok(errs.some(e => /unknown block: nope/.test(e)), 'the failure is logged');
});

test('one failing block does not stop the others from rendering', () => {
  const { B, d, errs } = freshRegistry();
  const mk = (tag) => ({ render: (ctx) => { const el = ctx.doc.createElement('div'); el.className = tag; return el; } });
  B.define('ok1', mk('one'));
  B.define('boom', { render() { throw new Error('block exploded'); } });
  B.define('ok2', mk('two'));

  const host = d.getElementById('host');
  const failures = [];
  B.renderLayout(['ok1', 'boom', 'ok2'], host, { doc: d, onBlockError: (id, e) => failures.push(id) }, d);

  assert.equal(host.children.length, 2, 'the two healthy blocks still drew');
  assert.deepEqual([...host.children].map(c => c.className), ['one', 'two']);
  assert.deepEqual(failures, ['boom'], 'the caller is told which block failed');
  assert.ok(errs.some(e => /block "boom" failed/.test(e)), 'and it is on the console');
});

test('a block returning null contributes nothing', () => {
  const { B, d } = freshRegistry();
  B.define('nothing', { render: () => null });
  const host = d.getElementById('host');
  B.renderLayout(['nothing'], host, { doc: d }, d);
  assert.equal(host.children.length, 0);
});

test('a group wraps its children in one container', () => {
  const { B, d } = freshRegistry();
  B.define('a', { render: (c) => c.doc.createElement('span') });
  B.define('b', { render: (c) => c.doc.createElement('span') });
  const host = d.getElementById('host');
  B.renderLayout([{ group: 'dual', blocks: ['a', 'b'] }], host, { doc: d }, d);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].className, 'dual');
  assert.equal(host.children[0].children.length, 2);
});

test('omitWhenEmpty drops a group whose children all declined to render', () => {
  const { B, d } = freshRegistry();
  B.define('none1', { render: () => null });
  const host = d.getElementById('host');
  B.renderLayout([{ group: 'dual', blocks: ['none1'], omitWhenEmpty: true }], host, { doc: d }, d);
  assert.equal(host.children.length, 0);
  B.renderLayout([{ group: 'dual', blocks: ['none1'] }], host, { doc: d }, d);
  assert.equal(host.children.length, 1, 'without the flag the container is still drawn');
});

const PAGES = ['dashboard-diagnostic.html', 'dashboard-monitoring.html'];

function definedBlockIds() {
  const defined = new Set();
  const dir = path.join(ROOT, 'js', 'dash', 'blocks');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/AkoreBlocks\.define\('([^']+)'/g)) defined.add(m[1]);
  }
  return defined;
}

function layoutBlockIds(html) {
  const named = new Set();
  for (const m of html.matchAll(/const LAYOUT_[A-Z]+ = (\[[\s\S]*?\]);/g)) {
    for (const q of m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)) named.add(q[1]);
  }
  // Values that appear in a layout but are not block ids.
  for (const notABlock of ['dual', 'noMatchFilter', 'noMatchFilterCompetitors']) named.delete(notABlock);
  return named;
}

for (const page of PAGES) {
  test(`${page}: every block its layouts name actually exists`, () => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const named = layoutBlockIds(html);
    const defined = definedBlockIds();
    assert.ok(named.size >= 3, page + ' names ' + named.size + ' blocks');
    for (const id of named) {
      assert.ok(defined.has(id), `${page} layout names "${id}" but no block file defines it`);
    }
  });

  test(`${page}: loads a script for every block it names, registry first`, () => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const srcs = [...html.matchAll(/<script src="(\/js\/dash\/blocks\/[^"]+)"><\/script>/g)].map(m => m[1]);
    for (const s of srcs) {
      assert.ok(fs.existsSync(path.join(ROOT, s.replace(/^\//, ''))), 'missing block file: ' + s);
    }
    assert.ok(/<script src="\/js\/dash\/registry\.js"><\/script>/.test(html), page + ' loads the registry');
    // The registry must load before any block, or define() is called on undefined.
    assert.ok(html.indexOf('/js/dash/registry.js') < html.indexOf('/js/dash/blocks/'),
      page + ': the registry must load before the blocks that register into it');

    // Every block the layouts name must have a <script> that can define it.
    const loadedIds = new Set();
    for (const s of srcs) {
      const src = fs.readFileSync(path.join(ROOT, s.replace(/^\//, '')), 'utf8');
      for (const m of src.matchAll(/AkoreBlocks\.define\('([^']+)'/g)) loadedIds.add(m[1]);
    }
    for (const id of layoutBlockIds(html)) {
      assert.ok(loadedIds.has(id), `${page} names "${id}" but loads no script that defines it`);
    }
  });
}

test('the competitor leaderboard is shared, not duplicated', () => {
  // It was copied into both pages once before; the whole modularisation rests on it staying single.
  const dir = path.join(ROOT, 'js', 'dash', 'blocks');
  let defs = 0;
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    defs += [...src.matchAll(/AkoreBlocks\.define\('competitorLeaderboard'/g)].length;
  }
  assert.equal(defs, 1, 'exactly one definition of competitorLeaderboard');
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(html.includes('/js/dash/blocks/competitor-leaderboard.js'), page + ' loads the shared one');
    assert.ok(!/function renderCompetitors/.test(html), page + ' keeps no private copy');
  }
});
