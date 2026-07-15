// Library entry point consumed by the sorai-toolkit hub repo (installed as
// a git dependency; built automatically via the "prepare" npm lifecycle
// script -- see vite.lib.config.mjs and package.json). Deliberately does
// NOT import index.css/resources/styles.css here: this component's
// classNames (.panel, .btn, .modal-overlay, etc.) all key into the shared
// stylesheet the hub already loads itself (see hub's src/main.jsx) --
// shipping a second copy of that CSS from this package would just be
// duplication, not a real per-component style need. It also does NOT
// import resources/js/lib/platform.js or liquid-glass.js -- those are
// runtime globals (window.EstellaLib.platform, window.LiquidSelect) the
// host app is responsible for loading before mounting this component,
// exactly like window.Neutralino itself.
export { default as ConverterApp } from './App.jsx'
