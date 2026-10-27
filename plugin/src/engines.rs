//! Optional engines (only Ghostscript so far).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Manager, Runtime};

use crate::pdf_compress::Outcome;

/// Ghostscript's console binary (no `.exe`; `sidecar::find` adds it).
pub const GS: &str = if cfg!(windows) { "gswin64c" } else { "gs" };

/// Ghostscript to use and where it came from: the user's own pick
/// (`"user"`), the app's downloaded copy in `own_dir` (`"installed"`,
/// ticket 05 fills it), else the first `system_dirs` hit (`"system"`).
pub fn resolve(user: Option<&Path>, own_dir: Option<PathBuf>, system_dirs: Vec<PathBuf>) -> Option<(&'static str, PathBuf)> {
  if let Some(u) = user.filter(|p| p.is_file()) {
    return Some(("user", u.to_path_buf()));
  }
  if let Some(p) = crate::sidecar::find(GS, [own_dir]) {
    return Some(("installed", p));
  }
  crate::sidecar::find(GS, system_dirs.into_iter().map(Some)).map(|p| ("system", p))
}

/// `engines.json` in the app config dir. Keys we don't know are kept as
/// they are.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ghostscript_path: Option<String>,
  /// The converter's first-run engine prompt has been shown.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub prompted: bool,
  #[serde(flatten)]
  pub rest: serde_json::Map<String, serde_json::Value>,
}

/// Missing file -> defaults; a broken one is an error (never silently reset).
pub fn load(file: &Path) -> Result<Config, String> {
  match std::fs::read(file) {
    Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", file.display())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
    Err(e) => Err(format!("{}: {e}", file.display())),
  }
}

/// Stores (Some, must be an existing file) or clears (None) the user's own
/// Ghostscript. Temp + rename, like presets.json.
pub fn set_user_path(file: &Path, path: Option<&str>) -> Result<(), String> {
  if let Some(p) = path.filter(|p| !Path::new(p).is_file()) {
    return Err(format!("{p}: not a file"));
  }
  let mut cfg = load(file)?;
  cfg.ghostscript_path = path.map(String::from);
  save(file, &cfg)
}

/// The first-run prompt is due: never shown, and no Ghostscript found. A
/// broken engines.json never nags.
pub fn needs_prompt(file: &Path, gs_found: bool) -> bool {
  !gs_found && load(file).is_ok_and(|c| !c.prompted)
}

pub fn set_prompted(file: &Path, prompted: bool) -> Result<(), String> {
  let mut cfg = load(file)?;
  cfg.prompted = prompted;
  save(file, &cfg)
}

fn save(file: &Path, cfg: &Config) -> Result<(), String> {
  let err = |e: std::io::Error| format!("{}: {e}", file.display());
  std::fs::create_dir_all(file.parent().unwrap_or(Path::new("."))).map_err(err)?;
  let tmp = file.with_extension("json.tmp");
  std::fs::write(&tmp, serde_json::to_vec_pretty(cfg).unwrap()).map_err(err)?;
  std::fs::rename(&tmp, file).map_err(err)
}

/// `pdfwrite` at the level's `-dPDFSETTINGS` (unknown -> `ebook`). A `%`
/// in `out` is a page-number template to gs, so it's escaped as `%%`.
pub fn gs_args(level: &str, input: &str, out: &str) -> Vec<String> {
  let level = if matches!(level, "screen" | "ebook" | "printer") { level } else { "ebook" };
  [
    "-sDEVICE=pdfwrite".to_string(),
    format!("-dPDFSETTINGS=/{level}"),
    "-dCompatibilityLevel=1.6".into(),
    "-dNOPAUSE".into(),
    "-dBATCH".into(),
    "-dSAFER".into(),
    "-dQUIET".into(),
    format!("-sOutputFile={}", out.replace('%', "%%")),
    input.into(),
  ]
  .into()
}

/// The smaller of the built-in result and Ghostscript's output. The
/// built-in's bytes are already the source when it couldn't shrink it, so
/// "smaller than that" also means "smaller than the source".
pub fn smallest(builtin: Outcome, gs: Option<Vec<u8>>) -> Outcome {
  match gs {
    Some(bytes) if bytes.len() < builtin.bytes.len() => Outcome { bytes, not_smaller: false },
    _ => builtin,
  }
}

