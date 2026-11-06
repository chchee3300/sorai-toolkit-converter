import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getDocument, PDFWorker } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { useTranslation } from '../hooks/useTranslation.js'

// pdf.js viewer for PdfPreviewModal (lazy-loaded: pdf.js + its worker are
// ~1.5 MB, only fetched when a preview opens). Our own floating navbar, so
// only page number + zoom (the webview's built-in viewer can't hide its
// search / print / save / settings buttons one by one). Each page has a
// "page N" label for picking 擷取／旋轉 ranges. Pages render to <canvas>
// when they scroll near the view, so long PDFs open fast.
//
// Shortcuts (while the preview is open): Ctrl+wheel zoom at the cursor,
// Ctrl+= / Ctrl+- zoom, Ctrl+0 fit width, ←/→ and PageUp/PageDown previous /
// next page, Home/End first / last page, ↑/↓ scroll (native), Esc closes
// (PdfPreviewModal).

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const WHEEL_FACTOR = 1.1
// Keep in sync with .pdf-viewer-scroll's side padding (hub styles.css).
const PAD_X = 12

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
const icon = (children) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export default function PdfViewer({ url }) {
  const { t } = useTranslation()
  const scrollRef = useRef(null)
  const [doc, setDoc] = useState(null)
  const [sizes, setSizes] = useState([]) // page sizes at scale 1 (pt)
  const [scale, setScale] = useState(null) // null = fit width
  const [fitScale, setFitScale] = useState(1)
  const [current, setCurrent] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoomInput, setZoomInput] = useState(null) // text being typed; null = show the zoom
  const [error, setError] = useState('')

  useEffect(() => {
    let gone = false
    // Whole file in one request: the preview scheme answers Range, but CORS
    // doesn't expose Content-Range, so pdf.js's range mode can't use it.
    // One worker per open document, ended with it. (A shared
    // GlobalWorkerOptions.workerPort dies with the first task.destroy(), and
    // the next getDocument then throws "the worker is being destroyed" --
    // StrictMode's double mount hit that on every open.)
    const raw = new PdfWorker()
    const worker = new PDFWorker({ port: raw })
    const task = getDocument({ url, worker, disableRange: true, disableStream: true })
    task.promise
      .then(async (d) => {
        const all = []
        for (let i = 1; i <= d.numPages; i++) {
          const v = (await d.getPage(i)).getViewport({ scale: 1 })
          all.push({ w: v.width, h: v.height })
        }
        if (!gone) {
          setDoc(d)
          setSizes(all)
        }
      })
      .catch((e) => !gone && setError(String(e?.message ?? e)))
    return () => {
      gone = true
      // pdf.js doesn't terminate a worker it was handed as a port.
      task.destroy().finally(() => {
        worker.destroy()
        raw.terminate()
      })
    }
  }, [url])

  // Fit width = widest page fills the scroll area.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !sizes.length) return undefined
    const fit = () => setFitScale(Math.max(0.1, (el.clientWidth - 2 * PAD_X - 2) / Math.max(...sizes.map((s) => s.w))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sizes])

  const zoom = scale ?? fitScale
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Zoom keeping the point under `anchor` (scroll-area px; default: the
  // view's centre) where it was.
  const anchorRef = useRef(null)
  const zoomTo = useCallback((z, anchor) => {
    const el = scrollRef.current
    if (!el) return
    const a = anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
    anchorRef.current = { ...a, fx: (el.scrollLeft + a.x) / el.scrollWidth, fy: (el.scrollTop + a.y) / el.scrollHeight }
    setScale(z == null ? null : clampZoom(z))
  }, [])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchorRef.current
    if (!el || !a) return
    anchorRef.current = null
    el.scrollLeft = a.fx * el.scrollWidth - a.x
    el.scrollTop = a.fy * el.scrollHeight - a.y
  }, [zoom])

  const step = useCallback((dir) => {
    const z = zoomRef.current
    const next = dir > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.01) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.01) ?? ZOOM_MIN)
    zoomTo(next)
  }, [zoomTo])

  // Ctrl+wheel: zoom at the cursor (a non-passive listener, so the webview
  // doesn't scroll / zoom the whole page instead).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(zoomRef.current * (e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // Current page = the one crossing the middle of the view.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const mid = el.scrollTop + el.clientHeight / 2
    for (let i = 1; i <= sizes.length; i++) {
      const p = document.getElementById(`pdf-page-${i}`)
      if (p && p.offsetTop + p.offsetHeight >= mid) {
        setCurrent(i)
        setPageInput(String(i))
        return
      }
    }
  }, [sizes])

  const goTo = useCallback((n) => {
    const p = Math.min(Math.max(1, n), sizes.length)
    const el = scrollRef.current
    const box = document.getElementById(`pdf-page-${p}`)
    // Below the floating navbar, not under it.
    if (el && box) el.scrollTop = box.offsetTop - parseFloat(getComputedStyle(el).paddingTop)
    // Now, not at the next render: the page box's onBlur (Enter moves focus
    // away) runs before React re-renders and would reset it to the old page.
    currentRef.current = p
    setCurrent(p)
    setPageInput(String(p))
  }, [sizes])

  const currentRef = useRef(current)
  currentRef.current = current
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey
      const typing = e.target instanceof HTMLInputElement
      let handled = true
      if (mod && (e.key === '=' || e.key === '+')) step(1)
      else if (mod && e.key === '-') step(-1)
      else if (mod && e.key === '0') zoomTo(null)
      else if (mod || e.altKey || typing) handled = false
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(currentRef.current + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(currentRef.current - 1)
      else if (e.key === 'Home') goTo(1)
      else if (e.key === 'End') goTo(Infinity)
      else handled = false
      if (handled) e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, zoomTo, goTo])

  // Focus the pages once loaded, so ↑/↓ scroll right away.
  useEffect(() => {
    if (doc) scrollRef.current?.focus({ preventScroll: true })
  }, [doc])

  // Tooltip: "Zoom in (Ctrl +)".
  const tip = (name) => `${t(`pdfPreview.${name}`)} (${t(`pdfPreview.key.${name}`)})`
  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-navbar" role="toolbar" aria-label={t('pdfPreview.toolbar')}>
        <button type="button" className="btn-icon" id="pdf-prev-page" disabled={current <= 1} onClick={() => goTo(current - 1)} title={tip('prevPage')} aria-label={t('pdfPreview.prevPage')}>
          {icon(<polyline points="15 18 9 12 15 6"></polyline>)}
        </button>
        <input
          id="pdf-page-input"
          className="input pdf-viewer-page-input"
          inputMode="numeric"
          value={pageInput}
          aria-label={t('pdfPreview.page')}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            goTo(Number(pageInput) || 1)
            scrollRef.current?.focus({ preventScroll: true })
          }}
          onBlur={() => setPageInput(String(currentRef.current))}
        />
        <span className="pdf-viewer-num" id="pdf-page-count">/ {sizes.length || '…'}</span>
        <button type="button" className="btn-icon" id="pdf-next-page" disabled={current >= sizes.length} onClick={() => goTo(current + 1)} title={tip('nextPage')} aria-label={t('pdfPreview.nextPage')}>
          {icon(<polyline points="9 18 15 12 9 6"></polyline>)}
        </button>
        <div className="pdf-viewer-divider" aria-hidden="true"></div>
        <button type="button" className="btn-icon" id="pdf-zoom-out" disabled={zoom <= ZOOM_MIN + 0.001} onClick={() => step(-1)} title={tip('zoomOut')} aria-label={t('pdfPreview.zoomOut')}>
          {icon(<line x1="5" y1="12" x2="19" y2="12"></line>)}
        </button>
        <label className="pdf-viewer-zoom">
          <input
            id="pdf-zoom-input"
            className="input pdf-viewer-page-input"
            inputMode="numeric"
            value={zoomInput ?? String(Math.round(zoom * 100))}
            aria-label={t('pdfPreview.zoom')}
            title={t('pdfPreview.zoomHint')}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setZoomInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setZoomInput(null)
                scrollRef.current?.focus({ preventScroll: true })
              }
              if (e.key !== 'Enter') return
              const pct = Number(zoomInput)
              if (pct > 0) zoomTo(pct / 100)
              setZoomInput(null)
              scrollRef.current?.focus({ preventScroll: true })
            }}
            onBlur={() => setZoomInput(null)}
          />
          <span className="pdf-viewer-num">%</span>
        </label>
        <button type="button" className="btn-icon" id="pdf-zoom-in" disabled={zoom >= ZOOM_MAX - 0.001} onClick={() => step(1)} title={tip('zoomIn')} aria-label={t('pdfPreview.zoomIn')}>
          {icon(<><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></>)}
        </button>
        <div className="pdf-viewer-divider" aria-hidden="true"></div>
        <button type="button" className="btn btn-outline btn-xs" id="pdf-zoom-fit" disabled={scale == null} onClick={() => zoomTo(null)} title={tip('fitWidth')}>{t('pdfPreview.fitWidth')}</button>
      </div>
      <div ref={scrollRef} id="pdf-viewer-scroll" className="pdf-viewer-scroll" tabIndex={-1} onScroll={onScroll}>
        {error && <p className="settings-hint" id="pdf-viewer-error">{error}</p>}
        {doc &&
          sizes.map((s, i) => (
            <PdfPage key={i} doc={doc} n={i + 1} width={s.w * zoom} height={s.h * zoom} zoom={zoom} root={scrollRef} label={t('pdfPreview.pageLabel', { n: i + 1 })} />
          ))}
      </div>
    </div>
  )
}

