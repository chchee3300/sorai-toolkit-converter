// Extracted unchanged from resources/js/main.js's runCommandWithLogs onProgress
// callback. Framework-agnostic strangler-fig seam — see design-system/MASTER.md.
(function (global) {
  // Returns a 0-100 percent, or null if this stderr chunk carries no usable
  // ffmpeg time= progress (mirrors the original's `if (fileObj.duration)` +
  // regex-miss guard, which silently left the DOM untouched in both cases).
  function parseProgress(data, duration, speed) {
    if (!duration) return null;
    const timeMatch = data.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (!timeMatch) return null;

    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const s = parseFloat(timeMatch[3]);
    const currentSec = h * 3600 + m * 60 + s;

    const totalOutputDuration = duration / (speed || 1.0);
    let percent = (currentSec / totalOutputDuration) * 100;
    if (percent > 100) percent = 100;
    return percent;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.progressParser = { parseProgress };
})(window);