/// One row of the hub's "Conversion engines" settings / the converter's
/// PDF status line. `state`: user | installed | system | missing.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  pub id: &'static str,
  pub name: &'static str,
  pub state: &'static str,
  /// What a job would run (None = missing).
  pub path: Option<String>,
  /// What the user picked, even when it no longer exists.
  pub user_path: Option<String>,
  pub license: &'static str,
  pub homepage: &'static str,
  /// macOS / Linux, when missing: the package-manager command to show.
  pub install_command: Option<&'static str>,
  /// The app can download it here (Windows only).
  pub installable: bool,
  /// The app's own downloaded copy exists (even when another one is used).
  pub installed: bool,
  /// Bytes `install` downloads (None where it can't).
  pub download_size: Option<u64>,
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("engines.json"))
}

/// The app's own copy: `%LOCALAPPDATA%\<identifier>\engines\ghostscript\`
/// on Windows; `install` downloads into it.
fn own_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
  app.path().app_local_data_dir().ok().map(|d| d.join("engines").join("ghostscript"))
}

/// PATH, plus Homebrew's bin dirs on macOS / Linux (a GUI app launched
/// from Finder doesn't get the shell's PATH).
fn system_dirs() -> Vec<PathBuf> {
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  if !cfg!(windows) {
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"].map(PathBuf::from));
  }
  dirs
}

/// Looked up fresh every time (no cache): "Check again" and a new job see
/// the current disk. A broken engines.json only drops the user's pick here.
pub fn ghostscript<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
  let user = config_file(app).and_then(|f| load(&f)).ok().and_then(|c| c.ghostscript_path);
  resolve(user.as_deref().map(Path::new), own_dir(app), system_dirs()).map(|(_, p)| p)
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Status>, String> {
  let user_path = load(&config_file(app)?)?.ghostscript_path;
  let own = own_dir(app);
  let installed = crate::sidecar::find(GS, [own.clone()]).is_some();
  let found = resolve(user_path.as_deref().map(Path::new), own, system_dirs());
  let install_command = match (found.is_some(), std::env::consts::OS) {
    (false, "macos") => Some("brew install ghostscript"),
    (false, "linux") => Some("sudo apt install ghostscript"),
    _ => None,
  };
  Ok(vec![Status {
    id: "ghostscript",
    name: "Ghostscript",
    state: found.as_ref().map_or("missing", |(s, _)| s),
    path: found.map(|(_, p)| p.to_string_lossy().into_owned()),
    user_path,
    license: "AGPL-3.0",
    homepage: "https://www.ghostscript.com/",
    install_command,
    installable: cfg!(windows),
    installed,
    download_size: cfg!(windows).then_some(GS_SIZE),
  }])
}

/// `engine_prompt`: show the converter's first-run prompt?
pub fn prompt_due<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
  Ok(needs_prompt(&config_file(app)?, ghostscript(app).is_some()))
}

pub fn mark_prompted<R: Runtime>(app: &AppHandle<R>, prompted: bool) -> Result<(), String> {
  set_prompted(&config_file(app)?, prompted)
}

pub fn set_path<R: Runtime>(app: &AppHandle<R>, engine: &str, path: Option<&str>) -> Result<Vec<Status>, String> {
  if engine != "ghostscript" {
    return Err(format!("unknown engine {engine:?}"));
  }
  set_user_path(&config_file(app)?, path.filter(|p| !p.is_empty()))?;
  status(app)
}

// --- Download (Windows): a pinned conda-forge package, never a remote list.

pub const GS_URL: &str = "https://conda.anaconda.org/conda-forge/win-64/ghostscript-10.08.0-hac47afa_0.conda";
pub const GS_SHA256: &str = "512BE9413C58B0AD3A2CD95A63EAEA73CBE32D9A6B9170C848BF825694A4ADB0";
pub const GS_SIZE: u64 = 19_295_904;
/// The download's name inside the staging dir.
const PACKAGE_FILE: &str = "package.conda";

/// What to download. `size` caps the download (None = dev override).
pub struct Package {
  pub url: String,
  pub sha256: String,
  pub size: Option<u64>,
}

