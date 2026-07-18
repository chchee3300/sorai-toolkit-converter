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
    const { quality: qualityPercent, speed, fps, format, codec, targetSizeMode, targetSizeMB } = settings.video
    const targetFpsStr = fps != null ? String(fps) : 'original'
    const targetFps = targetFpsStr === 'original' ? fileObj.fps : parseFloat(targetFpsStr)
    if (targetFpsStr !== 'original') targetFpsLabel = targetFpsStr
    if (targetSizeMode && targetSizeMB) {
      // Quick-compress mode drives bitrate from the target size, not the
      // relative-quality formula estimateVideoMB uses -- showing that
      // formula's result here would be actively misleading. The target
      // only needs to land UNDER the cap (see ffmpeg-commands.js's
      // TARGET_SIZE_SAFETY_MARGIN), so this preview shows a hair under it
      // rather than promising an exact hit.
      estMB = targetSizeMB * 0.95
    } else {
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
    }
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
    let cropAreaRatio = 1
    if (fileObj.crop && fileObj.width && fileObj.height) {
      cropAreaRatio = (fileObj.crop.width * fileObj.crop.height) / (fileObj.width * fileObj.height)
    }
    estMB = window.EstellaLib.sizeEstimate.estimateImageMB({
      currentSizeMB,
      format,
      quality,
      scale,
      sourcePath: fileObj.path,
      cropAreaRatio,
    })
  } else if (fileType === 'pdf') {
    estMB = window.EstellaLib.sizeEstimate.estimatePdfMB({ currentSizeMB, optimize: settings.pdf.optimize })
  }

  return { estMB, warn: estMB > currentSizeMB, targetFpsLabel }
}
