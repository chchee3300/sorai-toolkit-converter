import { useCallback, useRef, useState } from 'react'
import { tNow } from '../i18n/dict.js'

// Ported unchanged from main.js's runCommandWithLogs (main.js:492-518
// pre-extraction), decoupled from direct DOM writes: the caller supplies
// onLog/onProgress instead of this function touching #terminal-log itself.
// spawnedIdRef/cancelRequestedRef (both optional) let the caller track and
// kill the in-flight process — see useExecute's cancel() below. The
// self-check right after `spawnedIdRef.current = pid` closes a race where
// cancel() fires in the gap between a file's setup and its process actually
// spawning: without it, cancelRequestedRef.current could already be true by
// the time we have a pid, and that file would otherwise run to completion
// uncancelled.
function runCommandWithLogs(command, onLog, onProgress, spawnedIdRef, cancelRequestedRef) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      try {
        const processInfo = await window.Neutralino.os.spawnProcess(command)
        const pid = processInfo.id
        if (spawnedIdRef) spawnedIdRef.current = pid
        if (cancelRequestedRef && cancelRequestedRef.current) {
          window.Neutralino.os.updateSpawnedProcess(pid, 'exit').catch(() => {})
        }
        const handler = (evt) => {
          if (evt.detail.id === pid) {
            if (evt.detail.action === 'stdOut' || evt.detail.action === 'stdErr') {
              onLog(evt.detail.data)
              if (onProgress) onProgress(evt.detail.data)
            }
            if (evt.detail.action === 'exit') {
              window.Neutralino.events.off('spawnedProcess', handler)
              if (spawnedIdRef) spawnedIdRef.current = null
              if (Number(evt.detail.data) === 0) resolve()
              else reject(new Error('Exit code ' + evt.detail.data))
            }
          }
        }
        window.Neutralino.events.on('spawnedProcess', handler)
      } catch (e) {
        reject(e)
      }
    })()
  })
}

// Safety backstop for cancel(): a forced kill (Neutralino.os.updateSpawnedProcess
// with 'exit') isn't guaranteed to fire the spawnedProcess 'exit' event
// promptly, or at all, on every platform — without this, `runPromise` could
// hang forever and leave the UI stuck in "Cancelling…". Once
// cancelRequestedRef flips true (checked here via a lightweight poll, since
// cancellation can happen at any point during the awaited command, not just
// at call time), arm a timeout; if it fires first, reject so the caller's
// existing catch block treats this the same as any other cancelled-file
// outcome. Resolves/rejects exactly once, whichever comes first.
function awaitWithCancelGuard(promise, cancelRequestedRef, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadlineTimer = null
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      clearInterval(pollInterval)
      fn(value)
    }
    promise.then(
      (v) => settle(resolve, v),
      (e) => settle(reject, e),
    )
    const armDeadline = () => {
      if (deadlineTimer) return
      deadlineTimer = setTimeout(
        () => settle(reject, new Error('Cancelled (timed out waiting for process exit)')),
        timeoutMs,
      )
    }
    if (cancelRequestedRef.current) armDeadline()
    const pollInterval = setInterval(() => {
      if (settled) return
      if (cancelRequestedRef.current) armDeadline()
    }, 100)
  })
}