/// The pinned package. Dev builds only (`debug_assertions`) honour
/// `SORAI_GS_URL` / `SORAI_GS_SHA256`, for the hub E2E's local server.
pub fn package() -> Package {
  #[cfg(debug_assertions)]
  if let Ok(url) = std::env::var("SORAI_GS_URL") {
    return Package { url, sha256: std::env::var("SORAI_GS_SHA256").unwrap_or_default(), size: None };
  }
  Package { url: GS_URL.into(), sha256: GS_SHA256.into(), size: Some(GS_SIZE) }
}

fn sha256_file(file: &Path) -> Result<String, String> {
  use sha2::Digest;
  let mut f = std::fs::File::open(file).map_err(|e| format!("{}: {e}", file.display()))?;
  let mut h = sha2::Sha256::new();
  let mut buf = vec![0; 1 << 16];
  loop {
    match std::io::Read::read(&mut f, &mut buf).map_err(|e| format!("{}: {e}", file.display()))? {
      0 => break,
      n => h.update(&buf[..n]),
    }
  }
  Ok(h.finalize().iter().map(|b| format!("{b:02X}")).collect())
}

/// Writes the `Library/bin/*` files of a `.conda` (zip -> `pkg-*.tar.zst`)
/// flat into `dest`. Init / fonts / CMaps are compiled into gsdll64.dll
/// (checked against the real package: SPEC "引擎下載"), so nothing else.
fn extract_bin(conda: &Path, dest: &Path, cancel: &AtomicBool) -> Result<(), String> {
  let err = |e: &dyn std::fmt::Display| format!("{}: {e}", conda.display());
  let mut zip = zip::ZipArchive::new(std::fs::File::open(conda).map_err(|e| err(&e))?).map_err(|e| err(&e))?;
  let index = (0..zip.len())
    .find(|&i| zip.name_for_index(i).and_then(|n| n.ok()).is_some_and(|n| n.starts_with("pkg-") && n.ends_with(".tar.zst")))
    .ok_or_else(|| err(&"no pkg-*.tar.zst inside"))?;
  let entry = zip.by_index(index).map_err(|e| err(&e))?;
  let zst = ruzstd::decoding::StreamingDecoder::new(entry).map_err(|e| err(&e))?;
  let mut tar = tar::Archive::new(zst);
  std::fs::create_dir_all(dest).map_err(|e| err(&e))?;
  for entry in tar.entries().map_err(|e| err(&e))? {
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    let mut entry = entry.map_err(|e| err(&e))?;
    let path = entry.path().map_err(|e| err(&e))?.into_owned();
    let Ok(rel) = path.strip_prefix("Library/bin") else { continue };
    if !entry.header().entry_type().is_file() {
      continue;
    }
    // A plain file name only: no subdirs, no `..`, nothing absolute.
    let mut parts = rel.components();
    let (Some(std::path::Component::Normal(name)), None) = (parts.next(), parts.next()) else { continue };
    let mut out = std::fs::File::create(dest.join(name)).map_err(|e| err(&e))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| err(&e))?;
  }
  Ok(())
}

/// After the download: `staging/package.conda` must hash to `sha256`
/// (case-insensitive), its `Library/bin` is extracted to `staging/`, then
/// renamed over `dest`. `staging` is always removed, so a mismatch, an
/// error or `cancel` leaves neither a download nor half an install.
pub fn finish_install(staging: &Path, sha256: &str, dest: &Path, cancel: &AtomicBool) -> Result<(), String> {
  let result = (|| {
    let conda = staging.join(PACKAGE_FILE);
    let got = sha256_file(&conda)?;
    if !got.eq_ignore_ascii_case(sha256) {
      return Err(format!("SHA-256 mismatch: expected {sha256}, got {got}"));
    }
    let bin = staging.join("ghostscript");
    extract_bin(&conda, &bin, cancel)?;
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    match std::fs::remove_dir_all(dest) {
      Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{}: {e}", dest.display())),
      _ => {}
    }
    std::fs::rename(&bin, dest).map_err(|e| format!("{}: {e}", dest.display()))
  })();
  let _ = std::fs::remove_dir_all(staging);
  result
}

