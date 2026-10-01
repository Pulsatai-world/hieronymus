/* The dashboards' translation runtime.
 *
 * The dictionary itself stays with each page for now — it becomes spec-overridable `copy` later —
 * but the machinery around it (current language, persistence, re-rendering on a switch) was
 * duplicated per page and lives here.
 *
 * Usage:
 *   const i18n = AkoreI18n.create({ dict: T, defaultLang: 'es', storageKey: 'hieronymus_lang',
 *                                   onChange: () => { ... } });
 *   i18n.t('someKey', arg)   i18n.lang   i18n.setLang('en')   i18n.applyStaticLang()
 */
(function (global) {
  'use strict';

  function create(opts) {
    const dict = opts.dict;
    const storageKey = opts.storageKey || 'hieronymus_lang';
    // Most customers are Mexico-based at first contact, so the dashboards open in Spanish unless
    // this browser has already chosen otherwise.
    const defaultLang = opts.defaultLang || 'es';

    let lang;
    try { lang = localStorage.getItem(storageKey) || defaultLang; }
    catch (e) { lang = defaultLang; }   // private browsing can refuse storage entirely

    /* A missing key returns the key itself rather than throwing. A dashboard with one untranslated
     * label is still a working dashboard; one that throws mid-render is a blank page. */
    function t(key, ...args) {
      const entry = dict[key];
      if (!entry) { console.warn('[dash] missing translation key: ' + key); return key; }
      const val = entry[lang];
      if (val == null) return entry[defaultLang] != null ? entry[defaultLang] : key;
      return typeof val === 'function' ? val(...args) : val;
    }

    function applyStaticLang() {
      document.querySelectorAll('[data-t]').forEach(el => { el.innerHTML = t(el.getAttribute('data-t')); });
      const en = document.getElementById('lang-btn-en');
      const es = document.getElementById('lang-btn-es');
      if (en) en.classList.toggle('active', lang === 'en');
      if (es) es.classList.toggle('active', lang === 'es');
    }

    function setLang(newLang) {
      lang = newLang;
      try { localStorage.setItem(storageKey, lang); } catch (e) {}
      applyStaticLang();
      if (typeof opts.onChange === 'function') opts.onChange(lang);
    }

    return {
      t, setLang, applyStaticLang,
      get lang() { return lang; }
    };
  }

  global.AkoreI18n = { create };
})(typeof window !== 'undefined' ? window : globalThis);
