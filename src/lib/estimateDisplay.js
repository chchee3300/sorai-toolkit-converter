// Orchestrates window.EstellaLib.sizeEstimate.* the same way main.js's
// updateEstimations() did per-category (main.js:52-125 pre-extraction) —
// picks inputs from current settings + the file's own probed
// duration/fps/width/height. Unlike the vanilla version this isn't an
// imperative "call after every change" function: it's a pure function of
// current props, so React just re-renders it naturally. Returns null when
// there's nothing to show (already converted).
export function computeEstimate(fileObj, fileType, settings) {
  if (fileObj.converted) return null

  const currentSizeMB = fileObj.size / (1024 * 1024)
  let durationRatio = 1.0
  if (fileObj.duration > 0 && fileObj.trimStart !== undefined && fileObj.trimEnd !== undefined) {
    durationRatio = (fileObj.trimEnd - fileObj.trimStart) / fileObj.duration
  }

  let estMB = currentSizeMB * durationRatio
  let targetFpsLabel = null

  if (fileType === 'video') {
    const { quality: qualityPercent, speed, fps, format, codec } = settings.video
    const targetFpsStr = fps != null ? String(fps) : 'original'
    const targetFps = targetFpsStr === 'original' ? fileObj.fps : parseFloat(targetFpsStr)
    if (targetFpsStr !== 'original') targetFpsLabel = targetFpsStr
    estMB = window.EstellaLib.sizeEstimate.estimateVideoMB({
      currentSizeMB,
      durationRatio,
      qualityPercent,
      speed,
      format,
      targetFps,
      fileFps: fileObj.fps,
      codec,
    })
  } else if (fileType === 'audio') {
    const { format, bitrate: bitrateStr, speed } = settings.audio
    estMB = window.EstellaLib.sizeEstimate.estimateAudioMB({
      currentSizeMB,
      durationRatio,
      format,
      bitrateStr,
      speed,
      duration: fileObj.duration,
      sourcePath: fileObj.path,
    })
  } else if (fileType === 'image') {
    const { format, quality, scale } = settings.image
    estMB = window.EstellaLib.sizeEstimate.estimateImageMB({
      currentSizeMB,
      format,
      quality,
      scale,
      sourcePath: fileObj.path,
    })
  } else if (fileType === 'pdf') {
    estMB = window.EstellaLib.sizeEstimate.estimatePdfMB({ currentSizeMB, optimize: settings.pdf.optimize })
  }

  return { estMB, warn: estMB > currentSizeMB, targetFpsLabel }
}
