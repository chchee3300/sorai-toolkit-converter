// The empty-state "drop/click to browse" message, shown inside #input-panel
// before any file is loaded. Deliberately carries no panel-level border or
// drag-active glow of its own — files are droppable everywhere on the page
// (see useFileManager.js's document-level drag listeners), not just here,
// so no single area is visually marked as "the" drop target; the file list
// updating is the only feedback a drop needs. Only the icon/CTA get a small
// hover shift, the same treatment any other clickable control gets.
import { useTranslation } from '../hooks/useTranslation.js'

export default function DropZone({ onClick }) {
  const { t } = useTranslation()
  return (
    <div
      className="drop-zone-message"
      role="button"
      tabIndex={0}
      aria-label={t('dropZone.ariaLabel')}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick(e)
        }
      }}
    >
      <div className="drop-zone-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4" />
          <path d="M8 8l4-4 4 4" />
          <path d="M20 21H4" />
          <path d="M20 16v5H4v-5" />
        </svg>
      </div>
      <div className="drop-zone-body">
        <p className="drop-zone-title">{t('dropZone.title')}</p>
        <p className="drop-zone-hint">{t('dropZone.hint')}</p>
      </div>
      <span className="drop-zone-cta">{t('dropZone.cta')}</span>
    </div>
  )
}