// One page: a sized box (so the scroll height is right before rendering),
// drawn to canvas once it comes within a screen of the view, and redrawn
// when the zoom changes.
function PdfPage({ doc, n, width, height, zoom, root, label }) {
  const boxRef = useRef(null)
  const canvasRef = useRef(null)
  const [near, setNear] = useState(false)
  const drawn = useRef(false)

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { root: root.current, rootMargin: '100% 0px' })
    io.observe(boxRef.current)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!near) return undefined
    let task
    let gone = false
    // Ctrl+wheel changes the zoom many times a second: the CSS size follows
    // at once, the canvas is redrawn once it settles (first draw: no wait).
    const timer = setTimeout(() => doc.getPage(n).then((page) => {
      if (gone) return
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: zoom * dpr })
      const canvas = canvasRef.current
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      task = page.render({ canvas, viewport })
      drawn.current = true
      task.promise.catch(() => {}) // cancelled by a newer zoom
    }), drawn.current ? 120 : 0)
    return () => {
      clearTimeout(timer)
      gone = true
      task?.cancel()
    }
  }, [doc, n, zoom, near])

  return (
    <div ref={boxRef} id={`pdf-page-${n}`} className="pdf-page" style={{ width }}>
      <canvas ref={canvasRef} data-page={n} style={{ width, height }} />
      <div className="pdf-viewer-num pdf-page-label">{label}</div>
    </div>
  )
}
