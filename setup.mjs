// Cross-platform replacement for setup.ps1. Run with `node setup.mjs` on
// Windows, macOS, or Linux.
//
// ffmpeg is bundled on every platform (static build downloaded here). qpdf
// and img2pdf are bundled on Windows only -- on macOS/Linux they're
// system-installed dependencies (brew/apt/pip), so this script only probes
// for them and prints install hints rather than downloading anything. See
// resources/js/lib/platform.js for the runtime path/command resolution that
// matches this layout.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import { platform, arch } from 'node:os';
import path from 'node:path';

const BIN_DIR = path.resolve('binaries');

function findFileRecursive(dir, filename) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const fs = await import('node:fs');
  fs.writeFileSync(destPath, buf);
}

function tarBinary() {
  // Windows ships a real bsdtar (zip-capable) at System32\tar.exe since
  // 1803. Must reference it by full path rather than bare `tar` -- under
  // Git Bash / MSYS shells, /usr/bin/tar (plain GNU tar, no zip support:
  // fails with "This does not look like a tar archive" on a real zip)
  // shadows it on PATH.
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(sys32) ? sys32 : 'tar';
}

async function unzip(zipPath, destDir) {
  if (platform() === 'win32') {
    // Pass relative filenames with cwd set to the containing dir -- tar's
    // "X:..." remote-shell heuristic misfires on an absolute Windows path's
    // drive letter (e.g. "E:\foo" is parsed as host "E" + remote path) if
    // passed directly as an argument.
    execFileSync(
      tarBinary(),
      ['-xf', path.basename(zipPath), '-C', path.relative(path.dirname(zipPath), destDir) || '.'],
      { cwd: path.dirname(zipPath), stdio: 'inherit' },
    );
    return;
  }
  // macOS's system `tar` is bsdtar (zip-capable), but plain Linux distros
  // (confirmed: ubuntu-latest GitHub Actions runner) ship GNU tar with no
  // zip support at all -- fails the same way Git Bash's /usr/bin/tar does
  // on Windows ("This does not look like a tar archive" on a real zip).
  // `unzip` is the standard, near-universally-preinstalled tool for this
  // on both platforms, so use it uniformly here instead of relying on
  // whichever `tar` happens to be present.
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
}

async function setupWindows() {
  const dir = path.join(BIN_DIR, 'win_x64');
  mkdirSync(dir, { recursive: true });

  console.log('Downloading ffmpeg (win64)...');
  const ffmpegZip = path.join(dir, 'ffmpeg.zip');
  await downloadTo(
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    ffmpegZip,
  );
  const ffmpegTemp = path.join(dir, 'ffmpeg_temp');
  mkdirSync(ffmpegTemp, { recursive: true });
  await unzip(ffmpegZip, ffmpegTemp);
  const ffmpegExe = findFileRecursive(ffmpegTemp, 'ffmpeg.exe');
  if (ffmpegExe) copyFileSync(ffmpegExe, path.join(dir, 'ffmpeg.exe'));
  rmSync(ffmpegZip, { force: true });
  rmSync(ffmpegTemp, { recursive: true, force: true });

  console.log('Downloading qpdf (mingw64)...');
  const qpdfZip = path.join(dir, 'qpdf.zip');
  await downloadTo(
    'https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-mingw64.zip',
    qpdfZip,
  );
  const qpdfTemp = path.join(dir, 'qpdf_temp');
  mkdirSync(qpdfTemp, { recursive: true });
  await unzip(qpdfZip, qpdfTemp);
  const qpdfExe = findFileRecursive(qpdfTemp, 'qpdf.exe');
  if (!qpdfExe) throw new Error('qpdf.exe not found in downloaded archive');
  // Copy every file from qpdf's own bin/ folder (qpdf.exe, its qpdfNN.dll,
  // and its matching mingw runtime DLLs), not just qpdf.exe -- different
  // qpdf releases ship differently-named/versioned DLLs (e.g. v12.3.2 ships
  // qpdf30.dll + libgcc_s_seh-1.dll, not the libqpdf29.dll + libgcc_s_dw2-1.dll
  // an older pinned version might have used), so a name-filtered copy
  // silently drops the DLL qpdf.exe actually needs to load. ffmpeg's own
  // build here is fully static and doesn't touch these files, so
  // overwriting them with qpdf's bundled versions is safe.
  const qpdfBinDir = path.dirname(qpdfExe);
  for (const entry of readdirSync(qpdfBinDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
      copyFileSync(path.join(qpdfBinDir, entry.name), path.join(dir, entry.name));
    }
  }
  rmSync(qpdfZip, { force: true });
  rmSync(qpdfTemp, { recursive: true, force: true });

  console.log('Downloading img2pdf...');
  // Pinned release (verify for a newer tag at
  // https://gitlab.mister-muffin.de/josch/img2pdf/releases before assuming
  // this URL still resolves -- this host has no GitHub-style floating
  // "latest" alias).
  const img2pdfVersion = '0.5.1';
  await downloadTo(
    `https://gitlab.mister-muffin.de/josch/img2pdf/releases/download/${img2pdfVersion}/img2pdf.exe`,
    path.join(dir, 'img2pdf.exe'),
  );

  console.log('All Windows binaries downloaded successfully!');
}

