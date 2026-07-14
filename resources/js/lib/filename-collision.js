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

  // Same collision-avoidance loop as getUniqueOutPath, but reserves N
  // extensions sharing one suffix base in a single pass — needed when one
  // conversion produces/consumes multiple paths at once (e.g. PDF->DOCX
  // staging a same-named .pdf copy alongside the real .docx output) and two
  // independent getUniqueOutPath calls could otherwise land on divergent
  // suffixes for what's meant to be the same logical file.
  async function getUniqueOutPathMulti(outputPath, nameWithoutExt, formats, statFn) {
    const stat = statFn || ((p) => Neutralino.filesystem.getStats(p));
    const slash = outputPath.includes('/') && !outputPath.includes('\\') ? '/' : '\\';
    let baseName = `${nameWithoutExt}_converted`;

    while (true) {
      const candidates = formats.map((f) => `${outputPath}${slash}${baseName}${f}`);
      const existsFlags = await Promise.all(
        candidates.map((p) => stat(p).then(() => true).catch(() => false)),
      );
      if (existsFlags.every((e) => !e)) return candidates;
      baseName += '_converted';
    }
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.filenameCollision = { getUniqueOutPath, getUniqueOutPathMulti };
})(window);
