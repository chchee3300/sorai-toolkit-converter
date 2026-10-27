import { useCallback, useRef, useState } from 'react'
import { tNow } from '../i18n/dict.js'
import { cancelJob, startConvert } from '../plugin.js'

// Batch queue state machine. Each file is one plugin job (plugin/src/
// runner.rs): Rust builds the ffmpeg args, picks a collision-free output
// name, parses progress, removes partial output on failure/cancel, and
// always reports `finished` (a cancel backstop means no stuck
// "Cancelling..."). This hook only sequences files and mirrors events into
// the progress bar / log. PDF (qpdf) and image->PDF (img2pdf) are plugin
// jobs too; a missing system qpdf/img2pdf (macOS/Linux) is a per-file error.
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
  const jobIdRef = useRef(null)

  const cancel = useCallback(() => {
    if (!executing || cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    setCancelling(true)
    setStatus('status.cancelling', 'busy')
    if (jobIdRef.current != null) cancelJob(jobIdRef.current).catch(() => {})
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
    setStatus('status.processing', 'busy')

    let completed = 0
    const appendLog = (line) => setTerminalLog((prev) => prev + line + '\n')

    for (let i = 0; i < files.length; i++) {
      if (cancelRequestedRef.current) break

      const fileObj = files[i]
      const filename = fileObj.path.split(/[\\/]/).pop()
      const params = { name: filename, index: i + 1, total: files.length }

      setProgressText(tNow('progress.processingFile', params))
      setProgressPercent((i / files.length) * 100)

      let result
      try {
        const job = await startConvert(
          { source: fileObj, fileType, settings: settings[fileType] },
          resolvedOutputPath,
          {
            onLog: appendLog,
            onProgress: (percent) => {
              setProgressPercent(percent)
              setProgressText(tNow('progress.processingFilePercent', { ...params, percent: Math.round(percent) }))
            },
          },
        )
        jobIdRef.current = job.jobId
        // cancel() may have fired while the job was starting.
        if (cancelRequestedRef.current) cancelJob(job.jobId).catch(() => {})
        result = await job.done
      } catch (err) {
        result = { status: 'error', message: String(err?.message ?? err) }
      }
      jobIdRef.current = null

      if (result.status === 'success') {
        completed++
        setProgressPercent(100)
        setProgressText(tNow('progress.processingFileDone', params))
        if (result.outSize != null) {
          const convertedSizeMB = (result.outSize / (1024 * 1024)).toFixed(2)
          // By path (unique in the queue), not index: the list may change mid-run.
          // notSmaller: the output is a copy of the source (PDF compress).
          const notSmaller = !!result.notSmaller
          setFiles((prev) => prev.map((f) => (f.path === fileObj.path ? { ...f, converted: true, convertedSizeMB, notSmaller, failed: null } : f)))
        }
      } else if (result.status === 'error') {
        // Non-blocking: log line + the row's "failed" mark (title = message).
        appendLog(`! ${result.message}`)
        setFiles((prev) => prev.map((f) => (f.path === fileObj.path ? { ...f, failed: result.message } : f)))
        setStatus('status.errorFile', 'error', { name: filename })
      }
    }

    const wasCancelled = cancelRequestedRef.current
    cancelRequestedRef.current = false
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
