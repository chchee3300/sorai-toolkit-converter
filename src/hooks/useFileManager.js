import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { probeSource, setPreviewFiles } from '../plugin.js'

// Ported unchanged from resources/js/main.js's getFileType (main.js:6-18
// pre-extraction).
// .ts is an input here (drag/browse) but not in the hub's right-click INPUT_EXTS (TypeScript).
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'flv', 'ts', 'm2ts', 'mts', '3gp', 'wmv', 'mpg', 'mpeg', 'ogv']
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'ico']
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'ac3', 'ape', 'dsf', 'dff', 'dts']
const PDF_EXTS = ['pdf']
// Word documents: converted by WordCraft (an optional download, hub Settings).
const DOCUMENT_EXTS = ['docx', 'doc', 'odt', 'rtf']

function getFileType(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (PDF_EXTS.includes(ext)) return 'pdf'
  if (DOCUMENT_EXTS.includes(ext)) return 'document'
  return null
}

const baseName = (path) => path.split(/[\\/]/).pop()

// Owns files/fileType/outputPath/loading/status — the same state that was
// module-level `let` globals in main.js, now lifted into React. Ported
// behaviorally unchanged from handleFiles/removeFile/renderFileList's
// empty-list reset
// (main.js, pre-extraction). `onFirstFileType(type, ext)` is called exactly
// where vanilla's handleFiles directly poked
// document.getElementById('video-format').value = ext — the DropZone/
// SettingsPanel coupling that's why these were ported together.
export function useFileManager({ onFirstFileType }) {
  const [files, setFiles] = useState([])
  const [fileType, setFileType] = useState(null)
  const [outputPath, setOutputPathState] = useState('')
  const [loading, setLoading] = useState(false)
  // Status is stored as a dict KEY + params, not resolved text -- App.jsx
  // translates it at render time (t(status.key, status.params)), so the
  // always-visible status bar re-renders in the new language the moment the
  // user switches, instead of freezing whatever language was active when
  // the status was last set.
  const [status, setStatusState] = useState({ key: 'status.ready', params: undefined, state: 'ready' })
  // { paths, incomingType, existingType, existingCount } | null — set when
  // an incoming batch's type differs from what's already loaded, so the UI
  // can ask before silently rejecting (see handleFiles/confirmClearAndLoad
  // below).
  const [pendingMismatch, setPendingMismatch] = useState(null)

  // Refs mirror state for reads inside async handlers, where a stale
  // closure or a not-yet-committed setState would otherwise reintroduce
  // races the vanilla code's plain synchronous globals never had. Writes
  // go through the ref *and* the state setter together (see
  // setOutputPathBoth) wherever a handler needs to read-its-own-write
  // before the next render commits.
  const filesRef = useRef(files)
  filesRef.current = files
  const outputPathRef = useRef(outputPath)
  outputPathRef.current = outputPath
  const setOutputPathBoth = useCallback((value) => {
    outputPathRef.current = value
    setOutputPathState(value)
  }, [])

  const setStatus = useCallback((key, state = 'ready', params = undefined) => {
    setStatusState({ key, params, state })
  }, [])

  // Ported unchanged from the original handleFiles body — now parameterized
  // on startingType instead of reading the fileType state var directly, so
  // it can be called with `null` right after a confirmed clear-and-switch
  // without waiting for that state update to commit (see
  // confirmClearAndLoad below).
  const loadFiles = useCallback(
    async (paths, startingType) => {
      setLoading(true)
      try {
        const additions = []
        let localType = startingType

        for (const path of paths) {
          try {
            const type = getFileType(path)
            if (!type) {
              // Also how a dropped folder ends up here (no media extension).
              setStatus('status.skippedUnsupported', 'error', { name: baseName(path) })
              continue
            }

            let isFirstValidFile = false
            if (localType === null) {
              localType = type
              isFirstValidFile = true
            } else if (localType !== type) {
              alert(`Please only add ${localType} files in this batch. Found: ${path}`)
              continue
            }

            if (isFirstValidFile) {
              let ext = '.' + path.split('.').pop().toLowerCase()
              if (ext === '.jpeg') ext = '.jpg'
              if (onFirstFileType) onFirstFileType(type, ext)
            }

            const alreadyPresent =
              filesRef.current.some((f) => f.path === path) || additions.some((f) => f.path === path)
            if (!alreadyPresent) {
              // Size + ffmpeg info + thumbnail, all in the plugin (Rust). A
              // directory or vanished file rejects -> caught below, skipped.
              const info = await probeSource(path, type)
              const thumbnail = info.thumbnail ? convertFileSrc(info.thumbnail) : null
              const { size, duration, fps, width, height } = info
              const { codec: videoCodec, audioCodec, audioRate, audioChannels } = info
              additions.push({ path, size, duration, fps, width, height, videoCodec, audioCodec, audioRate, audioChannels, thumbnail })
            }
          } catch (err) {
            console.error('Error processing file path: ' + path, err)
            setStatus('status.failedImport', 'error', { name: baseName(path) })
          }
        }

        if (localType !== fileType) setFileType(localType)
        if (additions.length > 0) setFiles((prev) => [...prev, ...additions])

        if (!outputPathRef.current) {
          const firstPath = filesRef.current[0]?.path || additions[0]?.path
          if (firstPath) {
            let lastSlash = firstPath.lastIndexOf('\\')
            if (lastSlash === -1) lastSlash = firstPath.lastIndexOf('/')
            if (lastSlash !== -1) setOutputPathBoth(firstPath.substring(0, lastSlash))
          }
        }
      } finally {
        setLoading(false)
      }
    },
    [fileType, onFirstFileType, setOutputPathBoth, setStatus],
  )

  // Public entry point every caller (native Tauri drop, pendingLaunch,
  // and the Browse dialog) already funnels through. If files are
  // already loaded and this batch resolves to a *different* category, park
  // it in pendingMismatch and ask instead of silently rejecting (matches
  // getFileType/localType's own per-file mismatch check further up the
  // list for intra-batch mixing on a *fresh* load, which is unaffected).
  const handleFiles = useCallback(
    async (paths) => {
      const incomingType = paths.map(getFileType).find(Boolean) ?? null
      if (fileType !== null && incomingType !== null && incomingType !== fileType) {
        setPendingMismatch({ paths, incomingType, existingType: fileType, existingCount: filesRef.current.length })
        return
      }
      await loadFiles(paths, fileType)
    },
    [fileType, loadFiles],
  )

  const removeFile = useCallback(
    (index) => {
      setFiles((prev) => {
        const next = prev.filter((_, i) => i !== index)
        if (next.length === 0) {
          setFileType(null)
          setStatus('status.ready', 'ready')
        }
        return next
      })
    },
    [setStatus],
  )

  const clearFiles = useCallback(() => {
    setFiles([])
    setFileType(null)
    setStatus('status.ready', 'ready')
  }, [setStatus])

  const confirmClearAndLoad = useCallback(async () => {
    if (!pendingMismatch) return
    const { paths } = pendingMismatch
    clearFiles()
    filesRef.current = [] // read-your-own-write: clearFiles' setFiles([]) hasn't committed yet
    setPendingMismatch(null)
    await loadFiles(paths, null)
  }, [pendingMismatch, clearFiles, loadFiles])

  const cancelPendingMismatch = useCallback(() => setPendingMismatch(null), [])

  // Native drag/drop: Tauri's webview drag-drop events carry the dropped
  // files' real absolute paths (used in place, never copied). enter/leave/
  // drop drive body.drag-active, the whole-window overlay (styles.css);
  // files are droppable anywhere. handleFiles changes identity with
  // fileType, so the listener reads it through a ref and subscribes once.
  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  useEffect(() => {
    const overlay = (on) => document.body.classList.toggle('drag-active', on)
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') overlay(true)
      else if (payload.type === 'leave') overlay(false)
      else if (payload.type === 'drop') {
        overlay(false)
        if (payload.paths.length > 0) handleFilesRef.current(payload.paths)
      }
    })
    return () => {
      overlay(false)
      unlisten.then((f) => f())
    }
  }, [])

  // Trim/Crop preview access == exactly the current queue: removing a file
  // (remove, clear, mixed-type replace) or leaving the tool revokes it.
  useEffect(() => {
    setPreviewFiles(files.map((f) => f.path)).catch(console.error)
  }, [files])
  useEffect(() => () => void setPreviewFiles([]).catch(() => {}), [])

  const browseForFiles = useCallback(async () => {
    // window.SoraiDialogs is the hub's dialog module, looked up at call time
    // so E2E can stub it.
    const entries = await window.SoraiDialogs.openFiles({ title: 'Select files' })
    if (entries && entries.length > 0) handleFiles(entries)
  }, [handleFiles])

  const browseForOutputFolder = useCallback(async () => {
    const entry = await window.SoraiDialogs.openFolder({ title: 'Select Output Folder' })
    if (entry) setOutputPathBoth(entry)
  }, [setOutputPathBoth])

  return {
    files,
    setFiles,
    fileType,
    outputPath,
    setOutputPath: setOutputPathBoth,
    loading,
    status,
    setStatus,
    handleFiles,
    removeFile,
    clearFiles,
    browseForFiles,
    browseForOutputFolder,
    pendingMismatch,
    confirmClearAndLoad,
    cancelPendingMismatch,
  }
}
