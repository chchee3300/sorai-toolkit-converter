// Ported unchanged from resources/index.html:52-67. Visual dragover/
// drag-active states are handled globally by useFileManager's document-
// level listeners (toggling classes directly on #drop-zone/document.body,
// same as vanilla) — this component only needs the click-to-browse handler.
export default function DropZone({ onClick }) {
  return (
    <div className="drop-zone" id="drop-zone" onClick={onClick}>
      <div className="drop-zone-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4" />
          <path d="M8 8l4-4 4 4" />
          <path d="M20 21H4" />
          <path d="M20 16v5H4v-5" />
        </svg>
      </div>
      <div className="drop-zone-body">
        <p className="drop-zone-title">Drop files here</p>
        <p className="drop-zone-hint">Video · Image · Audio · PDF &mdash; same type per batch</p>
      </div>
      <span className="drop-zone-cta">Click to browse</span>
    </div>
  )
}
