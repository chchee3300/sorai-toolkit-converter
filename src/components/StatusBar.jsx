// Ported unchanged from resources/index.html:247-252 (markup) and
// main.js's setStatus(text, state) (main.js:207-216 pre-extraction):
// state is 'ready' | 'busy' | 'error', mapped to the same dot class names.
// The app-version display that used to live here moved to the hub repo's
// Header.jsx during the multi-repo restructure -- version is a shell-level
// concern (the hub's own release version), not something this per-tool
// component should own or need its own version.json for.
export default function StatusBar({ text = 'Ready', state = 'ready' }) {
  const dotClass =
    state === 'busy'
      ? 'statusbar-indicator busy'
      : state === 'error'
        ? 'statusbar-indicator error'
        : 'statusbar-indicator'

  return (
    <footer className="statusbar">
      <span className={dotClass} id="statusbar-dot"></span>
      <span className="statusbar-text" id="status-text" role="status" aria-live="polite">{text}</span>
    </footer>
  )
}
