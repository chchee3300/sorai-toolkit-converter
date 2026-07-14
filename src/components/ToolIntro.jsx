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

const CATEGORIES = [
  {
    title: 'Video',
    desc: 'MP4, MKV, WebM, AVI, or animated GIF — trim a range, retime with speed, adjust quality and FPS.',
    icon: (
      <>
        <rect x="2.5" y="5" width="14" height="14" rx="2" />
        <path d="M16.5 10l5-3v10l-5-3" />
      </>
    ),
  },
  {
    title: 'Image',
    desc: 'JPG, PNG, WebP, AVIF, or ICO — control quality, scale resolution down, or export straight to PDF.',
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5-11 11" />
      </>
    ),
  },
  {
    title: 'Audio',
    desc: 'MP3, WAV, AAC, FLAC, or OGG — set bitrate and change playback speed.',
    icon: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
  },
  {
    title: 'PDF',
    desc: 'Linearize or compress an existing PDF, or convert it to DOCX/ODT.',
    icon: (
      <>
        <path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
        <path d="M15 2v5h5" />
      </>
    ),
  },
]

export default function ToolIntro() {
  return (
    <section className="panel" id="tool-intro">
      <div className="settings-block">
        <p className="settings-subtitle">About this tool</p>
        <p className="intro-lede">
          Drop files anywhere in this window to get started — video, image, audio, or PDF, one type per batch.
          Settings for the batch you load will appear here.
        </p>
      </div>
      <div className="panel-divider"></div>
      <ul className="intro-list">
        {CATEGORIES.map(({ title, desc, icon }) => (
          <li className="intro-item" key={title}>
            <CategoryIcon>{icon}</CategoryIcon>
            <div>
              <p className="intro-item-title">{title}</p>
              <p className="intro-item-desc">{desc}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
