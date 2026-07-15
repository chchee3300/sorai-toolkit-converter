// Extracted unchanged from resources/js/main.js's execute handler.
// Framework-agnostic strangler-fig seam — see design-system/MASTER.md.
// qpdf is bundled on Windows only; on macOS/Linux it's a system-installed
// dependency resolved from PATH — see window.EstellaLib.platform.qpdfCommand.
(function (global) {
  function buildPdfCommand({ binPath, file, outPath, optimize }) {
    const optFlag = optimize === 'linearize' ? '--linearize' : '--stream-data=compress';
    return `"${global.EstellaLib.platform.qpdfCommand(binPath)}" ${optFlag} "${file}" "${outPath}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.qpdfCommands = { buildPdfCommand };
})(window);
