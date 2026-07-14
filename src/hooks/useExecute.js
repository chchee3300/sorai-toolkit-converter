import { useCallback, useRef, useState } from 'react'

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
  const [progressText, setProgressText] = useState('Processing...')
  const [terminalLog, setTerminalLog] = useState('')

  const cancelRequestedRef = useRef(false)
  const spawnedIdRef = useRef(null)

  const cancel = useCallback(() => {
    if (!executing || cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    setCancelling(true)
    setStatus('Cancelling…', 'busy')
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

    setExecuting(true)
    setProgressVisible(true)
    setStatus('Processing…', 'busy')

    let completed = 0
    const binPath = window.NL_PATH.replace(/\//g, '\\')

    try {
      for (let i = 0; i < files.length; i++) {
        if (cancelRequestedRef.current) break

        const fileObj = files[i]
        const file = fileObj.path
        const filename = file.split(/[\\/]/).pop()
        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'))

        setProgressText(`Processing: ${filename} (${i + 1}/${files.length})`)
        setProgressPercent((i / files.length) * 100)

        let command = ''
        let outPath = ''

        if (fileType === 'video') {
          const { format, codec, quality: qualityPercent, speed, fpsCustom, fps } = settings.video
          const targetFpsStr = fpsCustom ? fps : 'original'
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = window.EstellaLib.ffmpegCommands.buildVideoCommand({
            binPath,
            file,
            outPath,
            format,
            codec,
            qualityPercent,
            speed,
            targetFpsStr,
            fileObj,
          })
        } else if (fileType === 'image') {
          const { format, quality, scale } = settings.image
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = window.EstellaLib.ffmpegCommands.buildImageCommand({ binPath, file, outPath, format, quality, scale })
        } else if (fileType === 'audio') {
          const { bitrate, speed, format } = settings.audio
          outPath = await window.EstellaLib.filenameCollision.getUniqueOutPath(resolvedOutputPath, nameWithoutExt, format)
          command = window.EstellaLib.ffmpegCommands.buildAudioCommand({ binPath, file, outPath, bitrate, speed, fileObj })
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
                    setProgressText(`Processing: ${filename} (${i + 1}/${files.length}) - ${Math.round(percent)}%`)
                  }
                },
                spawnedIdRef,
                cancelRequestedRef,
              ),
              cancelRequestedRef,
            )

            setProgressPercent(100)
            setProgressText(`Processing: ${filename} (${i + 1}/${files.length}) - 100%`)
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
              setStatus(`Error: ${filename}`, 'error')
            }
          }
        }
      }
    } catch (fatalErr) {
      alert('FATAL ERROR inside loop:\n' + (fatalErr.message || fatalErr) + '\n' + fatalErr.stack)
      setStatus('Fatal error', 'error')
    }

    const wasCancelled = cancelRequestedRef.current
    cancelRequestedRef.current = false
    spawnedIdRef.current = null
    setCancelling(false)

    if (wasCancelled) {
      setProgressText(`Cancelled ${completed} of ${files.length}`)
      setStatus(`Cancelled — ${completed} of ${files.length} converted`, 'ready')
    } else {
      setProgressPercent(100)
      setProgressText(`Completed ${completed} of ${files.length}!`)
      setStatus(`Done — ${completed} of ${files.length} converted`, 'ready')
    }
    setExecuting(false)
    setTimeout(() => {
      setProgressVisible(false)
      setProgressText('Processing...')
      setProgressPercent(0)
    }, 5000)
  }, [files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus])

  return { execute, executing, cancel, cancelling, progressVisible, progressPercent, progressText, terminalLog }
}
