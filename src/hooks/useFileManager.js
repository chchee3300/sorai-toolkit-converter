import { useCallback, useEffect, useRef, useState } from 'react'

// Ported unchanged from resources/js/main.js's getFileType (main.js:6-18
// pre-extraction).
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm']
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'ico']
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'flac', 'ogg']
const PDF_EXTS = ['pdf']

function getFileType(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (PDF_EXTS.includes(ext)) return 'pdf'
  return null
}

// Generates a small preview thumbnail (video mid-frame / audio embedded
// cover art / downscaled image) into the shared thumbDir and returns a
// localhost URL served through the '/thumbs' mount (see ensureThumbDir in
// useFileManager below) -- or null if ffmpeg produced nothing (most
// commonly: an audio file with no embedded cover art). fileName is unique
// per call (thumbSeqRef), not derived from the source path, so files from
// different directories that happen to share a basename never collide.
async function getThumbnail(path, type, duration, thumbDir, seq) {
  try {
    const platform = window.EstellaLib.platform
    const binPath = platform.resolveBinPath()
    const fileName = `thumb-${seq}.jpg`
    const outPath = platform.joinPath(thumbDir, fileName)
    const command = window.EstellaLib.ffmpegCommands.buildThumbnailCommand({
      binPath,
      file: path,
      outPath,
      fileType: type,
      duration,
    })
    await window.Neutralino.os.execCommand(command)
    const stats = await window.Neutralino.filesystem.getStats(outPath).catch(() => null)
    if (!stats || stats.size === 0) return null
    return `http://localhost:${window.NL_PORT}/thumbs/${encodeURIComponent(fileName)}`
  } catch (e) {
    return null
  }
}

// Ported unchanged from main.js's getMediaInfo (main.js:20-50 pre-extraction).
async function getMediaInfo(path) {
  try {
    const platform = window.EstellaLib.platform
    const binPath = platform.resolveBinPath()
    const command = `"${platform.ffmpegPath(binPath)}" -i "${path}"`
    const res = await window.Neutralino.os.execCommand(command)
    const output = res.stdErr
    const match = output.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/)
    const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s+fps/)
    const dimMatch = output.match(/(?:,\s+)(\d+)x(\d+)(?:[,\s]|$)/)
    // ffmpeg -i's own stream line, e.g. "Stream #0:0: Video: h264 (High) ...
    // 320x240 ...". Only ever present for video streams -- an audio-only
    // file's "Stream #0:0: Audio: ..." line never matches, so this comes
    // back empty for audio/PDF without any type check needed here.
    const codecMatch = output.match(/Video:\s+(\w+)/)

    let duration = 0
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0
    let width = 0
    let height = 0
    const codec = codecMatch ? codecMatch[1] : ''

    if (match) {
      const hours = parseInt(match[1])
      const mins = parseInt(match[2])
      const secs = parseFloat(match[3])
      duration = hours * 3600 + mins * 60 + secs
    }
    if (dimMatch) {
      width = parseInt(dimMatch[1])
      height = parseInt(dimMatch[2])
    }
    return { duration, fps, width, height, codec }
  } catch (e) {
    console.error('Failed to parse info from ffmpeg', e)
  }
  return null
}

