// Ported unchanged from resources/index.html:23-37 (markup) and its
// styles.css .header/.logo/#theme-toggle rules (reused verbatim — see
// src/index.css). fileType drives the same "Converter / Video" badge the
// vanilla app's updateSettingsUI() shows (main.js:107-108 pre-extraction).
function SunIcon() {
  return (
    <svg className="icon-sun" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
      <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg className="icon-moon" viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export default function Header({ fileType, onToggleTheme }) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <span className="logo-text">Converter</span>
          <span className={fileType ? 'logo-sep' : 'logo-sep hidden'} id="logo-sep">
            &nbsp;/&nbsp;
          </span>
          <span className="logo-type" id="type-badge">
            {fileType ? fileType.charAt(0).toUpperCase() + fileType.slice(1) : ''}
          </span>
        </div>
      </div>
      <div className="header-right">
        <button id="theme-toggle" title="Toggle theme" aria-label="Toggle theme" onClick={onToggleTheme}>
          <SunIcon />
          <MoonIcon />
        </button>
      </div>
    </header>
  )
}
