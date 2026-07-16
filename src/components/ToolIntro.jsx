import { useTranslation } from '../hooks/useTranslation.js'

// Right-column placeholder shown in place of SettingsPanel before any file
// is loaded, so the two-panel layout is what greets the app on first paint
// instead of an empty grid track (see App.jsx's hasFiles ? SettingsPanel :
// ToolIntro swap). Purely informational — no inputs, nothing to wire up.
function CategoryIcon({ children }) {
  return (
    <div className="intro-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </div>
  )
}

// title/desc are dict keys (toolIntro.<id>.title/desc), resolved through
// t() at render time -- the icon nodes are stable static JSX so the array
// itself stays a module-level constant.
const CATEGORIES = [
  {
    id: 'video',
    icon: (
      <>
        <rect x="2.5" y="5" width="14" height="14" rx="2" />
        <path d="M16.5 10l5-3v10l-5-3" />
      </>
    ),
  },
  {
    id: 'image',
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5-11 11" />
      </>
    ),
  },
  {
    id: 'audio',
    icon: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
  },
  {
    id: 'pdf',
    icon: (
      <>
        <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
        <path d="M15 2v5h5" />
      </>
    ),
  },
]

export default function ToolIntro() {
  const { t } = useTranslation()
  return (
    <section className="panel" id="tool-intro">
      <div className="settings-block">
        <p className="settings-subtitle">{t('toolIntro.about')}</p>
        <p className="intro-lede">{t('toolIntro.lede')}</p>
      </div>
      <div className="panel-divider"></div>
      <ul className="intro-list">
        {CATEGORIES.map(({ id, icon }) => (
          <li className="intro-item" key={id}>
            <CategoryIcon>{icon}</CategoryIcon>
            <div>
              <p className="intro-item-title">{t(`toolIntro.${id}.title`)}</p>
              <p className="intro-item-desc">{t(`toolIntro.${id}.desc`)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
