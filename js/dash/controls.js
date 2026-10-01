/* Shared dashboard controls: the filter multi-select, and the expand/collapse on answer panels.
 *
 * Both were duplicated per page. Each takes its translator as an argument rather than reaching for
 * a page-level t(), so nothing here depends on which dashboard mounted it.
 */
(function (global) {
  'use strict';

  /* A checkbox dropdown whose button summarises the selection. An empty selection means "all",
   * which is why the button says so rather than showing "0 selected" — the filters start empty and
   * that state has to read as unfiltered, not as nothing-chosen.
   *
   * onChange receives the selected values as an array; an empty array means no filter.
   */
  function makeMulti(mountId, options, placeholder, onChange, t) {
    const root = document.getElementById(mountId);
    if (!root) return;
    root.innerHTML = '';
    const state = new Set();
    const btn = document.createElement('button'); btn.className = 'ms-btn'; btn.type = 'button';
    const panel = document.createElement('div'); panel.className = 'ms-panel';
    const tools = document.createElement('div'); tools.className = 'ms-tools';
    const bAll = document.createElement('button'); bAll.textContent = t('msAll'); bAll.type = 'button';
    const bNone = document.createElement('button'); bNone.textContent = t('msNone'); bNone.type = 'button';
    tools.appendChild(bAll); tools.appendChild(bNone); panel.appendChild(tools);
    options.forEach(o => {
      const lab = document.createElement('label'); lab.className = 'ms-opt';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = o.value;
      cb.addEventListener('change', () => { cb.checked ? state.add(o.value) : state.delete(o.value); sync(); });
      lab.appendChild(cb);
      const span = document.createElement('span');
      span.innerHTML = (o.code ? '<span class="code">' + o.code + '</span> ' : '') + o.label;
      lab.appendChild(span); panel.appendChild(lab);
    });
    root.appendChild(btn); root.appendChild(panel);
    function label() {
      if (state.size === 0) return t('msAllSuffix', placeholder);
      if (state.size <= 2) return [...state].map(v => { const o = options.find(x => x.value === v); return o ? (o.code || o.label) : v; }).join(', ');
      return t('msSelected', state.size);
    }
    function sync() { btn.firstChild.nodeValue = label(); onChange([...state]); }
    btn.appendChild(document.createTextNode(''));
    btn.addEventListener('click', () => { const open = panel.classList.toggle('show'); btn.classList.toggle('open', open); });
    bAll.addEventListener('click', () => { state.clear(); panel.querySelectorAll('input').forEach(c => c.checked = false); sync(); });
    bNone.addEventListener('click', () => { state.clear(); panel.querySelectorAll('input').forEach(c => c.checked = false); sync(); });
    document.addEventListener('click', e => { if (!root.contains(e.target)) { panel.classList.remove('show'); btn.classList.remove('open'); } });
    sync();
  }

  /* Expand or collapse one prompt's stored engine answers. Called from generated markup, so the
   * page must expose it globally under this name. */
  function toggleResponses(id, btn, t) {
    const panel = document.getElementById(id);
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    const n = panel.querySelectorAll('.presp-item').length;
    btn.textContent = isOpen ? t('viewResponsesBtn', n) : t('hideResponsesBtn');
  }

  /* True when the prompt text itself names the company. Such prompts trivially "mention" it and
   * often rank it first, so the competitor leaderboard excludes them — the Brand topic cluster
   * only catches some of them, and comparison prompts like "You vs X" name it too. */
  function promptNamesCompany(row, company) {
    const name = (company || '').trim().toLowerCase();
    return !!name && (row.prompt_text || '').toLowerCase().includes(name);
  }

  global.AkoreDashControls = { makeMulti, toggleResponses, promptNamesCompany };
})(typeof window !== 'undefined' ? window : globalThis);
