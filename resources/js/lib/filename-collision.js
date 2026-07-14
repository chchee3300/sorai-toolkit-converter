// Extracted unchanged from resources/js/main.js (formerly getUniqueOutPath).
// Framework-agnostic strangler-fig seam: the future React port imports this
// unchanged — see design-system/MASTER.md.
(function (global) {
  async function getUniqueOutPath(outputPath, nameWithoutExt, format, statFn) {
    const stat = statFn || ((p) => Neutralino.filesystem.getStats(p));
    const slash = outputPath.includes('/') && !outputPath.includes('\\') ? '/' : '\\';
    let baseName = `${nameWithoutExt}_converted`;
    let outPath = `${outputPath}${slash}${baseName}${format}`;

    while (true) {
      try {
        await stat(outPath);
        baseName += '_converted';
        outPath = `${outputPath}${slash}${baseName}${format}`;
      } catch (e) {
        return outPath;
      }
    }
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.filenameCollision = { getUniqueOutPath };
})(window);
