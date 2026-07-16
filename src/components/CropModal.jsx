import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from '../hooks/useTranslation.js'

// New (no vanilla precedent) — modeled on TrimModal.jsx's interaction shape:
// a preview mounted via Neutralino.server.mount, drag state mirrored into
// refs for stable window-level mousemove/mouseup listeners, and the same
// focus-trap/Escape accessibility block. Where TrimModal drags a 1D
// dual-thumb range, this drags a 2D rectangle (move + 4 corner handles).
//
// Rect state is always in the source image's *natural* pixel coordinates
// (same space as fileObj.width/height, already probed by useFileManager.js)
// — never CSS/display pixels — so it converts directly to buildImageCommand's
// crop=W:H:X:Y filter with no further scaling math. Render positions use
// percentages of the container, which stay correct regardless of how large
// the modal happens to render the image.
const MIN_SIZE = 10 // natural px — smallest crop dimension allowed

// Mouse-wheel zoom, for checking exact handle/edge placement against fine
// image detail. ZOOM_MIN is 1 (the fit-to-viewport size already shows the
// whole image, so zooming out further would just add empty padding).
// VIEWPORT_MAX_W/H size the *1x* (unzoomed) fit — a fixed box rather than
// something measured off the modal's actual rendered width, so the zoom-
// toward-cursor math (which needs a stable base size to scale from) never
// has to reconcile with a ResizeObserver mid-gesture.
const ZOOM_MIN = 1
const ZOOM_MAX = 6
const ZOOM_WHEEL_FACTOR = 1.15
const VIEWPORT_MAX_W = 720
const VIEWPORT_MAX_H = 440

// `label` is either literal text (the numeric ratios, which no language
// renames) or a dict key resolved through t() at render time (labelKey).
const RATIO_PRESETS = [
  { key: 'free', labelKey: 'cropModal.ratio.free', ratio: null },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
  { key: 'original', labelKey: 'cropModal.ratio.original', ratio: 'original' },
]

function centeredRectForRatio(ratio, imgW, imgH) {
  let w, h
  if (imgW / imgH > ratio) {
    h = imgH
    w = h * ratio
  } else {
    w = imgW
    h = w / ratio
  }
  return {
    x: Math.round((imgW - w) / 2),
    y: Math.round((imgH - h) / 2),
    width: Math.round(w),
    height: Math.round(h),
  }
}

function oppositeCorner(mode, r) {
  const west = mode.includes('w') // dragging a west handle -> anchor is the east side
  const north = mode.includes('n') // dragging a north handle -> anchor is the south side
  return {
    x: west ? r.x + r.width : r.x,
    y: north ? r.y + r.height : r.y,
  }
}

// Frosted-glass handles: a real see-through chip (light, low-opacity fill +
// backdrop blur + an inset highlight paired with an outer drop shadow for
// the "lifted" 3D look, same recipe as .panel/.btn-primary in styles.css),
// not a flat opaque square. Sits over the user's own photo (arbitrary
// colors), not the app's own dark chrome, so it uses a light, low-opacity
// fill rather than var(--glass-bg) -- at this handle's small footprint,
// var(--glass-bg)'s 65%-opacity dark tint dominated the whole chip and read
// as solid rather than translucent. Fill opacity and blur radius both kept
// low (not the panel's 14px-equivalent blur) so the underlying color still
// clearly reads through rather than washing out to a pale haze.
const HANDLE_STYLE_BASE = {
  position: 'absolute',
  width: 14,
  height: 14,
  background: 'rgba(255, 255, 255, 0.08)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  border: '1px solid rgba(255, 255, 255, 0.5)',
  borderRadius: 4,
  boxShadow: '0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.4)',
  zIndex: 2,
}

const HANDLE_POS = {
  nw: { left: -8, top: -8, cursor: 'nwse-resize' },
  ne: { right: -8, top: -8, cursor: 'nesw-resize' },
  sw: { left: -8, bottom: -8, cursor: 'nesw-resize' },
  se: { right: -8, bottom: -8, cursor: 'nwse-resize' },
}

