// Ported unchanged from resources/index.html:247-252 (markup) and
// main.js's setStatus(text, state) (main.js:207-216 pre-extraction):
// state is 'ready' | 'busy' | 'error', mapped to the same dot class names.
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
      <span className="statusbar-text" id="status-text">{text}</span>
      <span className="statusbar-sep"></span>
      <span className="statusbar-version">v1.0</span>
    </footer>
  )
}
