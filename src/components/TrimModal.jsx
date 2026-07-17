import { useEffect, useRef, useState } from 'react'
import { rangeFillStyle } from '../lib/rangeFill.js'
import { useTranslation } from '../hooks/useTranslation.js'

// Ported unchanged from resources/index.html:253-312 (markup) and main.js's
// Trim Modal Logic (main.js:538-867 pre-extraction) — the most complex
// interactive widget in the app: a custom dual-thumb drag slider + video/
// audio preview player mounted via Neutralino.server.mount. Kept as one
// component (matches the vanilla code's single cohesive-widget structure)
// rather than split further. `formatTrimTime`/`parseTrimTime` were dead
// code in main.js (defined, never called anywhere) — not ported, no
// behavior to preserve.
//
// Design choices vs. the vanilla imperative version, both logged in
// design-system/MASTER.md:
// - trimStart/trimEnd (and everything derived from them: thumb positions,
//   range/dim overlays, labels) are React state, driving the same
//   inline-style positioning declaratively instead of an imperative
//   updateSliderUI() DOM-write function.
// - The playhead position, updated on every 'timeupdate' during playback
//   (much higher frequency and longer-running than a drag gesture), stays
//   a direct ref-based DOM write to avoid a re-render per frame — same
//   performance profile as the vanilla version's direct style write.
function formatTrimLabel(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0.0s'
  return seconds.toFixed(1) + 's'
}

// Magnet-snap radius for dragging a trim thumb onto the playhead, in
// screen pixels (not seconds) so it feels the same regardless of the
// clip's duration or the slider's current width -- same convention as
// Premiere's own snap radius.
const SNAP_PX = 8

