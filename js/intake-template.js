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

    let control;
    if (field.type === 'textarea') {
      control = document.createElement('textarea');
    } else if (field.type === 'select') {
      control = document.createElement('select');
      for (const opt of field.options || []) {
        const o = document.createElement('option');
        o.value = opt.value;
        setBilingual(o, opt.label);
        o.textContent = (opt.label && (opt.label[lang] || opt.label.en)) || opt.value;
        control.appendChild(o);
      }
    } else {
      control = document.createElement('input');
      control.type = field.type || 'text';
    }
    control.id = field.id;
    if (field.placeholder) control.placeholder = field.placeholder;
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

      // Sections can be renamed and switched off too — the tab goes with the panel.
      for (const section of template.sections || []) {
        const panel = byId(section.id);
        const tab = byId(section.id.replace(/^panel-/, 'tab-'));
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
        const el = byId(field.id);
        if (!el) continue;
        const group = groupOf(el) || el.parentElement;

        if (field.enabled === false) {
          if (group) group.style.display = 'none';
          continue;
        }
        if (group) group.style.display = '';

        if (group && field.label) setBilingual(group.querySelector('label'), field.label);
        if (group && field.help) setBilingual(group.querySelector('.field-hint'), field.help);
        if (typeof field.placeholder === 'string') el.placeholder = field.placeholder;

        if (field.type === 'select' && Array.isArray(field.options)) {
          const chosen = el.value;
          el.innerHTML = '';
          for (const opt of field.options) {
            const o = document.createElement('option');
            o.value = opt.value;
            setBilingual(o, opt.label);
            o.textContent = (opt.label && (opt.label[l] || opt.label.en)) || opt.value;
            el.appendChild(o);
          }
          if (chosen) el.value = chosen;                  // keep what the customer already picked
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
        const el = byId(field.id);
        const value = el ? (el.value || '') : '';
        for (const path of field.paths || []) setPath(out, path, value);
      }
      for (const w of template.widgets || []) {
        const fn = sources && sources[w.source];
        if (typeof fn === 'function') setPath(out, w.path, fn());
      }
      return out;
    },

    /** Fills the form back in from saved answers. */
    populate: function (template, data, sinks) {
      if (!data) return;
      for (const field of template.fields || []) {
        const el = byId(field.id);
        if (!el) continue;
        for (const path of field.paths || []) {
          const v = getPath(data, path);
          if (v !== undefined && v !== null && v !== '') { el.value = v; break; }
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
