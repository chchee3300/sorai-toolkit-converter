// Library entry point consumed by the sorai-toolkit hub repo (installed as
// a git dependency; built automatically via the "prepare" npm lifecycle
// script -- see vite.lib.config.mjs and package.json). Deliberately does
// NOT import index.css/resources/styles.css here: this component's
// classNames (.panel, .btn, .modal-overlay, etc.) all key into the shared
// stylesheet the hub already loads itself (see hub's src/main.jsx) --
// shipping a second copy of that CSS from this package would just be
// duplication, not a real per-component style need. The UI runtime globals
// (window.LiquidSelect, window.EstellaLib.{i18n,rangeFill}, window.SoraiDialogs)
// and the plugin's Rust half are the host app's to provide before mounting.
export { default as ConverterApp } from './App.jsx'

// Tauri plugin guest bindings (invoke wrappers for plugin/'s commands).
export * from './plugin.js'
