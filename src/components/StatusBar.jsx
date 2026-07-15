import versionInfo from '../version.json'

// Ported unchanged from resources/index.html:247-252 (markup) and
// main.js's setStatus(text, state) (main.js:207-216 pre-extraction):
// state is 'ready' | 'busy' | 'error', mapped to the same dot class names.
// versionInfo comes from src/version.json -- see useUpdateChecker.js for
// the other consumer. Kept current by the release pipeline itself: the
// "chore(release)" commit (.releaserc.json's @semantic-release/git assets)
// commits the real version back here, not just an in-CI ephemeral write.
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
      <span className="statusbar-sep"></span>
      <span className="statusbar-version">v{versionInfo.version}</span>
    </footer>
  )
}