/// Streams `pkg.url` into `to`, reporting 0-100 and polling `cancel`
/// between chunks.
async fn download(pkg: &Package, to: &Path, cancel: &AtomicBool, progress: &(dyn Fn(f64) + Sync)) -> Result<(), String> {
  use std::io::Write;
  // Same as tauri-plugin-updater: reqwest is built without a crypto provider.
  if rustls::crypto::CryptoProvider::get_default().is_none() {
    let _ = rustls::crypto::ring::default_provider().install_default();
  }
  let err = |e: reqwest::Error| format!("{}: {e}", pkg.url);
  let client = reqwest::Client::builder().read_timeout(Duration::from_secs(30)).build().map_err(err)?;
  let mut res = tokio::select! {
    r = client.get(&pkg.url).send() => r.and_then(|r| r.error_for_status()).map_err(err)?,
    _ = until(cancel) => return Err("cancelled".into()),
  };
  let total = res.content_length().or(pkg.size).unwrap_or(0);
  let mut file = std::fs::File::create(to).map_err(|e| format!("{}: {e}", to.display()))?;
  let mut got = 0u64;
  loop {
    // Raced against Cancel: a stalled connection mustn't hold it up.
    let chunk = tokio::select! {
      c = res.chunk() => c.map_err(err)?,
      _ = until(cancel) => return Err("cancelled".into()),
    };
    let Some(chunk) = chunk else { break };
    got += chunk.len() as u64;
    if pkg.size.is_some_and(|max| got > max) {
      return Err(format!("{}: larger than the expected {} bytes", pkg.url, pkg.size.unwrap()));
    }
    file.write_all(&chunk).map_err(|e| format!("{}: {e}", to.display()))?;
    if total > 0 {
      progress((got as f64 / total as f64 * 100.0).min(100.0));
    }
  }
  file.sync_all().map_err(|e| e.to_string())
}

async fn until(flag: &AtomicBool) {
  while !flag.load(Ordering::Relaxed) {
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
}

/// The running install's cancel flag (one install at a time).
static INSTALLING: std::sync::Mutex<Option<std::sync::Arc<AtomicBool>>> = std::sync::Mutex::new(None);

/// Downloads into `engines/.ghostscript.partial/`, verifies, extracts and
/// renames to the own-copy dir. Progress: download 0-95, then 100.
/// ponytail: quitting mid-download leaves the staging dir; the next
/// install starts by deleting it (it's never mistaken for an install).
pub async fn install<R: Runtime>(app: &AppHandle<R>, engine: &str, progress: impl Fn(f64) + Send + Sync) -> Result<Vec<Status>, String> {
  if engine != "ghostscript" {
    return Err(format!("unknown engine {engine:?}"));
  }
  if !cfg!(windows) {
    return Err("Ghostscript downloads are Windows-only".into());
  }
  let dest = own_dir(app).ok_or("no app data folder")?;
  let staging = dest.with_file_name(".ghostscript.partial");
  let cancel = {
    let mut slot = INSTALLING.lock().unwrap();
    if slot.is_some() {
      return Err("already installing".into());
    }
    slot.insert(Default::default()).clone()
  };
  let result = async {
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let pkg = package();
    download(&pkg, &staging.join(PACKAGE_FILE), &cancel, &|p| progress(p * 0.95)).await?;
    let (s, d, c) = (staging.clone(), dest.clone(), cancel.clone());
    tauri::async_runtime::spawn_blocking(move || finish_install(&s, &pkg.sha256, &d, &c)).await.map_err(|e| e.to_string())?
  }
  .await;
  let _ = std::fs::remove_dir_all(&staging);
  *INSTALLING.lock().unwrap() = None;
  result?;
  progress(100.0);
  status(app)
}

/// Cancels a running install (no-op otherwise); `install` then errors with
/// "cancelled" and has cleaned up.
pub fn cancel_install() {
  if let Some(c) = INSTALLING.lock().unwrap().as_ref() {
    c.store(true, Ordering::Relaxed);
  }
}

/// Deletes the app's own copy (a user-picked or PATH gs is never touched).
pub fn remove<R: Runtime>(app: &AppHandle<R>, engine: &str) -> Result<Vec<Status>, String> {
  if engine != "ghostscript" {
    return Err(format!("unknown engine {engine:?}"));
  }
  let dir = own_dir(app).ok_or("no app data folder")?;
  match std::fs::remove_dir_all(&dir) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", dir.display())),
    _ => status(app),
  }
}

static GS_SEQ: AtomicU64 = AtomicU64::new(0);

