import { useCallback, useState } from 'react'

// Ported unchanged from main.js's runCommandWithLogs (main.js:492-518
// pre-extraction), decoupled from direct DOM writes: the caller supplies
// onLog/onProgress instead of this function touching #terminal-log itself.
function runCommandWithLogs(command, onLog, onProgress) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      try {
        const processInfo = await window.Neutralino.os.spawnProcess(command)
        const pid = processInfo.id
        const handler = (evt) => {
          if (evt.detail.id === pid) {
            if (evt.detail.action === 'stdOut' || evt.detail.action === 'stdErr') {
              onLog(evt.detail.data)
              if (onProgress) onProgress(evt.detail.data)
            }
            if (evt.detail.action === 'exit') {
              window.Neutralino.events.off('spawnedProcess', handler)
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

// Ported unchanged from main.js's btn-execute click handler
// (main.js:1021-1159 pre-extraction), wired to the same Phase 0.4
// EstellaLib.* modules the vanilla app calls. files/settings/outputPath
// come from useFileManager/useSettings — this is why ProgressBar (plan
// slice 4) was merged into the same push as DropZone/SettingsPanel: it
// needs the exact same lifted state.
export function useExecute({ files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus }) {
  const [executing, setExecuting] = useState(false)
  const [progressVisible, setProgressVisible] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressText, setProgressText] = useState('Processing...')
  const [terminalLog, setTerminalLog] = useState('')

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

            await runCommandWithLogs(
              command,
              (chunk) => setTerminalLog((prev) => prev + chunk),
              (chunk) => {
                const percent = window.EstellaLib.progressParser.parseProgress(chunk, fileObj.duration, speedForProgress)
                if (percent !== null) {
                  setProgressPercent(percent)
                  setProgressText(`Processing: ${filename} (${i + 1}/${files.length}) - ${Math.round(percent)}%`)
                }
              },
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
            alert(`Failed to process ${filename}:\n${err.message || err}`)
            setStatus(`Error: ${filename}`, 'error')
          }
        }
      }
    } catch (fatalErr) {
      alert('FATAL ERROR inside loop:\n' + (fatalErr.message || fatalErr) + '\n' + fatalErr.stack)
      setStatus('Fatal error', 'error')
    }

    setProgressPercent(100)
    setProgressText(`Completed ${completed} of ${files.length}!`)
    setStatus(`Done — ${completed} of ${files.length} converted`, 'ready')
    setExecuting(false)
    setTimeout(() => {
      setProgressVisible(false)
      setProgressText('Processing...')
      setProgressPercent(0)
    }, 5000)
  }, [files, setFiles, fileType, settings, outputPath, setOutputPath, setStatus])

  return { execute, executing, progressVisible, progressPercent, progressText, terminalLog }
}
