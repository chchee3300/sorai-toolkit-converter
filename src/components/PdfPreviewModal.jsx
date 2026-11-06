import { Component, lazy, Suspense, useEffect, useRef } from 'react'
import { previewSrc } from '../plugin.js'
import { useTranslation } from '../hooks/useTranslation.js'

// Read-only look at a queued PDF (to pick page numbers for 擷取／旋轉):
// PdfViewer.jsx (pdf.js, lazy-loaded) reads it through sorai-media:// like
// Trim/Crop (preview.rs: application/pdf + CORS). Escape / the button close it.
const PdfViewer = lazy(() => import('./PdfViewer.jsx'))

// A viewer failure (chunk didn't load, pdf.js threw while rendering) shows
// here instead of unmounting the whole Converter (and its queue).
class ViewerBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    return this.state.error ? <p className="settings-hint" id="pdf-viewer-error">{String(this.state.error?.message ?? this.state.error)}</p> : this.props.children
  }
}

export default function PdfPreviewModal({ file, onClose }) {
  const { t } = useTranslation()
  const closeRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!file) return undefined
    const previouslyFocused = document.activeElement
    closeRef.current?.focus()
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [file])

  if (!file) return null
  const name = file.path.split(/[\\/]/).pop()
  return (
    <div className="modal-overlay" id="pdf-preview-modal">
      <div className="modal-content modal-lg" role="dialog" aria-modal="true" aria-labelledby="pdf-preview-title" tabIndex={-1}>
        <div className="modal-header">
          <h3 className="modal-title" id="pdf-preview-title">{name}</h3>
        </div>
        <div className="modal-body">
          <ViewerBoundary key={file.path}>
            <Suspense fallback={<p className="settings-hint">…</p>}>
              <PdfViewer url={previewSrc(file.path)} />
            </Suspense>
          </ViewerBoundary>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button ref={closeRef} className="btn btn-outline" id="btn-pdf-preview-close" onClick={onClose}>{t('pdfPreview.close')}</button>
        </div>
      </div>
    </div>
  )
}
