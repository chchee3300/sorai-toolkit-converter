import { useCallback, useRef, useState } from 'react'
import { tNow } from '../i18n/dict.js'
import { cancelJob, startConvert, startMerge } from '../plugin.js'

// Batch queue state machine. Each file is one plugin job (plugin/src/
// runner.rs): Rust builds the ffmpeg args, picks a collision-free output
// name, parses progress, removes partial output on failure/cancel, and
// always reports `finished` (a cancel backstop means no stuck
// "Cancelling..."). This hook only sequences files and mirrors events into
// the progress bar / log. PDF (qpdf) and image->PDF (img2pdf) are plugin
// jobs too; a missing system qpdf/img2pdf (macOS/Linux) is a per-file error.
// `merge` (App state, true only while merging is offered): the whole queue,
// in order, is one start_merge job -- output named in the status bar and
// log, an error marked on the first row.
export function useExecute({ files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus, merge }) {
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

    // One task per file, or one merge task whose result belongs to the first row.
    const convertJob = (fileObj) => ({ source: fileObj, fileType, settings: settings[fileType] })
    const tasks = merge
      ? [{ fileObj: files[0], start: (h) => startMerge({ sources: files, fileType, settings: settings[fileType] }, resolvedOutputPath, h) }]
      : files.map((fileObj) => ({ fileObj, start: (h) => startConvert(convertJob(fileObj), resolvedOutputPath, h) }))
    let mergedName = null

    for (let i = 0; i < tasks.length; i++) {
      if (cancelRequestedRef.current) break

      const { fileObj, start } = tasks[i]
      const filename = fileObj.path.split(/[\\/]/).pop()
      const params = { name: filename, index: i + 1, total: tasks.length }

      setProgressText(tNow('progress.processingFile', params))
      setProgressPercent((i / tasks.length) * 100)

      let result
      let outPath = ''
      try {
        const job = await start(
          {
            onLog: appendLog,
            onProgress: (percent) => {
              setProgressPercent(percent)
              setProgressText(tNow('progress.processingFilePercent', { ...params, percent: Math.round(percent) }))
            },
          },
        )
        jobIdRef.current = job.jobId
        outPath = job.outPath
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
        if (merge) {
          mergedName = outPath.split(/[\\/]/).pop()
          appendLog(`= ${outPath}`)
        } else if (result.outSize != null) {
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
      setProgressText(tNow('progress.cancelledCount', { completed, total: tasks.length }))
      setStatus('status.cancelledCount', 'ready', { completed, total: tasks.length })
    } else {
      setProgressPercent(100)
      setProgressText(tNow('progress.completedCount', { completed, total: tasks.length }))
      // A failed merge keeps its "Error: <first file>" status.
      if (mergedName) setStatus('status.merged', 'ready', { name: mergedName })
      else if (!merge) setStatus('status.doneCount', 'ready', { completed, total: tasks.length })
    }
    setExecuting(false)
    setTimeout(() => {
      setProgressVisible(false)
      setProgressText(tNow('progress.idle'))
      setProgressPercent(0)
    }, 5000)
  }, [files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus, merge])

  return { execute, executing, cancel, cancelling, progressVisible, progressPercent, progressText, terminalLog }
}