// Both resolved live (not a pinned version) so this script doesn't go stale
// the way a hardcoded version tag would.
async function macFfmpegZipUrl() {
  // evermeet.cx's actively-maintained macOS static build. Its download page
  // advertises Apple Silicon support, and the release is a single build
  // used for both mac_x64/ and mac_arm64/ here -- there's no separate
  // per-arch artifact the way Windows/Linux have.
  const res = await fetch('https://evermeet.cx/ffmpeg/info/ffmpeg/release');
  if (!res.ok) throw new Error(`evermeet.cx info lookup failed (${res.status})`);
  const info = await res.json();
  return info.download.zip.url;
}

async function linuxFfmpegZipUrl(cpu) {
  // ffbinaries-prebuilt (github.com/ffbinaries/ffbinaries-prebuilt), a
  // long-standing source of static ffmpeg/ffprobe builds for Linux/macOS/
  // Windows. Resolved via its version-info JSON rather than a hand-built
  // URL, since the exact filename embeds the ffmpeg version.
  const res = await fetch('https://ffbinaries.com/api/v1/version/latest');
  if (!res.ok) throw new Error(`ffbinaries.com info lookup failed (${res.status})`);
  const info = await res.json();
  const key = cpu === 'arm64' ? 'linux-arm64' : 'linux-64';
  const entry = info.bin[key];
  if (!entry) throw new Error(`No ffbinaries build listed for ${key}`);
  return entry.ffmpeg;
}

async function setupFfmpegUnix(dirName, os, cpu) {
  const dir = path.join(BIN_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  const destPath = path.join(dir, 'ffmpeg');
  if (existsSync(destPath)) {
    console.log(`ffmpeg already present at binaries/${dirName}/ffmpeg, skipping download.`);
    return;
  }
  console.log(`Downloading ffmpeg (${dirName})...`);
  const url = os === 'darwin' ? await macFfmpegZipUrl() : await linuxFfmpegZipUrl(cpu);
  const zipPath = path.join(dir, 'ffmpeg.zip');
  await downloadTo(url, zipPath);
  await unzip(zipPath, dir);
  rmSync(zipPath, { force: true });
  chmodSync(destPath, 0o755);
  console.log(`ffmpeg installed to binaries/${dirName}/ffmpeg`);
}

function probeSystemTool(command, versionFlag = '--version') {
  try {
    execSync(`${command} ${versionFlag}`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

async function setupUnix(dirName, osLabel, os, cpu) {
  await setupFfmpegUnix(dirName, os, cpu);

  console.log(`\nChecking system dependencies for PDF features (${osLabel})...`);
  const hasQpdf = probeSystemTool('qpdf');
  const hasImg2pdf = probeSystemTool('img2pdf') || probeSystemTool('python3 -m img2pdf');

  console.log(`  qpdf:    ${hasQpdf ? 'found' : 'NOT FOUND'}`);
  console.log(`  img2pdf: ${hasImg2pdf ? 'found' : 'NOT FOUND'}`);

  if (!hasQpdf || !hasImg2pdf) {
    console.log('\nqpdf and img2pdf are not bundled on macOS/Linux -- install them system-wide:');
    if (!hasQpdf) {
      console.log(
        osLabel === 'macOS'
          ? '  brew install qpdf'
          : '  sudo apt install qpdf   (Debian/Ubuntu) — or your distro\'s equivalent package',
      );
    }
    if (!hasImg2pdf) {
      console.log('  pip install img2pdf');
    }
    console.log('PDF optimize and image-to-PDF conversion will show an in-app error until these are installed.');
  }
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const os = platform();

  if (os === 'win32') {
    await setupWindows();
  } else if (os === 'darwin') {
    await setupUnix(arch() === 'arm64' ? 'mac_arm64' : 'mac_x64', 'macOS', os, arch());
  } else if (os === 'linux') {
    await setupUnix('linux_x64', 'Linux', os, arch());
  } else {
    console.error(`Unsupported platform: ${os}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
