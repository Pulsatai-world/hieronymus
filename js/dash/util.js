/* Shared dashboard utilities: parsing, number formatting, small text helpers.
 *
 * Every function here existed twice, once per dashboard, byte-identical in all but one parameter
 * name. Nothing in this file touches the DOM, page state, or translations, so it is also the part
 * of the dashboards that can be tested directly rather than through a rendered page.
 */
(function (global) {
  'use strict';

  // ── text ──────────────────────────────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Escapes first, then converts markdown-style emphasis markers on the already-safe text —
  // engines' raw answers often come back with bold/italic asterisk markup that would otherwise
  // read as literal asterisks. The order matters: converting first would let an answer inject
  // markup. (Line comments, not a block comment: the asterisk markup itself closes one early.)
  function mdLite(txt) {
    return esc(txt)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  }

  // ── numbers ───────────────────────────────────────────────────────────────────────────────
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function sum(rs, k) { let s = 0; for (const r of rs) s += (+r[k] || 0); return s; }
  function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

  /* Every rate carries the fraction it came from, so a card can show "40%" and "2 / 5" together —
   * a percentage over a tiny denominator reads very differently once you can see the denominator. */
  function pct(n, d) { return { value: d ? 100 * n / d : 0, basis: n + ' / ' + d }; }

  const val = o => typeof o === 'number' ? o : o.value;
  const basisOf = o => (typeof o === 'object' && o.basis) ? o.basis : '';
  const fmt = (v, u) => u === '%' ? v.toFixed(1) + '%'
    : u === 'rank' ? (v ? '#' + v.toFixed(1) : '—')
    : u === 'USD' ? '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'K' : Math.round(v))
    : Math.round(v).toLocaleString();

  function statusChip(rate) {
    const c = rate >= 50 ? 'g' : rate >= 25 ? 'm' : 'b';
    return `<span class="chip ${c}">${rate.toFixed(0)}%</span>`;
  }

  // ── results CSV ───────────────────────────────────────────────────────────────────────────
  /* A real CSV reader rather than split(','): answer excerpts contain commas, quotes and newlines,
   * and rows whose column count does not match the header are dropped rather than shifted. */
  function parseCSV(text) {
    const rows = [];
    let field = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0];
    return rows.slice(1)
      .filter(r => r.length === headers.length && r.some(v => v !== ''))
      .map(r => { const obj = {}; headers.forEach((h, idx) => obj[h] = r[idx]); return obj; });
  }

  /* CSV gives every cell back as a string. Counters become 0 when blank, but the three
   * correctness flags stay null: "not assessed" and "assessed as wrong" are different answers,
   * and collapsing them would quietly count ungraded rows as failures. */
  function normalizeRow(r) {
    const num = k => (r[k] === '' || r[k] == null) ? 0 : +r[k];
    const nullableNum = k => (r[k] === '' || r[k] == null) ? null : +r[k];
    return {
      ...r,
      brand_mentioned: num('brand_mentioned'),
      brand_cited: num('brand_cited'),
      brand_citation_rank: nullableNum('brand_citation_rank'),
      total_brands_cited: num('total_brands_cited'),
      brand_is_leader: num('brand_is_leader'),
      linked_to_site: num('linked_to_site'),
      claims_about_brand: num('claims_about_brand'),
      incorrect_claims: num('incorrect_claims'),
      has_incorrect_claim: num('has_incorrect_claim'),
      services_correct: nullableNum('services_correct'),
      location_correct: nullableNum('location_correct'),
      contact_correct: nullableNum('contact_correct'),
      ai_sessions: num('ai_sessions'),
      ai_conversions: num('ai_conversions'),
      ai_pipeline_usd: num('ai_pipeline_usd')
    };
  }

  // ── language of a prompt ──────────────────────────────────────────────────────────────────
  const ES_WORDS = /\b(qué|que|cómo|como|cuál|cuáles|dónde|donde|cuándo|cuando|cuánto|cuánta|quién|quien|servicios|servicio|empresa|mejor|precio|ubicación|proveedor|ofrece|nosotros|para|con|los|las|una|son|es)\b/gi;
  const EN_WORDS = /\b(the|what|how|which|best|where|when|who|price|contact|location|provider|offers|service|services|company|is|are|for|with)\b/gi;

  /* Prompts are not tagged with a language, so the filter infers one. Inverted punctuation is
   * decisive on its own; otherwise accents count double, because a Spanish prompt without accents
   * shares many short words with English. */
  function detectLanguage(txt) {
    const s = txt || '';
    if (/[¿¡]/.test(s)) return 'es';
    const accented = (s.match(/[áéíóúñÁÉÍÓÚÑ]/g) || []).length;
    const esHits = accented * 2 + (s.match(ES_WORDS) || []).length;
    const enHits = (s.match(EN_WORDS) || []).length;
    return esHits > enHits ? 'es' : 'en';
  }

  // ── query intents ─────────────────────────────────────────────────────────────────────────
  const INTENT_LABEL = {
    evaluation: "Evaluation (who's best?)", comparison: 'Comparison (X vs. Y)', informational: 'Informational (how to choose?)',
    definition: 'Definition (what is it?)', local: 'Local (near me)', pricing: 'Pricing (how much?)',
    trust: 'Trust (is it reliable?)', feature: 'Capability (who offers X?)', integration: 'Integration (does it work with X?)'
  };
  const INTENT_TKEY = {
    evaluation: 'intentEvaluation', comparison: 'intentComparison', informational: 'intentInformational',
    definition: 'intentDefinition', local: 'intentLocal', pricing: 'intentPricing',
    trust: 'intentTrust', feature: 'intentFeature', integration: 'intentIntegration'
  };

  /* Falls back to the English label, then the raw key, so an intent the dictionary has never heard
   * of still shows something rather than "undefined". */
  function intentLabel(k, t) {
    return INTENT_TKEY[k] ? t(INTENT_TKEY[k]) : (INTENT_LABEL[k] || k);
  }

  const api = {
    esc, mdLite, clamp, sum, avg, pct, val, basisOf, fmt, statusChip,
    parseCSV, normalizeRow, detectLanguage, intentLabel,
    ES_WORDS, EN_WORDS, INTENT_LABEL, INTENT_TKEY
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AkoreDashUtil = api;
})(typeof window !== 'undefined' ? window : null);