// Owns files/fileType/outputPath/loading/status — the same state that was
// module-level `let` globals in main.js, now lifted into React. Ported
// behaviorally unchanged from handleFiles/importDroppedFiles/
// copyDroppedFileToTemp/removeFile/renderFileList's empty-list reset
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
  // before the next render commits — outputPath is the one case where
  // vanilla's importDroppedFiles relies on exactly that (see its comment
  // in main.js: "default the output dir to Downloads so handleFiles never
  // picks the temp dir").
  const filesRef = useRef(files)
  filesRef.current = files
  const outputPathRef = useRef(outputPath)
  outputPathRef.current = outputPath
  // Thumbnail generation state: thumbDirRef caches the resolved temp dir
  // once created+mounted (lazy, first file that needs a thumbnail triggers
  // it) so every subsequent file reuses the same mount instead of racing to
  // create/mount it again; thumbSeqRef gives each generated file a unique
  // name (see getThumbnail above).
  const thumbDirRef = useRef(null)
  const thumbSeqRef = useRef(0)

  // Mirrors TrimModal's '/preview' mount (same Neutralino.server.mount +
  // localhost:NL_PORT idiom), except this one is long-lived for the whole
  // Converter session and points at a generated-thumbnails cache dir instead
  // of a source file's own directory -- see getThumbnail's file-per-thumb
  // naming, which is what makes one shared mount safe for files pulled from
  // many different source directories.
  const ensureThumbDir = useCallback(async () => {
    if (thumbDirRef.current) return thumbDirRef.current
    const tempBase = await window.Neutralino.os.getPath('temp')
    const dir = window.EstellaLib.platform.joinPath(tempBase, 'FileConverterApp', 'thumbnails')
    await window.Neutralino.filesystem.createDirectory(dir).catch(() => {})
    const mounts = await window.Neutralino.server.getMounts().catch(() => ({}))
    if (!mounts['/thumbs']) {
      await window.Neutralino.server.mount('/thumbs', dir).catch(() => {})
    }
    thumbDirRef.current = dir
    return dir
  }, [])

  useEffect(() => {
    return () => {
      if (thumbDirRef.current) {
        window.Neutralino.server.unmount('/thumbs').catch(() => {})
      }
    }
  }, [])

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
              alert(`Unsupported file type: ${path}`)
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
              const stats = await window.Neutralino.filesystem.getStats(path)
              let duration = 0
              let fps = 0
              let width = 0
              let height = 0
              let videoCodec = ''
              let thumbnail = null
              if (type === 'video' || type === 'audio' || type === 'image') {
                const info = await getMediaInfo(path)
                if (info) {
                  duration = info.duration || 0
                  fps = info.fps || 0
                  width = info.width || 0
                  height = info.height || 0
                  videoCodec = info.codec || ''
                }
                const thumbDir = await ensureThumbDir()
                thumbnail = await getThumbnail(path, type, duration, thumbDir, thumbSeqRef.current++)
              }
              additions.push({ path, size: stats.size, duration, fps, width, height, videoCodec, thumbnail })
            }
          } catch (err) {
            console.error('Error processing file path: ' + path, err)
            alert('Error reading file info: ' + path + '\n' + err)
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
    [fileType, onFirstFileType, setOutputPathBoth, ensureThumbDir],
  )

  // Public entry point every caller (native filesDropped, browser-mode
  // drop, and the Browse dialog) already funnels through. If files are
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

  const dropSeqRef = useRef(0)

  const copyDroppedFileToTemp = useCallback(async (file, dropDir, onProgress) => {
    const CHUNK = window.__DROP_CHUNK_SIZE || 8 * 1024 * 1024
    const destPath = window.EstellaLib.platform.joinPath(dropDir, file.name)
    let offset = 0
    while (offset < file.size) {
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer()
      if (offset === 0) {
        await window.Neutralino.filesystem.writeBinaryFile(destPath, buf)
      } else {
        await window.Neutralino.filesystem.appendBinaryFile(destPath, buf)
      }
      offset += CHUNK
      if (onProgress) onProgress(Math.min(100, Math.round((offset / file.size) * 100)))
    }
    return destPath
  }, [])

  const importDroppedFiles = useCallback(
    async (dropped) => {
      const accepted = []
      for (const file of dropped) {
        if (!getFileType(file.name)) {
          console.warn('Skipping unsupported drop entry:', file.name)
          setStatus('status.skippedUnsupported', 'error', { name: file.name })
          continue
        }
        if (file.size === 0) {
          console.warn('Skipping empty/folder drop entry:', file.name)
          continue
        }
        const dup = filesRef.current.find(
          (f) => f.path.split(/[\\/]/).pop() === file.name && f.size === file.size,
        )
        if (dup) {
          console.warn('Skipping already-added drop entry:', file.name)
          continue
        }
        accepted.push(file)
      }
      if (accepted.length === 0) return

      setLoading(true)
      try {
        const tempBase = await window.Neutralino.os.getPath('temp')
        const dropDir = window.EstellaLib.platform.joinPath(
          tempBase,
          'FileConverterApp',
          'dropped',
          `${Date.now()}_${dropSeqRef.current++}`,
        )
        await window.Neutralino.filesystem.createDirectory(dropDir)

        const tempPaths = []
        for (let i = 0; i < accepted.length; i++) {
          const file = accepted[i]
          try {
            tempPaths.push(
              await copyDroppedFileToTemp(file, dropDir, (pct) => {
                setStatus('status.copyingDropped', 'busy', { index: i + 1, total: accepted.length, percent: pct })
              }),
            )
          } catch (err) {
            console.error('Failed to import dropped file: ' + file.name, err)
            setStatus('status.failedImport', 'error', { name: file.name })
            try {
              await window.Neutralino.filesystem.remove(window.EstellaLib.platform.joinPath(dropDir, file.name))
            } catch (e) {
              /* partial file may not exist */
            }
          }
        }
        if (tempPaths.length === 0) return

        // The originals' directory is unknowable in browser mode; default
        // the output dir to Downloads so handleFiles never picks the temp
        // dir. Must go through setOutputPathBoth (not the raw state
        // setter) so handleFiles' own `!outputPathRef.current` check below
        // sees this write immediately, before React re-renders.
        if (!outputPathRef.current) {
          const downloads = await window.Neutralino.os.getPath('downloads')
          setOutputPathBoth(downloads)
        }

        await handleFiles(tempPaths)
      } finally {
        setLoading(false)
      }
    },
    [copyDroppedFileToTemp, handleFiles, setOutputPathBoth, setStatus],
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

  // Native drag/drop handling — document-level dragenter/dragleave/
  // dragover/drop listeners plus the Neutralino 'filesDropped' event
  // (window mode's real native drop path). body.drag-active only drives
  // the whole-window overlay (styles.css) — files are droppable anywhere
  // on the page, so no single panel gets its own highlight; the file list
  // updating is the feedback a drop needs.
  const dragCounterRef = useRef(0)

  useEffect(() => {
    const onDragEnter = (e) => {
      e.preventDefault()
      dragCounterRef.current++
      document.body.classList.add('drag-active')
    }
    const onDragLeave = (e) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        document.body.classList.remove('drag-active')
      }
    }
    const onDragOver = (e) => e.preventDefault()
    const onDrop = (e) => {
      e.preventDefault()
      dragCounterRef.current = 0
      document.body.classList.remove('drag-active')

      // Window mode gets real paths via the native filesDropped event;
      // reading dataTransfer here as well would double-add the files.
      if (window.NL_MODE === 'window') return
      const dropped = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : []
      if (dropped.length > 0) importDroppedFiles(dropped)
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [importDroppedFiles])

  useEffect(() => {
    if (!window.Neutralino) return undefined
    const handler = (event) => {
      dragCounterRef.current = 0
      document.body.classList.remove('drag-active')

      const detail = event.detail
      let paths = []
      if (Array.isArray(detail)) {
        paths = detail.map((f) => (typeof f === 'string' ? f : f && f.path)).filter(Boolean)
      } else if (typeof detail === 'string') {
        paths = [detail]
      }

      if (paths.length > 0) {
        handleFiles(paths)
      } else if (detail != null && !Array.isArray(detail)) {
        console.error('Unrecognized filesDropped payload:', detail)
        setStatus('status.dropFailed', 'error')
      }
    }
    window.Neutralino.events.on('filesDropped', handler)
    return () => {
      window.Neutralino.events.off('filesDropped', handler)
    }
  }, [handleFiles, setStatus])

  const browseForFiles = useCallback(async () => {
    const entries = await window.Neutralino.os.showOpenDialog('Select files', { multiSelections: true })
    if (entries && entries.length > 0) handleFiles(entries)
  }, [handleFiles])

  const browseForOutputFolder = useCallback(async () => {
    const entry = await window.Neutralino.os.showFolderDialog('Select Output Folder')
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
