// The intake form, driven by a question template instead of by its own markup.
//
//   window.akoreIntakeForm.apply(template)                 wording, options, which questions show
//   window.akoreIntakeForm.collect(template, sources)      the answers object the server stores
//   window.akoreIntakeForm.populate(template, data, sinks) fill the form back in
//
// What this deliberately does NOT do is regenerate the page. The 48 questions keep their hand-built
// markup — the two-column groups, the cards, the sub-cards, the alert panels — because that layout
// is real design work and rebuilding it from a schema would trade a week of risk for nothing a
// customer can see. The template owns the things that actually differ per customer: the wording,
// the dropdown choices, whether a question is asked at all, and any question added on top.
//
// Where an answer is stored comes from the template's `paths`, which the extractor reads out of the
// old collectData(). Two fields matter more than the rest and are written by both names on purpose:
// `website` is stored as general.website AND websites.primarySite, because audit grading reads the
// second and the storage key is derived from the first.

(function () {
  const byId = id => document.getElementById(id);

  /** The .field-group wrapper around a control, which is what gets hidden. */
  function groupOf(el) {
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('field-group')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function setBilingual(el, text) {
    if (!el || !text) return;
    el.setAttribute('data-en', text.en || '');
    el.setAttribute('data-es', text.es || text.en || '');
  }

  /** Reads/writes a dotted path on a plain object, creating objects on the way down. */
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = obj;
    for (const k of keys) cur = (cur[k] = cur[k] || {});
    cur[last] = value;
  }

  // The kinds of question a form can ask. `tags` is the two bespoke chip inputs the page owns; it is
  // listed so a template round-trips one, but it is never built or replaced here.
  const CONTROL_TYPES = ['textarea', 'text', 'number', 'url', 'email', 'date', 'select', 'multi', 'tags'];

  const isMulti = el => !!(el && el.getAttribute && el.getAttribute('data-multi'));

  // The page's tabs are named after their panels. A plain replace() was right for the eleven
  // built-in panels and wrong for a section staff added, whose id has no `panel-` to replace — it
  // returned the panel's own id and went looking for a tab under it.
  function tabIdFor(sectionId) {
    const id = String(sectionId || '');
    return id.indexOf('panel-') === 0 ? 'tab-' + id.slice(6) : 'tab-' + id;
  }

  const orderedSections = tpl =>
    ((tpl && tpl.sections) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  /** What kind of question the page is currently asking, read off the control itself. */
  function domTypeOf(el) {
    if (!el) return null;
    if (isMulti(el)) return 'multi';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'INPUT') return (el.getAttribute('type') || 'text').toLowerCase();
    return null;
  }

  function fillOptions(el, field, lang) {
    const chosen = el.value;
    el.innerHTML = '';
    for (const opt of field.options || []) {
      const o = document.createElement('option');
      o.value = opt.value;
      setBilingual(o, opt.label);
      o.textContent = (opt.label && (opt.label[lang] || opt.label.en)) || opt.value;
      el.appendChild(o);
    }
    if (chosen) el.value = chosen;                  // keep what the customer already picked
  }

  /**
   * Builds the control for a question's type. `old` is the control being replaced, if any — its
   * classes and rows are carried over so a retyped question still looks like the form around it.
   */
  function buildControl(field, lang, old) {
    let el;
    if (field.type === 'textarea') {
      el = document.createElement('textarea');
      if (old && old.rows) el.rows = old.rows;
    } else if (field.type === 'select') {
      el = document.createElement('select');
      fillOptions(el, field, lang);
    } else if (field.type === 'multi') {
      // More than one answer, so it cannot be an <input value>. The container carries the id and
      // the answer is the set of ticked values — collect() and populate() both know to look.
      el = document.createElement('div');
      el.setAttribute('data-multi', '1');
      el.className = 'multi-choice';
      for (const opt of field.options || []) {
        const label = document.createElement('label');
        label.className = 'multi-choice-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.value;
        const span = document.createElement('span');
        setBilingual(span, opt.label);
        span.textContent = (opt.label && (opt.label[lang] || opt.label.en)) || opt.value;
        label.appendChild(cb);
        label.appendChild(span);
        el.appendChild(label);
      }
    } else {
      el = document.createElement('input');
      el.type = CONTROL_TYPES.indexOf(field.type) === -1 ? 'text' : field.type;
    }
    el.id = field.id;
    if (old) {
      if (old.className && field.type !== 'multi') el.className = old.className;
      if (old.placeholder) el.placeholder = old.placeholder;
    }
    if (typeof field.placeholder === 'string' && 'placeholder' in el) el.placeholder = field.placeholder;
    return el;
  }

  /** Reads one control, whichever kind it turned out to be. */
  function readControl(el) {
    if (!el) return '';
    if (isMulti(el)) {
      return Array.prototype.slice.call(el.querySelectorAll('input[type=checkbox]'))
        .filter(c => c.checked).map(c => c.value);
    }
    return el.value || '';
  }

  function writeControl(el, value) {
    if (!el) return;
    if (isMulti(el)) {
      const picked = Array.isArray(value) ? value : (value ? [value] : []);
      Array.prototype.slice.call(el.querySelectorAll('input[type=checkbox]'))
        .forEach(c => { c.checked = picked.indexOf(c.value) !== -1; });
      return;
    }
    el.value = value;
  }

  /** A question added by staff, rendered into its section rather than woven into the layout. */
  function renderCustom(field, lang) {
    const group = document.createElement('div');
    group.className = 'field-group';

    const label = document.createElement('label');
    setBilingual(label, field.label);
    label.textContent = (field.label && (field.label[lang] || field.label.en)) || '';
    group.appendChild(label);

    if (field.help) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      setBilingual(hint, field.help);
      hint.textContent = field.help[lang] || field.help.en || '';
      group.appendChild(hint);
    }

    const control = buildControl(field, lang, null);
    group.appendChild(control);
    return group;
  }

  const api = {
    /**
     * Applies a template to the page already on screen.
     *
     * Existing questions are re-worded and re-optioned in place; a question switched off is hidden
     * along with its label and help, not just emptied, because a blank field a customer cannot fill
     * in reads as broken rather than as intentionally absent.
     */
    apply: function (template, lang) {
      const l = lang === 'en' ? 'en' : 'es';
      if (!template || !Array.isArray(template.fields)) return;

      // A section staff added has no panel and no tab in a page that was written before it existed,
      // so both are built here. Without this the editor could create a section, the questions in it
      // were never drawn, and the customer's answers to them came back empty for ever — the form
      // looked complete and silently could not ask two of its questions.
      for (const section of orderedSections(template)) {
        if (section.enabled === false || byId(section.id)) continue;

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = section.id;
        const done = byId('panel-complete');
        if (done && done.parentNode) done.parentNode.insertBefore(panel, done);
        else document.body.appendChild(panel);

        const bar = byId('tab-bar');
        if (bar) {
          const tab = document.createElement('a');
          tab.className = 'tab';
          tab.id = tabIdFor(section.id);
          tab.href = 'javascript:void(0)';
          const num = document.createElement('span');
          num.className = 'tab-num';
          num.textContent = '+';
          const label = document.createElement('span');
          label.className = 'tab-label';
          setBilingual(label, section.title);
          label.textContent = (section.title && (section.title[l] || section.title.en)) || '';
          tab.appendChild(num);
          tab.appendChild(label);
          const doneTab = byId('tab-complete');
          if (doneTab) bar.insertBefore(tab, doneTab); else bar.appendChild(tab);
        }
      }

      // Sections can be renamed and switched off too — the tab goes with the panel.
      for (const section of template.sections || []) {
        const panel = byId(section.id);
        const tab = byId(tabIdFor(section.id));
        if (tab && section.title) setBilingual(tab.querySelector('.tab-label'), section.title);
        if (section.enabled === false) {
          if (panel) panel.setAttribute('data-off', '1');
          if (tab) tab.style.display = 'none';
        } else if (tab) {
          tab.style.display = '';
        }
      }

      for (const field of template.fields) {
        if (field.custom) continue;                       // added questions are rendered below
        let el = byId(field.id);
        if (!el) continue;
        const group = groupOf(el) || el.parentElement;

        if (field.enabled === false) {
          if (group) group.style.display = 'none';
          continue;
        }
        if (group) group.style.display = '';

        // The type is a property of the question, not of the markup it was born with. Switching a
        // long-text question to a single choice has to replace the control, or the editor would
        // offer a change the customer's form quietly ignores. `tags` is left alone: those two chip
        // inputs are bespoke sub-forms the page owns, not controls this can rebuild.
        if (field.type && field.type !== 'tags') {
          const has = domTypeOf(el);
          if (has && has !== field.type) {
            const fresh = buildControl(field, l, el);
            el.parentNode.replaceChild(fresh, el);
            el = fresh;
          }
        }

        if (group && field.label) setBilingual(group.querySelector('label'), field.label);
        if (group && field.help) setBilingual(group.querySelector('.field-hint'), field.help);
        if (typeof field.placeholder === 'string') el.placeholder = field.placeholder;

        if (field.type === 'select' && Array.isArray(field.options)) fillOptions(el, field, l);
        if (field.type === 'multi' && Array.isArray(field.options)) {
          // Rebuilt from the template, but the ticks the customer already made are put back.
          const picked = readControl(el);
          el.parentNode.replaceChild(buildControl(field, l, el), el);
          writeControl(byId(field.id), picked);
        }
      }

      // Order, and which section a question belongs to.
      //
      // The editor can reorder questions and drag them between sections, and without this none of
      // that would reach the customer: everything above re-words a question where it already sits.
      //
      // A section is left completely alone unless its order actually differs from the page's, which
      // means the default template moves nothing at all. When it does differ, the moved questions
      // are lifted to the top level of their panel — a question dragged out of a two-column pair
      // cannot stay in it — so the designed layout survives everywhere it was not reordered.
      for (const section of template.sections || []) {
        const panel = byId(section.id);
        if (!panel) continue;
        const mine = (template.fields || []).filter(f => f.section === section.id && !f.custom);
        const groups = mine.map(f => groupOf(byId(f.id))).filter(Boolean);
        if (groups.length < 2) continue;

        const inPage = groups.slice().sort((a, b) =>
          (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
        const sameOrder = groups.every((g, i) => g === inPage[i]) && groups.every(g => panel.contains(g));
        if (sameOrder) continue;

        const extra = panel.querySelector('[data-extra-questions]');
        for (const g of groups) panel.insertBefore(g, extra || null);
      }

      // Questions staff added. They go at the end of their section, in their own container, so the
      // designed layout above them is left exactly as it is.
      for (const section of template.sections || []) {
        const panel = byId(section.id);
        if (!panel) continue;
        let extra = panel.querySelector('[data-extra-questions]');
        const mine = template.fields.filter(f => f.custom && f.section === section.id && f.enabled !== false);
        if (!mine.length) { if (extra) extra.remove(); continue; }
        if (!extra) {
          extra = document.createElement('div');
          extra.className = 'card';
          extra.setAttribute('data-extra-questions', '1');
          panel.appendChild(extra);
        }
        extra.innerHTML = '';
        for (const f of mine) extra.appendChild(renderCustom(f, l));
      }
    },

    /**
     * Builds the answers object.
     *
     * `sources` supplies the pieces that are not single controls — the two tag lists and the two
     * repeaters — because those are bespoke sub-forms the page still owns.
     */
    collect: function (template, sources) {
      const out = {};
      for (const field of template.fields || []) {
        if (field.enabled === false) continue;
        const value = readControl(byId(field.id));
        for (const path of field.paths || []) setPath(out, path, value);
      }
      for (const w of template.widgets || []) {
        const fn = sources && sources[w.source];
        if (typeof fn === 'function') setPath(out, w.path, fn());
      }
      return out;
    },

    /**
     * The sections a customer will actually step through, in order. The page's navigation is a pair
     * of index-based arrays written when there were exactly eleven panels, so it has to be rebuilt
     * from this — otherwise a switched-off section stays in the sequence as a step with nothing in
     * it, and an added one cannot be reached at all.
     */
    sectionOrder: function (template) {
      return orderedSections(template).filter(s => s.enabled !== false).map(s => s.id);
    },

    tabIdFor: tabIdFor,

    /** Fills the form back in from saved answers. */
    populate: function (template, data, sinks) {
      if (!data) return;
      for (const field of template.fields || []) {
        const el = byId(field.id);
        if (!el) continue;
        for (const path of field.paths || []) {
          const v = getPath(data, path);
          if (v !== undefined && v !== null && v !== '') { writeControl(el, v); break; }
        }
      }
      for (const w of template.widgets || []) {
        const fn = sinks && sinks[w.source];
        const v = getPath(data, w.path);
        if (typeof fn === 'function' && v !== undefined) fn(v);
      }
    }
  };

  window.akoreIntakeForm = api;
})();
