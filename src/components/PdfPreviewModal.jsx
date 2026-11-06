import { useEffect, useRef } from 'react'
import { previewSrc } from '../plugin.js'
import { useTranslation } from '../hooks/useTranslation.js'

// Read-only look at a queued PDF (to pick page numbers for 擷取／旋轉):
// the webview's own PDF viewer in an <iframe>, loaded through sorai-media://
// like Trim/Crop (preview.rs serves it as application/pdf). Escape / the
// button close it; Escape typed inside the viewer stays in the iframe.
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
          <iframe id="pdf-preview-frame" title={name} src={previewSrc(file.path)} style={{ width: '100%', height: '70vh', border: 0, borderRadius: 8 }} />
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button ref={closeRef} className="btn btn-outline" id="btn-pdf-preview-close" onClick={onClose}>{t('pdfPreview.close')}</button>
        </div>
      </div>
    </div>
  )
}
