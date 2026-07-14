// Extracted unchanged from resources/js/main.js's execute handler.
// Framework-agnostic strangler-fig seam — see design-system/MASTER.md.
(function (global) {
  function buildPdfCommand({ binPath, file, outPath, optimize }) {
    const optFlag = optimize === 'linearize' ? '--linearize' : '--stream-data=compress';
    return `"${binPath}\\binaries\\qpdf.exe" ${optFlag} "${file}" "${outPath}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.qpdfCommands = { buildPdfCommand };
})(window);
