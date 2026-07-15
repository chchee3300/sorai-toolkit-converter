// Cross-platform seam for OS detection, path joining, and binary/command
// resolution. Every other lib file's `\binaries\...exe` string literal
// routes through here instead of hardcoding a separator/extension — see
// ffmpeg-commands.js / qpdf-commands.js / img2pdf-commands.js. Framework-
// agnostic strangler-fig seam, same window.EstellaLib attach pattern as the
// rest of resources/js/lib/.
(function (global) {
  // NL_OS is injected into the page by the native Neutralino binary at
  // runtime (not defined in the bundled neutralino.js client lib itself) --
  // 'Windows' | 'Linux' | 'Darwin'. Treat a missing value as Windows since
  // that's the only platform this app supported before this seam existed.
  function getOS() {
    return global.NL_OS;
  }

  function isWindows() {
    return getOS() === 'Windows' || getOS() === undefined;
  }

  function sep() {
    return isWindows() ? '\\' : '/';
  }

  // Joins already-clean path segments with the current OS's native
  // separator. No '..'/'.' normalization or de-duplication -- no caller
  // needs it.
  function joinPath(...parts) {
    return parts.filter((p) => p !== '' && p != null).join(sep());
  }

  // ffmpeg is bundled on every platform. binaries/win_x64, binaries/mac_x64,
  // binaries/mac_arm64, binaries/linux_x64 -- mac arch is split (not a
  // universal binary) to match the pattern bin/ already uses for the
  // Neutralino shell itself.
  function ffmpegPath(binPath) {
    if (isWindows()) return joinPath(binPath, 'binaries', 'win_x64', 'ffmpeg.exe');
    if (getOS() === 'Darwin') {
      const arch = global.NL_ARCH === 'arm64' ? 'mac_arm64' : 'mac_x64';
      return joinPath(binPath, 'binaries', arch, 'ffmpeg');
    }
    return joinPath(binPath, 'binaries', 'linux_x64', 'ffmpeg');
  }

  // qpdf/img2pdf: bundled .exe on Windows. On macOS/Linux these are
  // system-installed (brew/apt/pip) -- return the bare command name and let
  // the shell resolve it from PATH.
  function qpdfCommand(binPath) {
    return isWindows() ? joinPath(binPath, 'binaries', 'win_x64', 'qpdf.exe') : 'qpdf';
  }

  function img2pdfCommand(binPath) {
    return isWindows() ? joinPath(binPath, 'binaries', 'win_x64', 'img2pdf.exe') : 'img2pdf';
  }

  // Direct replacement for the old `window.NL_PATH.replace(/\//g, '\\')`
  // literal -- normalizes NL_PATH (which Neutralino may report with forward
  // slashes even on Windows) to the *current* OS's native separator instead
  // of assuming Windows.
  function resolveBinPath() {
    const raw = global.NL_PATH;
    return isWindows() ? raw.replace(/\//g, '\\') : raw.replace(/\\/g, '/');
  }

  // Presence probe for the two macOS/Linux system dependencies (qpdf,
  // img2pdf) -- resolves true/false rather than throwing, so callers can
  // gate a friendly error message instead of a cryptic spawn failure.
  async function checkToolAvailable(command) {
    try {
      const res = await global.Neutralino.os.execCommand(`${command} --version`);
      return res.exitCode === 0;
    } catch (e) {
      return false;
    }
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.platform = {
    getOS,
    isWindows,
    sep,
    joinPath,
    ffmpegPath,
    qpdfCommand,
    img2pdfCommand,
    resolveBinPath,
    checkToolAvailable,
  };
})(window);
