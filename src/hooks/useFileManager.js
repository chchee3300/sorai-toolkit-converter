import { useCallback, useEffect, useRef, useState } from 'react'

// Ported unchanged from resources/js/main.js's getFileType (main.js:6-18
// pre-extraction).
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm']
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif']
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

// Ported unchanged from main.js's getMediaInfo (main.js:20-50 pre-extraction).
async function getMediaInfo(path) {
  try {
    const binPath = window.NL_PATH.replace(/\//g, '\\')
    const command = `"${binPath}\\binaries\\ffmpeg.exe" -i "${path}"`
    const res = await window.Neutralino.os.execCommand(command)
    const output = res.stdErr
    const match = output.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/)
    const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s+fps/)
    const dimMatch = output.match(/(?:,\s+)(\d+)x(\d+)(?:[,\s]|$)/)

    let duration = 0
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0
    let width = 0
    let height = 0

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
    return { duration, fps, width, height }
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
  const [status, setStatusState] = useState({ text: 'Ready', state: 'ready' })

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

  const setOutputPathBoth = useCallback((value) => {
    outputPathRef.current = value
    setOutputPathState(value)
  }, [])

  const setStatus = useCallback((text, state = 'ready') => {
    setStatusState({ text, state })
  }, [])

  const handleFiles = useCallback(
    async (paths) => {
      setLoading(true)
      try {
        const additions = []
        let localType = fileType

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
              if (type === 'video' || type === 'audio' || type === 'image') {
                const info = await getMediaInfo(path)
                if (info) {
                  duration = info.duration || 0
                  fps = info.fps || 0
                  width = info.width || 0
                  height = info.height || 0
                }
              }
              additions.push({ path, size: stats.size, duration, fps, width, height })
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
    [fileType, onFirstFileType, setOutputPathBoth],
  )

  const dropSeqRef = useRef(0)

  const copyDroppedFileToTemp = useCallback(async (file, dropDir, onProgress) => {
    const CHUNK = window.__DROP_CHUNK_SIZE || 8 * 1024 * 1024
    const destPath = `${dropDir}\\${file.name}`
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
          setStatus(`Skipped unsupported file: ${file.name}`, 'error')
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
        const dropDir = `${tempBase}\\FileConverterApp\\dropped\\${Date.now()}_${dropSeqRef.current++}`
        await window.Neutralino.filesystem.createDirectory(dropDir)

        const tempPaths = []
        for (let i = 0; i < accepted.length; i++) {
          const file = accepted[i]
          try {
            tempPaths.push(
              await copyDroppedFileToTemp(file, dropDir, (pct) => {
                setStatus(`Copying dropped file ${i + 1}/${accepted.length} — ${pct}%`, 'busy')
              }),
            )
          } catch (err) {
            console.error('Failed to import dropped file: ' + file.name, err)
            setStatus(`Failed to import ${file.name}`, 'error')
            try {
              await window.Neutralino.filesystem.remove(`${dropDir}\\${file.name}`)
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
          setStatus('Ready', 'ready')
        }
        return next
      })
    },
    [setStatus],
  )

  const clearFiles = useCallback(() => {
    setFiles([])
    setFileType(null)
    setStatus('Ready', 'ready')
  }, [setStatus])

  // Native drag/drop visual effects — ported unchanged from main.js's
  // document-level dragenter/dragleave/dragover/drop listeners plus the
  // Neutralino 'filesDropped' event (window mode's real native drop path).
  const dragCounterRef = useRef(0)

  useEffect(() => {
    const onDragEnter = (e) => {
      e.preventDefault()
      dragCounterRef.current++
      document.body.classList.add('drag-active')
      const dropZone = document.getElementById('drop-zone')
      if (dropZone && !dropZone.classList.contains('hidden')) {
        dropZone.classList.add('dragover')
      }
    }
    const onDragLeave = (e) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        document.body.classList.remove('drag-active')
        const dropZone = document.getElementById('drop-zone')
        if (dropZone) dropZone.classList.remove('dragover')
      }
    }
    const onDragOver = (e) => e.preventDefault()
    const onDrop = (e) => {
      e.preventDefault()
      dragCounterRef.current = 0
      document.body.classList.remove('drag-active')
      const dropZone = document.getElementById('drop-zone')
      if (dropZone) dropZone.classList.remove('dragover')

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
      const dropZone = document.getElementById('drop-zone')
      if (dropZone) dropZone.classList.remove('dragover')

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
        setStatus('Drop failed — unrecognized payload', 'error')
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
  }
}