// Dim/blur outside the crop rect via a *single* blurred clone of the image
// (regular CSS `filter`, not `backdrop-filter`) clipped with a rectangular
// cutout -- not four independent backdrop-filter divs (one per side). Four
// separately-composited backdrop-filter regions each blur/tint only their
// own box in isolation, so Chromium visibly seams at the shared edges
// between them (most noticeably right at the crop rect's corners, since
// that's exactly where e.g. the top strip and the side strips meet). A
// single filtered layer has no internal boundary to seam at -- the crop
// rect's own edge is the only boundary, which is supposed to be a hard line.
const DIM_FILTER = 'blur(3px) brightness(0.68) saturate(1.1)'

// Standard CSS "rectangle with a rectangular hole" clip-path: trace the
// outer 0-100% box, bridge in to the hole's top-left corner, trace the hole
// in the opposite winding direction (cancels out under the default nonzero
// fill rule, producing a hole), then bridge back out along the same seam.
function cutoutClipPath(leftPct, topPct, widthPct, heightPct) {
  const right = leftPct + widthPct
  const bottom = topPct + heightPct
  return `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% ${topPct}%, ${leftPct}% ${topPct}%, ${leftPct}% ${bottom}%, ${right}% ${bottom}%, ${right}% ${topPct}%, ${leftPct}% ${topPct}%, 0% ${topPct}%)`
}

// The container's rendered size at a given zoom, plus the (left, top)
// margin needed to center it in the fixed VIEWPORT_MAX_W/H box -- always 0
// once the container is large enough to fill/overflow that axis, so this
// never relies on any CSS auto-centering mechanism (flexbox
// align/justify-content, absolute-position + transform:translate) that
// centers *overflowing* content by clipping or hard-limiting scroll on the
// "before" side. A plain, always-non-negative computed margin keeps the
// image top-left-anchored in the scrollable coordinate space whenever it's
// large enough to need scrolling at all, so scrollLeft/scrollTop stay in
// their normal non-negative range and every part of the image stays
// reachable by panning. Pulled out as its own function (not inlined at each
// call site) so the wheel handler's "old size" and "new size" computations
// and the render's own layout can never drift from each other.
function computeFit(natW, natH, zoomVal) {
  const fitRatio = natW && natH ? Math.min(1, VIEWPORT_MAX_W / natW, VIEWPORT_MAX_H / natH) : 1
  const displayW = natW * fitRatio * zoomVal
  const displayH = natH * fitRatio * zoomVal
  return {
    displayW,
    displayH,
    marginLeft: Math.max(0, (VIEWPORT_MAX_W - displayW) / 2),
    marginTop: Math.max(0, (VIEWPORT_MAX_H - displayH) / 2),
  }
}

