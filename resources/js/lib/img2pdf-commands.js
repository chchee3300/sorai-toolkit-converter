// Image -> PDF, via img2pdf (lossless embed, no quality/scale knobs — that's
// why ImageSettings hides those fields when format is .pdf). Bundled on
// Windows only; on macOS/Linux it's a system-installed (pip) dependency
// resolved from PATH — see window.EstellaLib.platform.img2pdfCommand. Same
// window.EstellaLib attach pattern as qpdf-commands.js.
(function (global) {
  function buildImageToPdfCommand({ binPath, file, outPath }) {
    return `"${global.EstellaLib.platform.img2pdfCommand(binPath)}" "${file}" -o "${outPath}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.img2pdfCommands = { buildImageToPdfCommand };
})(window);
