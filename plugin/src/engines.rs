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

/// `engines.json` in the app config dir. Keys we don't know (ticket 06's
/// `prompted`) are kept as they are.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ghostscript_path: Option<String>,
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
  let err = |e: std::io::Error| format!("{}: {e}", file.display());
  std::fs::create_dir_all(file.parent().unwrap_or(Path::new("."))).map_err(err)?;
  let tmp = file.with_extension("json.tmp");
  std::fs::write(&tmp, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(err)?;
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
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("engines.json"))
}

/// The app's own copy: `%LOCALAPPDATA%\<identifier>\engines\ghostscript\`
/// on Windows. Ticket 05 downloads into it; nothing writes it yet.
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
  let found = resolve(user_path.as_deref().map(Path::new), own_dir(app), system_dirs());
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
  }])
}

pub fn set_path<R: Runtime>(app: &AppHandle<R>, engine: &str, path: Option<&str>) -> Result<Vec<Status>, String> {
  if engine != "ghostscript" {
    return Err(format!("unknown engine {engine:?}"));
  }
  set_user_path(&config_file(app)?, path.filter(|p| !p.is_empty()))?;
  status(app)
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
  let Some(gs) = gs else { return crate::pdf_compress::compress(bytes, cancel, progress) };
  let builtin = crate::pdf_compress::compress(bytes, cancel, &|p| progress(p / 2.0))?;
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
    // Ticket 06's `prompted` (and anything else) survives our writes.
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
