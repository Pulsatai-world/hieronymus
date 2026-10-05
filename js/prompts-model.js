/* How a prompt set is read, in one place.
 *
 * A generated set is stored as plain lines, each tagged with the category it was generated for:
 *
 *     CAT1: ¿Qué opiniones hay de Fiacsa?
 *     CAT3: Tengo un cilindro hidráulico tirando aceite por los sellos…
 *
 * Two pages show that set — the customer's review page and the staff customer page — and the
 * line format, the five category names and the order they appear in are the same question on
 * both. They were about to be answered twice, which is how the dashboards ended up with two
 * copies of the competitor leaderboard carrying a comment asking the next person to keep them
 * in sync by hand. This is that comment's replacement.
 *
 * Presentation is NOT here: one page renders editable textareas and the other a read-only list.
 * This answers only what the categories are, which line belongs to which, and in what order.
 */
(function () {
  'use strict';

  // The order is the order a reader meets them in, on both pages. CAT1…CAT5 is also the order
  // the generator produces, so a set reads the same way it was built.
  const CATS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'CAT5'];

  const LABELS = {
    CAT1:  { en: 'About your brand',            es: 'Sobre tu marca' },
    CAT2:  { en: 'General category searches',   es: 'Búsquedas generales de categoría' },
    CAT3:  { en: 'Problem-based searches',      es: 'Búsquedas por problema' },
    CAT4:  { en: 'Competitor comparisons',      es: 'Comparaciones con competidores' },
    CAT5:  { en: 'Buyer persona searches',      es: 'Búsquedas por perfil de comprador' },
    OTHER: { en: 'Other',                       es: 'Otros' }
  };

  /** A stored prompt set as [{ cat, text }], in the order it was written. */
  function parsePrompts(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const m = line.match(/^(CAT[1-5]):\s*(.*)$/i);
      return { cat: m ? m[1].toUpperCase() : 'OTHER', text: m ? m[2] : line };
    });
  }

  /** Back to the stored form. The inverse of parsePrompts, so a round trip changes nothing. */
  function serializePrompts(items) {
    return (items || []).map(i => i.cat + ': ' + i.text).join('\n');
  }

  function catLabel(cat, lang) {
    const e = LABELS[cat] || LABELS.OTHER;
    return e[lang === 'en' ? 'en' : 'es'];
  }

  /**
   * [{ cat, label, items: [{ cat, text, idx }] }], in CATS order, categories with nothing in
   * them left out. `idx` is the item's position in the original list — the editable page writes
   * back by index, so it has to survive the grouping.
   */
  function groupPrompts(items, lang) {
    const byCat = {};
    (items || []).forEach((item, idx) => {
      const cat = LABELS[item.cat] ? item.cat : 'OTHER';
      (byCat[cat] = byCat[cat] || []).push({ cat: item.cat, text: item.text, idx: idx });
    });
    return CATS.concat('OTHER')
      .filter(c => byCat[c] && byCat[c].length)
      .map(c => ({ cat: c, label: catLabel(c, lang), items: byCat[c] }));
  }

  window.AkorePrompts = {
    CATS: CATS,
    parsePrompts: parsePrompts,
    serializePrompts: serializePrompts,
    catLabel: catLabel,
    groupPrompts: groupPrompts
  };
})();
