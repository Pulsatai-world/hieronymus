// Deciding what an audit run is doing, separated from drawing it.
//
// This used to live inside the polling function as seven independent branches, each re-deciding the
// whole state from whatever a single response happened to contain. Netlify Blobs is eventually
// consistent and will answer a read with an older version of a record, so consecutive polls
// genuinely disagreed — running, then "hasn't started", then running again — and the panel flapped
// between them. None of it was testable, because the decision only existed in the middle of a
// function that needed a browser.
//
// Two rules make it stable, and both need somewhere to live that a test can reach:
//   * A read older than one already seen is discarded, by `seq`.
//   * States only move forward. A run that is running cannot become one that never started.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.akoreAuditStatus = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // queued < running < finished. Ranks, not names, because stalled is a flavour of running and
  // done / error / incomplete are all equally final.
  const RANK = { none: 0, queued: 1, running: 2, stalled: 2, done: 3, incomplete: 3, error: 3 };

  const num = v => (Number.isFinite(v) ? v : (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : 0));

  /**
   * @param data   the job record as read
   * @param view   { seq, rank } — the highest seq and rank already rendered
   * @param opts   { now, pending, graceLeft, stallAfterMs }
   * @returns { action: 'render'|'ignore', state, view, ...numbers }
   *
   * `action: 'ignore'` means this response says nothing new or nothing trustworthy — keep whatever
   * is on screen. That is the answer the old code never had, and the reason a dropped field could
   * repaint a healthy run as a dead one.
   */
  function classify(data, view, opts) {
    data = data || {};
    view = { seq: (view && view.seq) || 0, rank: (view && view.rank) || 0 };
    opts = opts || {};
    const now = opts.now || Date.now();
    const stallAfter = opts.stallAfterMs || 4 * 60 * 1000;

    // 1. A stale read cannot contradict a newer one.
    if (Number.isFinite(data.seq)) {
      if (data.seq < view.seq) return { action: 'ignore', reason: 'stale-seq', state: null, view };
      view.seq = data.seq;
    }

    // An endpoint that refused us is not a run that has not started yet. /api/audit-job answers
    // errors as JSON with a 4xx, and the panel used to fall straight through to "waiting for the
    // run to report" and spin there forever — so a session problem, a missing company, anything at
    // all, looked identical to a slow cold start. Say what came back.
    if (data.error && !data.status && !Number.isFinite(data.total)) {
      return { action: 'render', state: 'unavailable', view, message: String(data.error),
               needsSignIn: !!data.needsSignIn, terminal: false,
               total: 0, completed: 0, promptsDone: 0, promptsTotal: 0, pct: 0,
               idleFor: 0, elapsed: 0, etaMs: 0, cited: 0, continuations: 0, phase: '', finishedAt: '' };
    }

    const total = num(data.total);
    const completed = num(data.completed);
    const hasShape = total > 0;
    const finished = !!data.finishedAt;

    // 2. Neither a status nor a shape is a dropped read, not a state.
    if (!data.status && !hasShape && view.rank >= RANK.running) {
      return { action: 'ignore', reason: 'partial-read', state: null, view };
    }

    let state;
    if (data.status === 'error') state = 'error';
    else if (hasShape && completed < total && finished) state = 'incomplete';
    else if (data.status === 'done' || (hasShape && total > 0 && completed >= total)) state = 'done';
    else if (data.status === 'running' || (hasShape && completed < total && !finished)) state = 'running';
    else if (opts.pending || opts.graceLeft > 0) state = 'queued';
    else if (view.rank >= RANK.running) return { action: 'ignore', reason: 'no-regress', state: null, view };
    else state = 'none';

    // 3. Stalled comes from the server's heartbeat. The browser noticing a number has not moved
    //    cannot tell a chunk that legitimately takes minutes from a run that has died.
    const beatAt = Date.parse(data.lastProgressAt || data.startedAt || '') || 0;
    const idleFor = beatAt ? now - beatAt : 0;
    if (state === 'running' && idleFor > stallAfter) state = 'stalled';

    // 4. Forward only.
    if (RANK[state] < view.rank) return { action: 'ignore', reason: 'no-regress', state: null, view };
    view.rank = RANK[state];

    // Prompts are what a person counts. `completed` and `total` are rows — prompts × engines — so a
    // bar drawn from them answers a question nobody asked.
    const engines = num(data.engineCount);
    const promptsTotal = num(data.promptsTotal);
    const promptsDone = engines
      ? (promptsTotal ? Math.min(Math.floor(completed / engines), promptsTotal) : Math.floor(completed / engines))
      : 0;
    const pct = promptsTotal ? Math.round((promptsDone / promptsTotal) * 100)
              : (total ? Math.round((completed / total) * 100) : 0);

    const startedMs = Date.parse(data.startedAt || '') || 0;
    const elapsed = startedMs ? now - startedMs : 0;
    const etaMs = (state === 'running' && promptsDone >= 2 && promptsTotal > promptsDone && elapsed > 0)
      ? (elapsed / promptsDone) * (promptsTotal - promptsDone) : 0;

    return {
      action: 'render', state, view,
      total, completed, promptsDone, promptsTotal, pct,
      idleFor, elapsed, etaMs,
      cited: num(data.cited), continuations: num(data.continuations),
      phase: data.phase || '', finishedAt: data.finishedAt || '', message: data.message || '',
      terminal: RANK[state] === 3
    };
  }

  return { classify, RANK };
});