/// Runs `exe args` (its output goes to `out`), polling `cancel` to kill it.
/// Returns `out`'s bytes; `out` is always removed.
fn run_gs(exe: &Path, args: &[String], out: &Path, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
  let mut cmd = std::process::Command::new(exe);
  cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
  #[cfg(windows)]
  std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
  let result = (|| {
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", exe.display()))?;
    // Drained on a thread so a chatty gs can't block on a full pipe.
    let mut stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
      let mut s = String::new();
      let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
      s
    });
    let code = loop {
      if cancel.load(Ordering::Relaxed) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("cancelled".to_string());
      }
      match child.try_wait().map_err(|e| e.to_string())? {
        Some(code) => break code,
        None => std::thread::sleep(Duration::from_millis(50)),
      }
    };
    let errors = errors.join().unwrap_or_default();
    if !code.success() {
      let last = errors.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
      return Err(format!("exited with {code}: {last}"));
    }
    std::fs::read(out).map_err(|e| format!("{}: {e}", out.display()))
  })();
  let _ = std::fs::remove_file(out);
  result
}

/// PDF compress job body: the built-in compressor, then (when `gs` is set)
/// Ghostscript on the source into a temp file; the smaller result wins.
/// Ghostscript failing only logs and keeps the built-in result.
/// ponytail: progress is the built-in's 0-50%, then a jump to 100 after gs
/// (no per-page parsing); parse gs's `Page N` lines if long files feel stuck.
pub fn compress_best(
  bytes: &[u8],
  src: &str,
  level: &str,
  gs: Option<PathBuf>,
  cancel: &AtomicBool,
  progress: &dyn Fn(f64),
  log: &dyn Fn(String),
) -> Result<Outcome, String> {
  let Some(gs) = gs else { return crate::pdf_compress::compress(bytes, level, cancel, progress) };
  let builtin = crate::pdf_compress::compress(bytes, level, cancel, &|p| progress(p / 2.0))?;
  if cancel.load(Ordering::Relaxed) {
    return Ok(builtin); // the runner reports `cancelled` and drops it
  }
  let out = std::env::temp_dir().join(format!("sorai-gs-{}-{}.pdf", std::process::id(), GS_SEQ.fetch_add(1, Ordering::Relaxed)));
  let args = gs_args(level, src, &out.to_string_lossy());
  log(format!("+ Ghostscript: {}", crate::convert::display_command(&gs.to_string_lossy(), &args)));
  let gs_bytes = match run_gs(&gs, &args, &out, cancel) {
    Ok(b) => {
      log(format!("Ghostscript: {} bytes, built-in: {} bytes", b.len(), builtin.bytes.len()));
      Some(b)
    }
    Err(e) => {
      log(format!("Ghostscript failed, keeping the built-in result: {e}"));
      None
    }
  };
  progress(100.0);
  Ok(smallest(builtin, gs_bytes))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn dir_with(tag: &str, names: &[&str]) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sorai-engines-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    for n in names {
      std::fs::write(d.join(n), b"").unwrap();
    }
    d
  }

  /// A `.conda` like conda-forge's: a STORED zip with metadata, the
  /// `pkg-*.tar.zst` holding `files`, and an info tarball.
  fn fake_conda(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    for (name, data) in files {
      let mut h = tar::Header::new_gnu();
      h.set_size(data.len() as u64);
      h.set_mode(0o755);
      tar.append_data(&mut h, name, *data).unwrap();
    }
    let zst = ruzstd::encoding::compress_to_vec(&tar.into_inner().unwrap()[..], ruzstd::encoding::CompressionLevel::Fastest);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in [("metadata.json", &b"{\"conda_pkg_format_version\": 2}"[..]), ("pkg-ghostscript-1.0-x_0.tar.zst", &zst), ("info-ghostscript-1.0-x_0.tar.zst", &zst)] {
      zip.start_file(name, opts).unwrap();
      std::io::Write::write_all(&mut zip, data).unwrap();
    }
    zip.finish().unwrap().into_inner()
  }

  fn sha_hex(b: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(b).iter().map(|b| format!("{b:02X}")).collect()
  }

  /// `<engines>/.ghostscript.partial/package.conda`; returns (staging, dest).
  fn stage(engines: &Path, conda: &[u8]) -> (PathBuf, PathBuf) {
    let staging = engines.join(".ghostscript.partial");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join(PACKAGE_FILE), conda).unwrap();
    (staging, engines.join("ghostscript"))
  }

  fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
  }

  const PKG: &[(&str, &[u8])] = &[
    ("Library/bin/gswin64c.exe", b"exe"),
    ("Library/bin/gsdll64.dll", b"dll"),
    ("Library/Init/gs_init.ps", b"init"),
    ("Library/lib/gsdll64.lib", b"lib"),
    ("info/index.json", b"{}"),
  ];

  #[test]
  fn installs_only_library_bin_and_removes_the_staging_dir() {
    let engines = dir_with("install", &[]);
    let conda = fake_conda(PKG);
    let (staging, dest) = stage(&engines, &conda);
    finish_install(&staging, &sha_hex(&conda).to_lowercase(), &dest, &AtomicBool::new(false)).unwrap();
    assert_eq!(files_in(&dest), ["gsdll64.dll", "gswin64c.exe"]);
    assert_eq!(std::fs::read(dest.join("gswin64c.exe")).unwrap(), b"exe");
    assert_eq!(files_in(&engines), ["ghostscript"]);
    // Reinstalling replaces the old copy entirely.
    let conda = fake_conda(&[("Library/bin/gswin64c.exe", b"new")]);
    let (staging, _) = stage(&engines, &conda);
    finish_install(&staging, &sha_hex(&conda), &dest, &AtomicBool::new(false)).unwrap();
    assert_eq!(files_in(&dest), ["gswin64c.exe"]);
    assert_eq!(std::fs::read(dest.join("gswin64c.exe")).unwrap(), b"new");
  }

  #[test]
  fn sha_mismatch_is_refused_and_the_download_deleted() {
    let engines = dir_with("sha", &[]);
    let conda = fake_conda(PKG);
    let (staging, dest) = stage(&engines, &conda);
    let e = finish_install(&staging, GS_SHA256, &dest, &AtomicBool::new(false)).unwrap_err();
    assert!(e.starts_with("SHA-256 mismatch"), "{e}");
    assert_eq!(files_in(&engines), Vec::<String>::new());
  }

  #[test]
  fn cancel_or_a_broken_package_leaves_nothing() {
    let engines = dir_with("cancelled", &[]);
    let conda = fake_conda(PKG);
    let (staging, dest) = stage(&engines, &conda);
    assert_eq!(finish_install(&staging, &sha_hex(&conda), &dest, &AtomicBool::new(true)), Err("cancelled".into()));
    assert_eq!(files_in(&engines), Vec::<String>::new());
    // Right hash, but not a .conda: an error, nothing left either.
    let (staging, dest) = stage(&engines, b"not a zip");
    assert!(finish_install(&staging, &sha_hex(b"not a zip"), &dest, &AtomicBool::new(false)).is_err());
    assert_eq!(files_in(&engines), Vec::<String>::new());
  }

  #[test]
  fn resolves_user_path_then_own_copy_then_system() {
    let exe = format!("{GS}{}", std::env::consts::EXE_SUFFIX);
    let user = dir_with("user", &["my-gs.exe"]).join("my-gs.exe");
    let own = dir_with("own", &[&exe]);
    let sys = dir_with("sys", &[&exe]);
    let empty = dir_with("empty", &[]);
    let r = |u: Option<&Path>, o: &Path| resolve(u, Some(o.to_path_buf()), vec![empty.clone(), sys.clone()]);
    assert_eq!(r(Some(&user), &own), Some(("user", user.clone())));
    assert_eq!(r(None, &own), Some(("installed", own.join(&exe))));
    // A user path that no longer exists falls through.
    assert_eq!(r(Some(&empty.join("gone.exe")), &empty), Some(("system", sys.join(&exe))));
    assert_eq!(resolve(None, None, vec![empty.clone()]), None);
  }

  #[test]
  fn gs_args_map_the_level_and_write_to_the_temp_file() {
    assert_eq!(
      gs_args("screen", r"C:\a b\文件 一.pdf", r"C:\t\gs.pdf"),
      ["-sDEVICE=pdfwrite", "-dPDFSETTINGS=/screen", "-dCompatibilityLevel=1.6", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dQUIET", r"-sOutputFile=C:\t\gs.pdf", r"C:\a b\文件 一.pdf"]
    );
    assert!(gs_args("printer", "i", "o").contains(&"-dPDFSETTINGS=/printer".to_string()));
    // Anything unknown is the default level, never passed through.
    assert!(gs_args("/../x", "i", "o").contains(&"-dPDFSETTINGS=/ebook".to_string()));
    assert!(gs_args("ebook", "i", r"C:\100%\o.pdf").contains(&r"-sOutputFile=C:\100%%\o.pdf".to_string()));
  }

  #[test]
  fn keeps_the_smallest_of_builtin_and_ghostscript() {
    let o = |n: usize, not_smaller| Outcome { bytes: vec![b'b'; n], not_smaller };
    let size = |r: Outcome| (r.bytes.len(), r.bytes[0], r.not_smaller);
    assert_eq!(size(smallest(o(50, false), Some(vec![b'g'; 30]))), (30, b'g', false));
    assert_eq!(size(smallest(o(50, false), Some(vec![b'g'; 70]))), (50, b'b', false));
    // Built-in couldn't shrink it (bytes = the source, 100): gs at 90 wins.
    assert_eq!(size(smallest(o(100, true), Some(vec![b'g'; 90]))), (90, b'g', false));
    // Neither is smaller than the source: the source copy, flagged.
    assert_eq!(size(smallest(o(100, true), Some(vec![b'g'; 100]))), (100, b'b', true));
    // Ghostscript failed / not installed.
    assert_eq!(size(smallest(o(50, false), None)), (50, b'b', false));
  }

  #[test]
  fn user_path_is_stored_in_engines_json_keeping_other_keys() {
    let dir = dir_with("cfg", &["gs.exe"]);
    let (file, gs) = (dir.join("sub").join("engines.json"), dir.join("gs.exe"));
    assert_eq!(load(&file).unwrap().ghostscript_path, None); // no file yet
    set_user_path(&file, Some(gs.to_str().unwrap())).unwrap();
    assert_eq!(load(&file).unwrap().ghostscript_path.as_deref(), gs.to_str());
    // Other keys survive our writes.
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    v["prompted"] = true.into();
    std::fs::write(&file, v.to_string()).unwrap();
    set_user_path(&file, None).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(v, serde_json::json!({ "prompted": true }));
    // Must be an existing file; a broken engines.json is an error, not reset.
    assert!(set_user_path(&file, Some(dir.join("nope.exe").to_str().unwrap())).is_err());
    assert!(set_user_path(&file, Some(dir.to_str().unwrap())).is_err());
    std::fs::write(&file, "{oops").unwrap();
    assert!(load(&file).is_err());
    assert!(set_user_path(&file, None).is_err());
  }

  #[test]
  fn first_run_prompt_is_asked_once_and_never_when_gs_is_found() {
    let dir = dir_with("prompt", &["gs.exe"]);
    let file = dir.join("engines.json");
    assert!(needs_prompt(&file, false)); // fresh install
    assert!(!needs_prompt(&file, true)); // Ghostscript already there
    set_prompted(&file, true).unwrap();
    assert!(!needs_prompt(&file, false));
    // Keeps the user's pick; set_user_path keeps `prompted`.
    set_user_path(&file, Some(dir.join("gs.exe").to_str().unwrap())).unwrap();
    set_prompted(&file, true).unwrap();
    assert!(load(&file).unwrap().ghostscript_path.is_some());
    set_user_path(&file, None).unwrap();
    assert!(!needs_prompt(&file, false));
    // E2E resets it.
    set_prompted(&file, false).unwrap();
    assert!(needs_prompt(&file, false));
    // A broken engines.json never nags.
    std::fs::write(&file, "{oops").unwrap();
    assert!(!needs_prompt(&file, false));
  }

  #[test]
  fn cancel_kills_ghostscript_and_removes_its_temp_file() {
    // Stand-in for a long gs run: ~30 s unless killed.
    let (exe, args): (&str, Vec<String>) = if cfg!(windows) { ("ping", vec!["-n".into(), "30".into(), "127.0.0.1".into()]) } else { ("sleep", vec!["30".into()]) };
    let out = dir_with("cancel", &["gs.pdf"]).join("gs.pdf");
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(300));
      c.store(true, Ordering::Relaxed);
    });
    let started = std::time::Instant::now();
    assert_eq!(run_gs(Path::new(exe), &args, &out, &cancel), Err("cancelled".into()));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!out.exists());
  }
}