export default function CropModal({ open, file, onClose, onSave, onClear }) {
  const { t } = useTranslation()
  const imgRef = useRef(null)
  const dimImgRef = useRef(null)
  const containerRef = useRef(null)
  const viewportRef = useRef(null)
  const modalContentRef = useRef(null)

  const [naturalW, setNaturalW] = useState(0)
  const [naturalH, setNaturalH] = useState(0)
  const [rect, setRect] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [ratioKey, setRatioKey] = useState('free')
  const [dragMode, setDragMode] = useState(null) // 'move' | 'nw' | 'ne' | 'sw' | 'se' | null
  const [zoom, setZoom] = useState(1)
  // Raw text the user is currently typing into the W/H inputs, decoupled
  // from `rect` itself -- null means "not being edited, show rect's own
  // value". Without this, a controlled input bound directly to
  // Math.max(MIN_SIZE, ...)-clamped rect.width snaps back to MIN_SIZE the
  // instant the field is cleared (Number('') is 0, which is < MIN_SIZE),
  // before the user has typed a single new digit -- the min-size floor only
  // makes sense as a constraint on the FINAL committed value, not on every
  // intermediate keystroke while the field is briefly empty or small.
  const [widthDraft, setWidthDraft] = useState(null)
  const [heightDraft, setHeightDraft] = useState(null)

  const rectRef = useRef(rect)
  rectRef.current = rect
  const dragModeRef = useRef(dragMode)
  dragModeRef.current = dragMode
  const dragStartRef = useRef(null) // { pointer: {x,y}, rect: {...}, anchor: {x,y}|null }
  const naturalWRef = useRef(naturalW)
  naturalWRef.current = naturalW
  const naturalHRef = useRef(naturalH)
  naturalHRef.current = naturalH
  const ratioRef = useRef(null) // numeric w/h ratio, or null when free
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // Set by the wheel handler right before setZoom, consumed by the
  // useLayoutEffect below once the resized container has actually painted —
  // this is what keeps the point under the cursor visually still while
  // zooming, instead of always zooming toward the viewport's center.
  const pendingScrollRef = useRef(null)
  // Middle-mouse-button pan: { mouseX, mouseY, scrollLeft, scrollTop } while
  // active, null otherwise. Deliberately a *different* gesture from the
  // crop rect's own left-button move/resize (beginDrag bails out for any
  // non-left button — see its guard) so panning works even when the cursor
  // starts out on top of the crop rect or a handle.
  const panStartRef = useRef(null)

  // Open (or switch to a different file while open): mount the preview and
  // reset the rect from the file's own saved crop (or the full frame).
  // Ported-pattern from TrimModal.jsx's open/close effect, own mount path
  // ('/crop-preview' vs. Trim's '/preview') so the two modals never race
  // over the same Neutralino mount point.
  useEffect(() => {
    if (!open || !file) return undefined
    let cancelled = false

    const w = file.width || 0
    const h = file.height || 0
    setNaturalW(w)
    setNaturalH(h)
    setRect(file.crop ? { ...file.crop } : { x: 0, y: 0, width: w, height: h })
    setRatioKey('free')
    ratioRef.current = null
    setZoom(1)
    setWidthDraft(null)
    setHeightDraft(null)
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0
      viewportRef.current.scrollTop = 0
    }

    const filename = file.path.split(/[\\/]/).pop()
    let lastSlash = file.path.lastIndexOf('\\')
    if (lastSlash === -1) lastSlash = file.path.lastIndexOf('/')
    const dirPath = file.path.substring(0, lastSlash)

    ;(async () => {
      try {
        await window.Neutralino.server.mount('/crop-preview', dirPath)
        if (cancelled) return
        const fileUrl = `http://localhost:${window.NL_PORT}/crop-preview/${encodeURIComponent(filename)}`
        if (imgRef.current) imgRef.current.src = fileUrl
        if (dimImgRef.current) dimImgRef.current.src = fileUrl
      } catch (e) {
        console.error('Failed to mount for crop preview:', e)
        alert('Could not load preview. Is local server disabled?')
      }
    })()

    return () => {
      cancelled = true
      window.Neutralino.server.unmount('/crop-preview').catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.path])

  // Escape closes, Tab/Shift+Tab is trapped inside — copied near-verbatim
  // from TrimModal.jsx, which is itself generic (not video-specific).
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
        onCloseRef.current()
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

  // Drag logic — global mousemove/mouseup, recomputing the container's
  // bounding rect on every move (same "always re-measure" approach
  // TrimModal's getSecondsFromX uses) so window resizes never desync it.
  useEffect(() => {
    const getNaturalPoint = (clientX, clientY) => {
      const el = containerRef.current
      if (!el || naturalWRef.current <= 0 || naturalHRef.current <= 0) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      const scaleX = naturalWRef.current / r.width
      const scaleY = naturalHRef.current / r.height
      let x = (clientX - r.left) * scaleX
      let y = (clientY - r.top) * scaleY
      x = Math.max(0, Math.min(naturalWRef.current, x))
      y = Math.max(0, Math.min(naturalHRef.current, y))
      return { x, y }
    }

    const onMouseMove = (e) => {
      const mode = dragModeRef.current
      const start = dragStartRef.current
      if (!mode || !start) return
      const pt = getNaturalPoint(e.clientX, e.clientY)
      const natW = naturalWRef.current
      const natH = naturalHRef.current

      if (mode === 'move') {
        const dx = pt.x - start.pointer.x
        const dy = pt.y - start.pointer.y
        const nx = Math.max(0, Math.min(natW - start.rect.width, start.rect.x + dx))
        const ny = Math.max(0, Math.min(natH - start.rect.height, start.rect.y + dy))
        setRect({ x: Math.round(nx), y: Math.round(ny), width: start.rect.width, height: start.rect.height })
        return
      }

      // Resizing a corner: the opposite corner (start.anchor) stays fixed;
      // the dragged corner follows the pointer, optionally ratio-locked by
      // deriving height from the width delta.
      const anchor = start.anchor
      let px = pt.x
      let py = pt.y

      let rawW = Math.max(MIN_SIZE, Math.abs(px - anchor.x))
      let rawH = Math.abs(py - anchor.y)
      const ratio = ratioRef.current
      if (ratio) {
        rawH = rawW / ratio
        py = anchor.y + (py >= anchor.y ? rawH : -rawH)
      }
      rawH = Math.max(MIN_SIZE, rawH)

      let x = Math.min(anchor.x, px)
      let y = Math.min(anchor.y, py)
      let width = rawW
      let height = rawH

      if (x < 0) {
        width += x
        x = 0
      }
      if (y < 0) {
        height += y
        y = 0
      }
      if (x + width > natW) width = natW - x
      if (y + height > natH) height = natH - y

      setRect({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(MIN_SIZE, width)),
        height: Math.round(Math.max(MIN_SIZE, height)),
      })
    }

    const onMouseUp = () => {
      if (dragModeRef.current) {
        setDragMode(null)
        dragStartRef.current = null
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Wheel-to-zoom, centered on the cursor (not the viewport middle) so
  // scrolling in while hovering a handle/edge zooms in on exactly that
  // spot. Registered natively with { passive: false } — React's synthetic
  // wheel listener is passive by default, which would silently no-op
  // preventDefault() and let the page behind the modal scroll too.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined

    const onWheel = (e) => {
      e.preventDefault()
      const oldZoom = zoomRef.current
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor))
      if (newZoom === oldZoom || !containerRef.current) return

      // Where the cursor sits as a *fraction* of the image's current
      // on-screen box (containerRef's own getBoundingClientRect, which
      // already reflects margin + scroll + everything else resolved) --
      // stays meaningful across the resize regardless of how the centering
      // margin itself changes between the old and new zoom level.
      const containerRectNow = containerRef.current.getBoundingClientRect()
      const fracX = (e.clientX - containerRectNow.left) / containerRectNow.width
      const fracY = (e.clientY - containerRectNow.top) / containerRectNow.height

      const { displayW: newW, displayH: newH, marginLeft: newMarginLeft, marginTop: newMarginTop } = computeFit(
        naturalWRef.current,
        naturalHRef.current,
        newZoom,
      )
      const viewportRectNow = el.getBoundingClientRect()
      // Solve for the scrollLeft/scrollTop that puts the same fractional
      // point of the (now newW x newH) image back under the cursor.
      const desiredImageLeft = e.clientX - fracX * newW
      const desiredImageTop = e.clientY - fracY * newH
      pendingScrollRef.current = {
        left: viewportRectNow.left + newMarginLeft - desiredImageLeft,
        top: viewportRectNow.top + newMarginTop - desiredImageTop,
      }
      setZoom(newZoom)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Middle-mouse-button drag-to-pan. Attached to the viewport itself (not
  // the crop rect), and bubbles up from the rect/handles unimpeded since
  // beginDrag's e.button guard above lets non-left clicks pass through —
  // so panning works everywhere in the preview, including on top of the
  // current selection, without ever nudging the crop rect itself.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined

    const onMouseDown = (e) => {
      if (e.button !== 1) return
      e.preventDefault() // suppress the browser's native middle-click autoscroll icon
      panStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      }
    }

    const onMouseMove = (e) => {
      const start = panStartRef.current
      if (!start) return
      el.scrollLeft = start.scrollLeft - (e.clientX - start.mouseX)
      el.scrollTop = start.scrollTop - (e.clientY - start.mouseY)
    }

    const onMouseUp = (e) => {
      if (e.button === 1) panStartRef.current = null
    }

    // mousedown is native+non-passive on the viewport (needs preventDefault
    // to stop the OS/browser middle-click gesture); move/up listen on
    // window, same "don't lose the drag if the cursor leaves the element"
    // reasoning as the crop rect's own drag effect above.
    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Applies pendingScrollRef's target *after* the zoom-resized container has
  // painted (useLayoutEffect, not useEffect, so it happens before the
  // browser shows the frame — no visible jump-then-correct).
  useLayoutEffect(() => {
    if (pendingScrollRef.current && viewportRef.current) {
      viewportRef.current.scrollLeft = pendingScrollRef.current.left
      viewportRef.current.scrollTop = pendingScrollRef.current.top
      pendingScrollRef.current = null
    }
  }, [zoom])

  const beginDrag = (mode, e) => {
    // Left button only — a middle-click on the rect/a handle must fall
    // through untouched so it reaches the pan handler below instead of
    // starting a crop move/resize.
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = containerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const scaleX = naturalWRef.current / r.width
    const scaleY = naturalHRef.current / r.height
    const pointer = {
      x: Math.max(0, Math.min(naturalWRef.current, (e.clientX - r.left) * scaleX)),
      y: Math.max(0, Math.min(naturalHRef.current, (e.clientY - r.top) * scaleY)),
    }
    const anchor = mode === 'move' ? null : oppositeCorner(mode, rectRef.current)
    dragStartRef.current = { pointer, rect: { ...rectRef.current }, anchor }
    setDragMode(mode)
    // A drag is the authoritative source of the rect while it's happening --
    // drop any in-progress typed draft so the W/H inputs show the live
    // dragged value instead of stale unsubmitted text.
    setWidthDraft(null)
    setHeightDraft(null)
  }

  const applyRatioPreset = (preset) => {
    setRatioKey(preset.key)
    setWidthDraft(null)
    setHeightDraft(null)
    if (preset.ratio === null) {
      ratioRef.current = null
      return
    }
    const ratio = preset.ratio === 'original' ? naturalW / naturalH || 1 : preset.ratio
    ratioRef.current = ratio
    if (naturalW > 0 && naturalH > 0) {
      setRect(centeredRectForRatio(ratio, naturalW, naturalH))
    }
  }

  const handleClear = () => {
    setRect({ x: 0, y: 0, width: naturalW, height: naturalH })
    setRatioKey('free')
    ratioRef.current = null
    setWidthDraft(null)
    setHeightDraft(null)
    if (onClear) onClear()
  }

  // Manual width/height entry -- the input's displayed text is the draft
  // state (whatever the user literally typed, including empty), not rect
  // itself, so clearing the field to type a fresh number never gets
  // overwritten mid-edit. While a value parses to something usable, the
  // rect's own width/height updates live (capped against how much room is
  // left from the rect's CURRENT x/y to the image edge, so the crop can't
  // visually exceed the source) -- but WITHOUT the MIN_SIZE floor, so
  // typing "1" then "5" then "0" toward "150" never gets bumped to 10
  // partway through. MIN_SIZE (and falling back to the prior value if left
  // empty/invalid) is only enforced once the field is committed, in
  // commitWidthDraft/commitHeightDraft below.
  const handleWidthInput = (e) => {
    const text = e.target.value
    setWidthDraft(text)
    const raw = Number(text)
    if (text.trim() !== '' && Number.isFinite(raw) && raw > 0) {
      setRatioKey('free')
      ratioRef.current = null
      setRect((r) => ({ ...r, width: Math.min(Math.round(raw), naturalW - r.x) }))
    }
  }

  const handleHeightInput = (e) => {
    const text = e.target.value
    setHeightDraft(text)
    const raw = Number(text)
    if (text.trim() !== '' && Number.isFinite(raw) && raw > 0) {
      setRatioKey('free')
      ratioRef.current = null
      setRect((r) => ({ ...r, height: Math.min(Math.round(raw), naturalH - r.y) }))
    }
  }

  // Commit on blur (or Enter, via the input's onKeyDown below): clamps the
  // final value up to MIN_SIZE, and falls back to whatever rect already had
  // if the field was left empty/invalid rather than forcing an arbitrary
  // minimum crop out of nowhere.
  const commitWidthDraft = () => {
    if (widthDraft === null) return
    const raw = Number(widthDraft)
    if (Number.isFinite(raw) && raw > 0) {
      setRect((r) => ({ ...r, width: Math.min(Math.max(MIN_SIZE, Math.round(raw)), naturalW - r.x) }))
    }
    setWidthDraft(null)
  }

  const commitHeightDraft = () => {
    if (heightDraft === null) return
    const raw = Number(heightDraft)
    if (Number.isFinite(raw) && raw > 0) {
      setRect((r) => ({ ...r, height: Math.min(Math.max(MIN_SIZE, Math.round(raw)), naturalH - r.y) }))
    }
    setHeightDraft(null)
  }

  const resetZoom = () => {
    setZoom(1)
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0
      viewportRef.current.scrollTop = 0
    }
  }

  const handleSave = () => {
    const isFullFrame = rect.x === 0 && rect.y === 0 && rect.width === naturalW && rect.height === naturalH
    if (onSave) {
      onSave(
        isFullFrame
          ? undefined
          : { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      )
    }
    onClose()
  }

  const leftPct = naturalW ? (rect.x / naturalW) * 100 : 0
  const topPct = naturalH ? (rect.y / naturalH) * 100 : 0
  const widthPct = naturalW ? (rect.width / naturalW) * 100 : 100
  const heightPct = naturalH ? (rect.height / naturalH) * 100 : 100

  // The container's *rendered* pixel size and centering margins, computed
  // analytically (fit the natural image into a fixed box, never upscaling
  // past 1:1 at zoom==1) rather than measured off the DOM -- so
  // beginDrag/getNaturalPoint's own getBoundingClientRect() calls always
  // see a size that already matches what this render is about to paint,
  // with no read-after-write race.
  const { displayW, displayH, marginLeft, marginTop } = computeFit(naturalW, naturalH, zoom)

  return (
    <div className={open ? 'modal-overlay' : 'modal-overlay hidden'} id="crop-modal">
      <div
        className="modal-content modal-lg"
        ref={modalContentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-modal-title"
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3 className="modal-title" id="crop-modal-title">{t('cropModal.title')}</h3>
          <span
            id="crop-zoom-label"
            className="tabular-nums"
            title={t('cropModal.resetZoomHint')}
            style={{ marginLeft: 'auto', fontSize: '0.8em', color: zoom > 1 ? 'var(--accent)' : 'var(--text-muted)' }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <span id="crop-dims-label" className="tabular-nums" style={{ marginLeft: 10, fontSize: '0.85em', color: 'var(--text-muted)' }}>
            {Math.round(rect.width)} x {Math.round(rect.height)}
          </span>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {RATIO_PRESETS.map((preset) => (
              <button
                key={preset.key}
                id={`crop-ratio-${preset.key}`}
                type="button"
                className="btn btn-outline btn-xs"
                style={
                  ratioKey === preset.key
                    ? { background: 'var(--accent-dim)', borderColor: 'var(--accent)', color: 'var(--accent)' }
                    : undefined
                }
                onClick={() => applyRatioPreset(preset)}
              >
                {preset.labelKey ? t(preset.labelKey) : preset.label}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: '0.75em', color: 'var(--text-muted)' }}>
              {t('cropModal.controlsHint')}
            </span>
          </div>

          {/* Manual width/height entry -- defaults to the full natural
              image size (see the open effect's setRect), editable directly
              instead of only via drag. Displayed value is the draft text the
              user is actively typing (widthDraft/heightDraft), not rect
              itself -- see the state declarations above for why: a value
              bound straight to a MIN_SIZE-clamped rect snaps back to 10 the
              instant the field is cleared, before a new digit is typed.
              MIN_SIZE and the image-edge clamp are enforced on commit
              (blur, or Enter -- see commitWidthDraft/commitHeightDraft). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <label htmlFor="crop-width-input" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75em', color: 'var(--text-muted)' }}>
              {t('cropModal.width')}
              <input
                id="crop-width-input"
                type="number"
                className="input tabular-nums"
                style={{ width: 76 }}
                min={MIN_SIZE}
                max={naturalW - rect.x}
                step={1}
                value={widthDraft ?? Math.round(rect.width)}
                disabled={!naturalW || !naturalH}
                onChange={handleWidthInput}
                onBlur={commitWidthDraft}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
            </label>
            <label htmlFor="crop-height-input" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75em', color: 'var(--text-muted)' }}>
              {t('cropModal.height')}
              <input
                id="crop-height-input"
                type="number"
                className="input tabular-nums"
                style={{ width: 76 }}
                min={MIN_SIZE}
                max={naturalH - rect.y}
                step={1}
                value={heightDraft ?? Math.round(rect.height)}
                disabled={!naturalW || !naturalH}
                onChange={handleHeightInput}
                onBlur={commitHeightDraft}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
            </label>
            {/* btn-outline (bordered), not btn-ghost -- sitting inline next
                to bordered W/H inputs, a borderless ghost button read as
                disconnected/floating; outline matches the ratio-preset
                row's own button style directly above it. */}
            <button id="btn-clear-crop" className="btn btn-outline btn-xs" style={{ marginLeft: 'auto' }} onClick={handleClear}>
              {t('cropModal.clearCrop')}
            </button>
          </div>

          {/* Viewport: a genuinely fixed-size window (VIEWPORT_MAX_W x
              VIEWPORT_MAX_H, not '100%' x a max-height — the modal must
              never resize as zoom changes, and computeFit's own centering
              math assumes this exact box size, so the two must match
              exactly rather than one being a live/'100%' measurement and
              the other a constant) with overflow:hidden, not overflow:auto.
              A native scrollbar would still have kept this box's own size
              fixed, but reserving/unreserving its track width on demand
              shifts the visible content by a few pixels when zoom changes
              -- reads as "the window resized." Panning is fully
              programmatic instead (wheel-zoom's cursor-anchoring above, and
              middle-drag below), so no scrollbar affordance is needed for
              navigation anyway. This outer margin:auto (unlike
              computeFit's marginLeft/marginTop on the container below) is
              safe against the same "can't scroll to the overflowing side"
              class of bug: this box is always <= its own parent's width, so
              it never actually overflows anything. */}
          <div
            ref={viewportRef}
            onDoubleClick={resetZoom}
            style={{ width: VIEWPORT_MAX_W, maxWidth: '100%', height: VIEWPORT_MAX_H, margin: '0 auto', overflow: 'hidden', background: 'rgba(0,0,0,0.15)', borderRadius: 4 }}
          >
            {/* marginLeft/marginTop are computeFit's explicit centering
                offsets (both axes), not CSS auto-centering (margin:auto,
                text-align:center, or flexbox align/justify-content) -- see
                computeFit's own comment for why: those all either clip or
                hard-limit scrolling into the "before" side of overflowing
                centered content, which would silently make part of a
                zoomed-in image unreachable by panning. */}
            <div
              id="crop-container"
              ref={containerRef}
              style={{ position: 'relative', display: 'block', marginLeft, marginTop, userSelect: 'none', width: displayW, height: displayH }}
            >
              <img
                ref={imgRef}
                alt=""
                draggable={false}
                style={{ display: 'block', width: '100%', height: '100%' }}
              />

              {/* Dim/blur the region outside the crop rect: one continuously
                  filtered clone of the image, clipped with a rectangular hole
                  at the crop rect — see cutoutClipPath's comment for why this
                  replaced four independent backdrop-filter divs (seam at
                  their shared edges, right where the corner handles sit). */}
              <img
                ref={dimImgRef}
                alt=""
                draggable={false}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  filter: DIM_FILTER,
                  clipPath: cutoutClipPath(leftPct, topPct, widthPct, heightPct),
                  pointerEvents: 'none',
                }}
              />

              <div
                id="crop-rect"
                style={{
                  position: 'absolute',
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${widthPct}%`,
                  height: `${heightPct}%`,
                  border: '2px solid var(--accent)',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35), 0 4px 16px -4px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.2)',
                  boxSizing: 'border-box',
                  cursor: 'move',
                }}
                onMouseDown={(e) => beginDrag('move', e)}
              >
                {Object.keys(HANDLE_POS).map((corner) => (
                  <div
                    key={corner}
                    id={`crop-handle-${corner}`}
                    style={{ ...HANDLE_STYLE_BASE, ...HANDLE_POS[corner] }}
                    onMouseDown={(e) => beginDrag(corner, e)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          {/* Clear Crop moved up next to the W/H inputs -- .modal-footer's
              own justify-content:space-between assumed two children, so
              with only Cancel/Save left it needs an explicit marginLeft:
              auto to stay pinned right instead of collapsing to the start. */}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className="btn btn-outline" onClick={onClose}>{t('cropModal.cancel')}</button>
            <button className="btn btn-primary" onClick={handleSave}>{t('cropModal.save')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