export default function TrimModal({ open, file, fileType, onClose, onSave, onClear }) {
  const { t } = useTranslation()
  const vidRef = useRef(null)
  const audRef = useRef(null)
  const activePlayerRef = useRef(null)
  const sliderContainerRef = useRef(null)
  const thumbLeftRef = useRef(null)
  const thumbRightRef = useRef(null)
  const playheadRef = useRef(null)
  const modalContentRef = useRef(null)

  const [duration, setDuration] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLooping, setIsLooping] = useState(true)
  const [volume, setVolume] = useState(1.0)
  const [muted, setMuted] = useState(false)
  const [draggingThumb, setDraggingThumb] = useState(null) // 'left' | 'right' | 'playhead' | null

  const previousVolumeRef = useRef(1.0)

  // Refs mirror state for the stable, once-registered global listeners
  // below (mousemove/mouseup/timeupdate), which must read the *latest*
  // values without re-subscribing on every state change.
  const trimStartRef = useRef(trimStart)
  trimStartRef.current = trimStart
  const trimEndRef = useRef(trimEnd)
  trimEndRef.current = trimEnd
  const durationRef = useRef(duration)
  durationRef.current = duration
  const isLoopingRef = useRef(isLooping)
  isLoopingRef.current = isLooping
  const draggingThumbRef = useRef(draggingThumb)
  draggingThumbRef.current = draggingThumb
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Loop mode replays [trimStart, trimEnd] on natural playback, but a
  // manual seek (click or playhead drag) past trimEnd is deliberate --
  // the user is checking whether to extend the selection, not asking to
  // be bounced back to the start. Set true whenever a manual seek lands
  // outside the range, false once one lands back inside it; onTimeUpdate
  // only auto-loops while this is false, so playback that's already
  // outside the range on its own (dragged there, or left playing past
  // the boundary) is never forced back.
  const suppressLoopRef = useRef(false)
  // Premiere-style magnet snap: wherever the playhead sits when a trim
  // thumb drag starts is captured once (thumb mousedown) as a fixed
  // target, not re-read live during the drag -- dragging a thumb also
  // seeks the preview to follow it (see the bottom of onMouseMove below),
  // so a live read would just always equal the thumb's own position and
  // never actually snap to anything. null when no target is armed (drag
  // didn't start from a thumb, or there's no active player yet).
  const snapTargetRef = useRef(null)

  // Open (or switch to a different file while open): reset players, reset
  // trim range from the file's own saved trimStart/trimEnd (or full range),
  // mount the preview server, set player src. Cleanup (close, switch file,
  // or unmount): pause + unmount. Ported unchanged from main.js's
  // openTrimModal/closeTrimModal (main.js:595-655 pre-extraction).
  useEffect(() => {
    if (!open || !file) return undefined
    let cancelled = false

    const vid = vidRef.current
    const aud = audRef.current
    vid.classList.add('hidden')
    aud.classList.add('hidden')
    vid.pause()
    aud.pause()
    vid.removeAttribute('src')
    aud.removeAttribute('src')

    const fileDuration = file.duration || 0
    setDuration(fileDuration)
    setTrimStart(file.trimStart !== undefined ? file.trimStart : 0)
    setTrimEnd(file.trimEnd !== undefined ? file.trimEnd : fileDuration)
    suppressLoopRef.current = false

    const filename = file.path.split(/[\\/]/).pop()
    let lastSlash = file.path.lastIndexOf('\\')
    if (lastSlash === -1) lastSlash = file.path.lastIndexOf('/')
    const dirPath = file.path.substring(0, lastSlash)

    ;(async () => {
      try {
        await window.Neutralino.server.mount('/preview', dirPath)
        if (cancelled) return
        const fileUrl = `http://localhost:${window.NL_PORT}/preview/${encodeURIComponent(filename)}`
        const player = fileType === 'video' ? vid : aud
        activePlayerRef.current = player
        player.classList.remove('hidden')
        player.src = fileUrl
        player.load()
        player.volume = volume
      } catch (e) {
        console.error('Failed to mount for preview:', e)
        alert('Could not load preview. Is local server disabled?')
      }
    })()

    return () => {
      cancelled = true
      if (activePlayerRef.current) {
        activePlayerRef.current.pause()
        activePlayerRef.current = null
      }
      window.Neutralino.server.unmount('/preview').catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.path, fileType])

  // Accessibility (Phase 3 fixing-accessibility pass, additive — vanilla
  // never had this): Escape closes the modal, Tab/Shift+Tab is trapped
  // inside it, and focus moves into the modal on open and back to the
  // trigger on close, matching standard dialog behavior.
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

  // Player event wiring (timeupdate loop/playhead, play/pause icon sync) —
  // registered once; vid/aud elements persist in the DOM for the component's
  // whole lifetime (hidden via class, not unmounted), matching the vanilla
  // approach of never recreating these elements.
  useEffect(() => {
    const vid = vidRef.current
    const aud = audRef.current

    const onTimeUpdate = (e) => {
      const p = e.target
      if (isLoopingRef.current && !suppressLoopRef.current) {
        if (p.currentTime >= trimEndRef.current) {
          p.currentTime = trimStartRef.current
          p.play().catch(() => {})
        }
      }
      if (durationRef.current > 0 && playheadRef.current) {
        const pct = (p.currentTime / durationRef.current) * 100
        playheadRef.current.style.left = pct + '%'
      }
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    vid.addEventListener('timeupdate', onTimeUpdate)
    aud.addEventListener('timeupdate', onTimeUpdate)
    vid.addEventListener('play', onPlay)
    vid.addEventListener('pause', onPause)
    aud.addEventListener('play', onPlay)
    aud.addEventListener('pause', onPause)
    return () => {
      vid.removeEventListener('timeupdate', onTimeUpdate)
      aud.removeEventListener('timeupdate', onTimeUpdate)
      vid.removeEventListener('play', onPlay)
      vid.removeEventListener('pause', onPause)
      aud.removeEventListener('play', onPlay)
      aud.removeEventListener('pause', onPause)
    }
  }, [])

  // Slider drag logic — ported unchanged from main.js:781-845 pre-extraction.
  useEffect(() => {
    const getSecondsFromX = (clientX) => {
      if (durationRef.current <= 0) return 0
      const rect = sliderContainerRef.current.getBoundingClientRect()
      let pct = (clientX - rect.left) / rect.width
      pct = Math.max(0, Math.min(1, pct))
      return pct * durationRef.current
    }

    const onMouseMove = (e) => {
      const dragging = draggingThumbRef.current
      if (!dragging) return

      let sec = getSecondsFromX(e.clientX)

      if (dragging === 'playhead') {
        suppressLoopRef.current = sec > trimEndRef.current
        if (activePlayerRef.current) activePlayerRef.current.currentTime = sec
        return
      }

      if (snapTargetRef.current !== null) {
        const rect = sliderContainerRef.current.getBoundingClientRect()
        const pxPerSec = durationRef.current > 0 ? rect.width / durationRef.current : 0
        if (pxPerSec > 0 && Math.abs(sec - snapTargetRef.current) * pxPerSec <= SNAP_PX) {
          sec = snapTargetRef.current
        }
      }

      if (dragging === 'left') {
        if (sec > trimEndRef.current) sec = trimEndRef.current
        setTrimStart(sec)
      } else if (dragging === 'right') {
        if (sec < trimStartRef.current) sec = trimStartRef.current
        setTrimEnd(sec)
      }

      if (activePlayerRef.current) activePlayerRef.current.currentTime = sec
    }

    const onMouseUp = () => {
      if (draggingThumbRef.current) setDraggingThumb(null)
      snapTargetRef.current = null
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleSliderMouseDown = (e) => {
    if (e.target === thumbLeftRef.current || e.target === thumbRightRef.current) return
    setDraggingThumb('playhead')
    const rect = sliderContainerRef.current.getBoundingClientRect()
    let pct = (e.clientX - rect.left) / rect.width
    pct = Math.max(0, Math.min(1, pct))
    const sec = duration > 0 ? pct * duration : 0
    suppressLoopRef.current = sec > trimEnd
    if (activePlayerRef.current) activePlayerRef.current.currentTime = sec
  }

  const handleSetStart = () => {
    if (!activePlayerRef.current) return
    let sec = activePlayerRef.current.currentTime
    if (sec > trimEnd) sec = trimEnd
    setTrimStart(sec)
    suppressLoopRef.current = false
  }

  const handleSetEnd = () => {
    if (!activePlayerRef.current) return
    let sec = activePlayerRef.current.currentTime
    if (sec < trimStart) sec = trimStart
    setTrimEnd(sec)
    suppressLoopRef.current = false
  }

  const handleVolumeChange = (e) => {
    const vol = parseFloat(e.target.value)
    setVolume(vol)
    if (activePlayerRef.current) {
      activePlayerRef.current.volume = vol
      if (vol > 0) {
        activePlayerRef.current.muted = false
        setMuted(false)
      }
    }
  }

  const handleToggleMute = () => {
    const player = activePlayerRef.current
    if (!player) return
    if (player.muted || player.volume === 0) {
      player.muted = false
      const restore = previousVolumeRef.current === 0 ? 1.0 : previousVolumeRef.current
      player.volume = restore
      setVolume(restore)
      setMuted(false)
    } else {
      previousVolumeRef.current = player.volume
      player.muted = true
      player.volume = 0
      setVolume(0)
      setMuted(true)
    }
  }

  const togglePlayPause = () => {
    const player = activePlayerRef.current
    if (!player) return
    if (player.paused) player.play().catch(() => {})
    else player.pause()
  }

  const handleClear = () => {
    setTrimStart(0)
    setTrimEnd(duration)
    suppressLoopRef.current = false
    if (onClear) onClear()
  }

  const handleSave = () => {
    const cleared = trimStart === 0 && trimEnd === duration
    if (onSave) onSave(cleared ? undefined : trimStart, cleared ? undefined : trimEnd)
    onClose()
  }

  const pctStart = duration > 0 ? (trimStart / duration) * 100 : 0
  const pctEnd = duration > 0 ? (trimEnd / duration) * 100 : 100
  const selDuration = trimEnd - trimStart
  const selPct = duration > 0 ? (selDuration / duration) * 100 : 0
  const showVolOff = muted || volume === 0

  return (
    <div className={open ? 'modal-overlay' : 'modal-overlay hidden'} id="trim-modal">
      <div
        className="modal-content modal-lg"
        ref={modalContentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trim-modal-title"
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3 className="modal-title" id="trim-modal-title">{t('trimModal.title')}</h3>
        </div>
        <div className="modal-body trim-vidcord-body">
          <div className="player-container" id="trim-player-container">
            <video
              id="trim-video-player"
              className={fileType === 'video' ? 'trim-player' : 'trim-player hidden'}
              ref={vidRef}
              onClick={togglePlayPause}
            />
            <audio
              id="trim-audio-player"
              className={fileType === 'audio' ? 'trim-player' : 'trim-player hidden'}
              ref={audRef}
              onClick={togglePlayPause}
            />

            <div className="player-overlay">
              <div className="trim-top-bar">
                <div className="trim-title">
                  <span className="trim-title-info tabular-nums" id="trim-duration-info">
                    {t('trimModal.selected', { duration: selDuration.toFixed(2), percent: selPct.toFixed(1) })}
                  </span>
                </div>
                <div className="trim-actions">
                  <button className="btn-icon" id="btn-trim-play-pause" title={t('trimModal.playPause')} aria-label={t('trimModal.playPause')} onClick={togglePlayPause}>
                    <svg className={isPlaying ? 'icon-play hidden' : 'icon-play'} viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    <svg className={isPlaying ? 'icon-pause' : 'icon-pause hidden'} viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                  </button>
                  <div className="trim-volume-control" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button className="btn-icon" id="btn-trim-mute" title={t('trimModal.mute')} aria-label={showVolOff ? t('trimModal.unmute') : t('trimModal.mute')} onClick={handleToggleMute}>
                      <svg className={showVolOff ? 'icon-vol-on hidden' : 'icon-vol-on'} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                      <svg className={showVolOff ? 'icon-vol-off' : 'icon-vol-off hidden'} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="1" x2="1" y2="23"></line></svg>
                    </button>
                    <input
                      type="range"
                      className="range-input"
                      id="trim-volume-slider"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      style={{ width: 60, ...rangeFillStyle(volume, 0, 1) }}
                      onChange={handleVolumeChange}
                    />
                  </div>
                  <div className="trim-actions-divider" aria-hidden="true"></div>
                  <button className="btn btn-outline btn-xs" id="btn-set-start" onClick={handleSetStart}>{t('trimModal.setStart')}</button>
                  <button className="btn btn-outline btn-xs" id="btn-set-end" onClick={handleSetEnd}>{t('trimModal.setEnd')}</button>
                  <button
                    className={isLooping ? 'btn btn-outline btn-xs' : 'btn btn-outline btn-xs btn-loop-off'}
                    id="btn-trim-loop"
                    style={{ marginLeft: 4, position: 'relative', overflow: 'hidden' }}
                    title={t('trimModal.toggleLoop')}
                    onClick={() => setIsLooping((v) => !v)}
                  >
                    {t('trimModal.loop')}
                  </button>
                </div>
              </div>

              <div className="trim-slider-wrapper">
                <div className="trim-time-label left tabular-nums" id="trim-label-start">{formatTrimLabel(trimStart)}</div>
                <div className="trim-slider-container" id="trim-slider-container" ref={sliderContainerRef} onMouseDown={handleSliderMouseDown}>
                  <div className="trim-slider-track" id="trim-slider-track">
                    <div className="trim-dim-overlay left" id="trim-dim-left" style={{ width: `${pctStart}%` }}></div>
                    <div className="trim-slider-range" id="trim-slider-range" style={{ left: `${pctStart}%`, width: `${pctEnd - pctStart}%` }}></div>
                    <div className="trim-dim-overlay right" id="trim-dim-right" style={{ width: `${100 - pctEnd}%` }}></div>
                    <div
                      className={draggingThumb === 'left' ? 'trim-slider-thumb left active' : 'trim-slider-thumb left'}
                      id="trim-thumb-left"
                      ref={thumbLeftRef}
                      style={{ left: `${pctStart}%` }}
                      onMouseDown={(e) => {
                        setDraggingThumb('left')
                        snapTargetRef.current = activePlayerRef.current ? activePlayerRef.current.currentTime : null
                        e.preventDefault()
                      }}
                    >
                      <div className="thumb-grip"></div>
                    </div>
                    <div
                      className={draggingThumb === 'right' ? 'trim-slider-thumb right active' : 'trim-slider-thumb right'}
                      id="trim-thumb-right"
                      ref={thumbRightRef}
                      style={{ left: `${pctEnd}%` }}
                      onMouseDown={(e) => {
                        setDraggingThumb('right')
                        snapTargetRef.current = activePlayerRef.current ? activePlayerRef.current.currentTime : null
                        e.preventDefault()
                      }}
                    >
                      <div className="thumb-grip"></div>
                    </div>
                    <div className="trim-playhead" id="trim-playhead" ref={playheadRef}></div>
                  </div>
                </div>
                <div className="trim-time-label right tabular-nums" id="trim-label-end">{formatTrimLabel(trimEnd)}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" id="btn-clear-trim" onClick={handleClear}>{t('trimModal.clearTrim')}</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" id="btn-cancel-trim" onClick={onClose}>{t('trimModal.cancel')}</button>
            <button className="btn btn-primary" id="btn-save-trim" onClick={handleSave}>{t('trimModal.save')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