// Ported unchanged from main.js's btn-execute click handler
// (main.js:1021-1159 pre-extraction), wired to the same Phase 0.4
// EstellaLib.* modules the vanilla app calls. files/settings/outputPath
// come from useFileManager/useSettings — this is why ProgressBar (plan
// slice 4) was merged into the same push as DropZone/SettingsPanel: it
// needs the exact same lifted state.
export function useExecute({ files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus }) {
  const [executing, setExecuting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progressVisible, setProgressVisible] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  // Progress text is stored as already-translated snapshots (tNow, not a
  // live key) -- it refreshes constantly while visible and auto-hides after
  // completion, so it doesn't need to retroactively re-translate on a
  // language switch the way the status bar does (see useFileManager).
  const [progressText, setProgressText] = useState(() => tNow('progress.idle'))
  const [terminalLog, setTerminalLog] = useState('')

  const cancelRequestedRef = useRef(false)
  const spawnedIdRef = useRef(null)

  const cancel = useCallback(() => {
    if (!executing || cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    setCancelling(true)
    setStatus('status.cancelling', 'busy')
    if (spawnedIdRef.current != null) {
      window.Neutralino.os.updateSpawnedProcess(spawnedIdRef.current, 'exit').catch(() => {})
    }
  }, [executing, setStatus])

  const execute = useCallback(async () => {
    if (files.length === 0) return

    let resolvedOutputPath = outputPath
    if (!resolvedOutputPath) {
      const firstPath = files[0].path
      let lastSlash = firstPath.lastIndexOf('\\')
      if (lastSlash === -1) lastSlash = firstPath.lastIndexOf('/')
      if (lastSlash !== -1) {
        resolvedOutputPath = firstPath.substring(0, lastSlash)
        setOutputPath(resolvedOutputPath)
      }
    }

    const platform = window.EstellaLib.platform
    if (!platform.isWindows()) {
      const needsQpdf = fileType === 'pdf'
      const needsImg2pdf = fileType === 'image' && settings.image.format === '.pdf'
      const tool = needsQpdf ? 'qpdf' : needsImg2pdf ? 'img2pdf' : null
      if (tool) {
        const available = await platform.checkToolAvailable(tool)
        if (!available) {
          const hint = tool === 'qpdf'
            ? "Install it via 'brew install qpdf' (macOS) or 'sudo apt install qpdf' (Linux)"
            : "Install it via 'pip install img2pdf' (macOS/Linux)"
          alert(`${tool} not found. ${hint}, then restart the app.`)
          setStatus('status.errorToolNotFound', 'error', { tool })
          return
        }
      }
    }

    setExecuting(true)
    setProgressVisible(true)
    setStatus('status.processing', 'busy')

    let completed = 0
    const binPath = platform.resolveBinPath()

    try {
      for (let i = 0; i < files.length; i++) {
        if (cancelRequestedRef.current) break

        const fileObj = files[i]
        const file = fileObj.path
        const filename = file.split(/[\\/]/).pop()
        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'))

        setProgressText(tNow('progress.processingFile', { name: filename, index: i + 1, total: files.length }))
        setProgressPercent((i / files.length) * 100)

        let command = ''
        let outPath = ''

        if (fileType === 'video') {
          const { format, codec, quality: qualityPercent, speed, fps, targetSizeMode, targetSizeMB } = settings.video
          const targetFpsStr = fps != null ? String(fps) : 'original'
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = window.EstellaLib.ffmpegCommands.buildVideoCommand({
            binPath,
            file,
            outPath,
            format,
            // Forced regardless of whatever's stored in settings.video.codec
            // -- SettingsPanel.jsx only overrides the dropdown's *display*
            // while targetSizeMode is on, disabled but still bound to
            // whatever the user picked before enabling it. The actual
            // "stay under target" guarantee only holds for libx264's VBV
            // enforcement (see ffmpeg-commands.js's buildVideoCommand
            // comment), so this is where that gets actually enforced.
            codec: targetSizeMode ? 'libx264' : codec,
            qualityPercent,
            speed,
            targetFpsStr,
            fileObj,
            targetSizeMB: targetSizeMode ? targetSizeMB : null,
          })
        } else if (fileType === 'image') {
          const { format, quality, scale } = settings.image
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = format === '.pdf'
            ? window.EstellaLib.img2pdfCommands.buildImageToPdfCommand({ binPath, file, outPath })
            : window.EstellaLib.ffmpegCommands.buildImageCommand({ binPath, file, outPath, format, quality, scale, crop: fileObj.crop })
        } else if (fileType === 'audio') {
          const { bitrate, speed, format } = settings.audio
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = window.EstellaLib.ffmpegCommands.buildAudioCommand({ binPath, file, outPath, bitrate, speed, format, fileObj })
        } else if (fileType === 'pdf') {
          const { optimize } = settings.pdf
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, '.pdf')
          command = window.EstellaLib.qpdfCommands.buildPdfCommand({ binPath, file, outPath, optimize })
        }

        if (command) {
          try {
            setTerminalLog((prev) => prev + `\n> Executing: ${command}\n`)

            let speedForProgress = 1.0
            if (fileType === 'video') speedForProgress = parseFloat(settings.video.speed) || 1.0
            else if (fileType === 'audio') speedForProgress = parseFloat(settings.audio.speed) || 1.0

            await awaitWithCancelGuard(
              runCommandWithLogs(
                command,
                (chunk) => setTerminalLog((prev) => prev + chunk),
                (chunk) => {
                  const percent = window.EstellaLib.progressParser.parseProgress(chunk, fileObj.duration, speedForProgress)
                  if (percent !== null) {
                    setProgressPercent(percent)
                    setProgressText(tNow('progress.processingFilePercent', { name: filename, index: i + 1, total: files.length, percent: Math.round(percent) }))
                  }
                },
                spawnedIdRef,
                cancelRequestedRef,
              ),
              cancelRequestedRef,
            )

            setProgressPercent(100)
            setProgressText(tNow('progress.processingFileDone', { name: filename, index: i + 1, total: files.length }))
            completed++

            try {
              const newStats = await window.Neutralino.filesystem.getStats(outPath)
              const newSizeMB = (newStats.size / (1024 * 1024)).toFixed(2)
              setFiles((prev) =>
                prev.map((f, idx) => (idx === i ? { ...f, converted: true, convertedSizeMB: newSizeMB } : f)),
              )
            } catch (e) {
              console.error('Could not read new file size', e)
            }
          } catch (err) {
            if (cancelRequestedRef.current) {
              // User-requested cancellation, not a real error: a forced kill
              // (TerminateProcess-style) doesn't let ffmpeg/qpdf finalize the
              // output container, so the partial file can be truncated or
              // corrupt — always clean it up rather than leaving a
              // seemingly-valid file at the final name.
              await window.Neutralino.filesystem.remove(outPath).catch(() => {})
            } else {
              alert(`Failed to process ${filename}:\n${err.message || err}`)
              setStatus('status.errorFile', 'error', { name: filename })
            }
          }
        }
      }
    } catch (fatalErr) {
      alert('FATAL ERROR inside loop:\n' + (fatalErr.message || fatalErr) + '\n' + fatalErr.stack)
      setStatus('status.fatalError', 'error')
    }

    const wasCancelled = cancelRequestedRef.current
    cancelRequestedRef.current = false
    spawnedIdRef.current = null
    setCancelling(false)

    if (wasCancelled) {
      setProgressText(tNow('progress.cancelledCount', { completed, total: files.length }))
      setStatus('status.cancelledCount', 'ready', { completed, total: files.length })
    } else {
      setProgressPercent(100)
      setProgressText(tNow('progress.completedCount', { completed, total: files.length }))
      setStatus('status.doneCount', 'ready', { completed, total: files.length })
    }
    setExecuting(false)
    setTimeout(() => {
      setProgressVisible(false)
      setProgressText(tNow('progress.idle'))
      setProgressPercent(0)
    }, 5000)
  }, [files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus])

  return { execute, executing, cancel, cancelling, progressVisible, progressPercent, progressText, terminalLog }
}
