// Extracted unchanged (logic-for-logic) from resources/js/main.js's
// updateEstimations(). Framework-agnostic strangler-fig seam — see
// design-system/MASTER.md. Pure math only; DOM writes (innerHTML, the
// resolution-preview text) stay in main.js/the future React components.
(function (global) {
  function estimateVideoMB({ currentSizeMB, durationRatio, qualityPercent, speed, format, targetFps, fileFps, codec }) {
    let fpsFactor = 1.0;
    if (targetFps && fileFps) {
      fpsFactor = targetFps / fileFps;
    }

    let estMB;
    if (format === '.gif') {
      let scaleFactor = qualityPercent / 100;
      estMB = currentSizeMB * durationRatio * (scaleFactor * scaleFactor) * fpsFactor * 2.5 / speed;
    } else {
      estMB = (currentSizeMB * durationRatio * (qualityPercent / 100) * fpsFactor) / speed;
      const codecFactor = { libx264: 1.0, libx265: 0.6, 'libvpx-vp9': 0.65, libsvtav1: 0.5 }[codec] || 1.0;
      estMB *= codecFactor;
    }
    if (estMB < 0.1) estMB = 0.1;
    return estMB;
  }

  function estimateAudioMB({ currentSizeMB, durationRatio, format, bitrateStr, speed, duration, sourcePath }) {
    let kbps = parseInt(bitrateStr.replace('k', ''));
    if (format === '.flac') kbps = 900;
    else if (format === '.wav') kbps = 1411;

    let estMB = currentSizeMB * durationRatio;
    if (duration) {
      let trimmedDuration = duration * durationRatio;
      let calculatedEst = (kbps * 1000 * trimmedDuration) / 8 / (1024 * 1024) / speed;
      const lowerPath = sourcePath.toLowerCase();
      if ((format === '.flac' && lowerPath.endsWith('.flac')) ||
          (format === '.wav' && lowerPath.endsWith('.wav'))) {
        estMB = currentSizeMB * durationRatio / speed;
      } else {
        estMB = calculatedEst;
      }
    } else {
      estMB = estMB / speed;
    }
    return estMB;
  }

  function estimateImageMB({ currentSizeMB, format, quality, scale, sourcePath, cropAreaRatio }) {
    // img2pdf embeds losslessly — quality/scale/crop don't apply to this
    // path (ImageSettings hides those fields once .pdf is selected).
    if (format === '.pdf') {
      return currentSizeMB + 0.05;
    }

    let baseSize = currentSizeMB;
    const lowerPath = sourcePath.toLowerCase();
    if (format === '.png') {
      if (!lowerPath.endsWith('.png')) {
        baseSize = currentSizeMB * 2.5;
      }
    } else if (lowerPath.endsWith('.png')) {
      baseSize = currentSizeMB * 0.4;
    }
    // cropAreaRatio: (crop.width * crop.height) / (source.width * source.height),
    // 1 when no crop is set — pixel area removed by crop shrinks the estimate
    // the same way the scale factor does, independently of it.
    const areaRatio = cropAreaRatio != null ? cropAreaRatio : 1;
    return baseSize * (quality / 100) * (scale / 100) * (scale / 100) * areaRatio;
  }

  function estimatePdfMB({ currentSizeMB, optimize }) {
    return optimize === 'compress' ? currentSizeMB * 0.7 : currentSizeMB * 1.02;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.sizeEstimate = { estimateVideoMB, estimateAudioMB, estimateImageMB, estimatePdfMB };
})(window);
