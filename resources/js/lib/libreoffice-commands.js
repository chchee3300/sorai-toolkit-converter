// PDF -> DOCX/ODT, via the bundled LibreOffice Portable's soffice.exe in
// headless mode. soffice's --convert-to has no "exact output path" flag —
// it only accepts --outdir and always names the result
// <input-basename>.<ext>. Callers MUST pass a `stagedFile` whose basename
// (sans extension) already equals the desired final output basename — see
// useExecute.js, which copies the real source PDF to that staged name
// (via getUniqueOutPathMulti) before invoking this command, then deletes
// the staged copy afterward.
(function (global) {
  function buildPdfConvertCommand({ binPath, stagedFile, outDir, format }) {
    const convertToArg = format === '.docx' ? 'docx:"MS Word 2007 XML"' : 'odt';
    return `"${binPath}\\binaries\\LibreOfficePortable\\App\\libreoffice\\program\\soffice.exe" --headless --convert-to ${convertToArg} --outdir "${outDir}" "${stagedFile}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.libreOfficeCommands = { buildPdfConvertCommand };
})(window);
