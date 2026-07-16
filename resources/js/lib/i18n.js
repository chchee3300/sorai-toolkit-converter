// Cross-package language state -- current language, persistence, and
// change notification, same window.EstellaLib attach pattern as the rest of
// resources/js/lib/ (see platform.js). Deliberately does NOT own any
// translation strings itself: those live in each consuming package's own
// src/i18n/dict.js (hub, sorai-toolkit-converter, sorai-toolkit-downloader
// each own their own UI copy, same reasoning the multi-repo split already
// established for everything else). This module is only the mechanism --
// what language is active, how to switch it, and how to look a key up in
// whatever dict a caller hands it.
//
// Nothing in this codebase's existing EstellaLib.* modules is read
// reactively (every consumer reads once, synchronously, at call time) --
// this one needs to be, since switching languages must re-render already-
// mounted React trees across THREE separate npm packages that don't share
// an import graph. subscribe()/getLang() are written to plug directly into
// React's useSyncExternalStore (see each repo's src/hooks/useTranslation.js)
// rather than inventing a bespoke event system.
(function (global) {
  var STORAGE_KEY = 'sorai-lang';
  var SUPPORTED = ['en', 'zh-TW'];
  var FALLBACK = 'en';

  function detectInitialLang() {
    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      /* localStorage unavailable (rare) -- fall through to detection */
    }
    if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    var nav = (global.navigator && (navigator.language || navigator.userLanguage)) || '';
    // Traditional Chinese locales: Taiwan, Hong Kong, Macau, or an explicit
    // Han-script tag (zh-Hant-*). Simplified-Chinese locales (zh-CN, zh-SG,
    // bare zh-Hans) are intentionally excluded -- SUPPORTED has no
    // Simplified variant yet, so those fall through to the English default.
    if (/^zh-(TW|HK|MO)/i.test(nav) || /^zh-Hant/i.test(nav)) return 'zh-TW';
    return FALLBACK;
  }

  var currentLang = detectInitialLang();
  var listeners = [];

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1 || lang === currentLang) return;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* fine -- just won't persist across restarts */
    }
    document.documentElement.setAttribute('lang', lang);
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  // Advances to the next language in SUPPORTED, wrapping around -- what the
  // hamburger menu's single click-to-cycle language row calls. Scales to
  // any number of supported languages, not just a 2-way toggle.
  function cycleLang() {
    var idx = SUPPORTED.indexOf(currentLang);
    setLang(SUPPORTED[(idx + 1) % SUPPORTED.length]);
  }

  // Returns an unsubscribe function, matching useSyncExternalStore's
  // expected subscribe(callback) => unsubscribe shape directly.
  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  // dict shape: { en: { key: string | (params) => string }, 'zh-TW': {...} }.
  // A function-valued entry handles interpolation/pluralization itself --
  // each language's own function decides how (e.g. Traditional Chinese has
  // no plural forms at all, so its entry just ignores any count param
  // English needs for an "s" suffix) -- no shared ICU MessageFormat-style
  // engine needed. Falls back to the FALLBACK language's table, then to the
  // raw key itself, so a missing translation never throws or renders blank.
  function translate(dict, lang, key, params) {
    var table = dict[lang] || dict[FALLBACK] || {};
    var entry = key in table ? table[key] : (dict[FALLBACK] || {})[key];
    if (entry == null) return key;
    return typeof entry === 'function' ? entry(params || {}) : entry;
  }

  document.documentElement.setAttribute('lang', currentLang);

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.i18n = {
    SUPPORTED_LANGS: SUPPORTED,
    getLang: getLang,
    setLang: setLang,
    cycleLang: cycleLang,
    subscribe: subscribe,
    translate: translate,
  };
})(window);
