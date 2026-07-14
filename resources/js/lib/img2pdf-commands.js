// Image -> PDF, via the bundled img2pdf.exe (lossless embed, no quality/scale
// knobs — that's why ImageSettings hides those fields when format is .pdf).
// Same window.EstellaLib attach pattern as qpdf-commands.js.
(function (global) {
  function buildImageToPdfCommand({ binPath, file, outPath }) {
    return `"${binPath}\\binaries\\img2pdf.exe" "${file}" -o "${outPath}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.img2pdfCommands = { buildImageToPdfCommand };
})(window);
