import { useEffect, useRef } from 'react'
import { useTranslation } from '../hooks/useTranslation.js'

// Confirm-before-clearing dialog: shown when an incoming batch's file type
// (video/image/audio/pdf) differs from what's already loaded, instead of
// silently rejecting it with a plain alert() (see useFileManager.js's
// pendingMismatch/confirmClearAndLoad/cancelPendingMismatch). Reuses the
// same .modal-overlay/.modal-content/.modal-header/-body/-footer classes
// TrimModal.jsx established, and adapts its focus-trap/Escape/focus-restore
// pattern verbatim — Escape maps to onCancel (the non-destructive default:
// keep the current files), matching baseline-ui's "use an AlertDialog for
// destructive/irreversible actions" rule now that there's an actual
// destructive action (clearing the batch) to gate.
export default function MixedTypeModal({ open, existingType, incomingType, existingCount, incomingCount, onConfirm, onCancel }) {
  const { t } = useTranslation()
  const modalContentRef = useRef(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!open) return undefined
    const previouslyFocused = document.activeElement

    const getFocusable = () =>
      Array.from(
        modalContentRef.current?.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []
      )

    const focusable = getFocusable()
    ;(focusable[0] || modalContentRef.current)?.focus()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancelRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = getFocusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [open])

  return (
    <div className={open ? 'modal-overlay' : 'modal-overlay hidden'} id="mixed-type-modal">
      <div
        className="modal-content"
        ref={modalContentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mixed-type-modal-title"
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3 className="modal-title" id="mixed-type-modal-title">{t('mixedType.title')}</h3>
        </div>
        <div className="modal-body">
          <p>{t('mixedType.body', { existingCount, existingType, incomingCount, incomingType })}</p>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" id="btn-mixed-type-cancel" onClick={onCancel}>{t('mixedType.keepCurrent')}</button>
            <button className="btn btn-outline-danger" id="btn-mixed-type-confirm" onClick={onConfirm}>{t('mixedType.clearAndLoad', { incomingType })}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
