//! The command-line tools the app ships (ffmpeg, yt-dlp, qpdf, img2pdf),
//! updatable from the hub's Settings ("第三方軟體", beside Ghostscript in
//! engines.rs), and optional ones it doesn't ship (`optional`: Deno for
//! yt-dlp, oxipng for PNG output, wordcraft-cli for documents), installed
//! from the same place. A download is the project's newest release
//! (Windows builds only) into `app_local_data_dir()/engines/<id>/`, which
//! both plugins' `sidecar::bundled` check before the bundled copy. Removing
//! it goes back to the bundled one (an optional tool: not installed).
//!
//! Integrity: GitHub's asset `digest` (SHA-256) is checked; img2pdf's Gitea
//! host publishes none (TLS only). The download must also run
//! (`<exe> --version`) before it replaces anything.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::engines::{self, Package, Status};

pub struct Tool {
  /// Also the exe name and the `engines/<id>/` folder (so `wordcraft-cli`).
  pub id: &'static str,
  pub name: &'static str,
  pub license: &'static str,
  pub homepage: &'static str,
  version_args: &'static [&'static str],
  release: Release,
  /// macOS / Linux, when it isn't found.
  install_command: [&'static str; 2],
  /// Not shipped with the app: only a download (or PATH) provides it.
  pub optional: bool,
}

enum Release {
  /// owner/repo, and the release to read ("latest" or "tags/<tag>").
  GitHub(&'static str, &'static str),
  /// owner/repo on img2pdf's Gitea host.
  Gitea(&'static str),
}

pub const TOOLS: [Tool; 7] = [
  Tool {
    id: "ffmpeg",
    name: "FFmpeg",
    license: "GPL-3.0",
    homepage: "https://ffmpeg.org/",
    version_args: &["-version"],
    // The same nightly build the installer bundles (setup.mjs).
    release: Release::GitHub("BtbN/FFmpeg-Builds", "tags/latest"),
    install_command: ["brew install ffmpeg", "sudo apt install ffmpeg"],
    optional: false,
  },
  Tool {
    id: "yt-dlp",
    name: "yt-dlp",
    license: "Unlicense",
    homepage: "https://github.com/yt-dlp/yt-dlp",
    version_args: &["--version"],
    release: Release::GitHub("yt-dlp/yt-dlp", "latest"),
    install_command: ["brew install yt-dlp", "sudo apt install yt-dlp"],
    optional: false,
  },
  Tool {
    id: "qpdf",
    name: "qpdf",
    license: "Apache-2.0",
    homepage: "https://qpdf.sourceforge.io/",
    version_args: &["--version"],
    release: Release::GitHub("qpdf/qpdf", "latest"),
    install_command: ["brew install qpdf", "sudo apt install qpdf"],
    optional: false,
  },
  Tool {
    id: "img2pdf",
    name: "img2pdf",
    license: "LGPL-3.0",
    homepage: "https://gitlab.mister-muffin.de/josch/img2pdf",
    version_args: &["--version"],
    release: Release::Gitea("josch/img2pdf"),
    install_command: ["pip install img2pdf", "sudo apt install img2pdf"],
    optional: false,
  },
  // yt-dlp solves YouTube's JavaScript challenges with it (without one,
  // YouTube often offers only some formats); the downloader passes
  // `--js-runtimes deno:<path>` when the app has its own copy.
  Tool {
    id: "deno",
    name: "Deno",
    license: "MIT",
    homepage: "https://deno.com/",
    version_args: &["--version"],
    release: Release::GitHub("denoland/deno", "latest"),
    install_command: ["brew install deno", "curl -fsSL https://deno.land/install.sh | sh"],
    optional: true,
  },
  // Lossless PNG optimiser, run on every PNG the converter writes.
  Tool {
    id: "oxipng",
    name: "oxipng",
    license: "MIT",
    homepage: "https://github.com/oxipng/oxipng",
    version_args: &["--version"],
    release: Release::GitHub("oxipng/oxipng", "latest"),
    install_command: ["brew install oxipng", "sudo apt install oxipng"],
    optional: true,
  },
  // Word documents (the converter's "document" type). Its release has no
  // CLI-only Windows zip: the portable zip's wordcraft-cli.exe is taken.
  Tool {
    id: "wordcraft-cli",
    name: "WordCraft",
    license: "Apache-2.0",
    homepage: "https://github.com/storytold/wordcraft",
    version_args: &["--version"],
    release: Release::GitHub("storytold/wordcraft", "latest"),
    install_command: ["https://github.com/storytold/wordcraft/releases", "https://github.com/storytold/wordcraft/releases"],
    optional: true,
  },
];

pub fn find(id: &str) -> Option<&'static Tool> {
  TOOLS.iter().find(|t| t.id == id)
}

// --- Versions

/// The version in `<exe> <version_args>` output: ffmpeg's BtbN builds end
/// in their build date (`N-125628-ga5e6c0175a-20260715` -> `2026-07-15`, the
/// form `latest` gives too); other ffmpeg builds give their own string.
pub fn parse_version(id: &str, out: &str) -> Option<String> {
  let line = out.lines().next()?.trim();
  let v = match id {
    "ffmpeg" => {
      let v = line.strip_prefix("ffmpeg version ")?.split_whitespace().next()?;
      match v.rsplit_once('-') {
        Some((_, d)) if d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()) => format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..]),
        _ => v.to_string(),
      }
    }
    "qpdf" => line.strip_prefix("qpdf version ")?.trim().to_string(),
    // "img2pdf.exe 0.5.1", "oxipng 10.2.1", "wordcraft-cli 0.16.0"
    "img2pdf" | "oxipng" | "wordcraft-cli" => line.split_whitespace().last()?.to_string(),
    // "deno 2.9.8 (stable, release, x86_64-pc-windows-msvc)"
    "deno" => line.split_whitespace().nth(1)?.to_string(),
    _ => line.to_string(),
  };
  (!v.is_empty()).then_some(v)
}

/// The number groups in a version: `2026.10.26`, `12.4.2`, `2026-11-06`.
pub fn version_key(v: &str) -> Vec<u64> {
  v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect()
}

/// `a` is a later version than `b` (a version without numbers never is).
pub fn newer(a: &str, b: &str) -> bool {
  let (a, b) = (version_key(a), version_key(b));
  !a.is_empty() && a > b
}

/// `<exe> --version`, cached by path + modified time (yt-dlp takes about a
/// second to start; Settings asks on every open).
static PROBED: Mutex<Vec<(PathBuf, std::time::SystemTime, Option<String>)>> = Mutex::new(Vec::new());

pub fn probe(tool: &Tool, exe: &Path) -> Option<String> {
  let modified = std::fs::metadata(exe).and_then(|m| m.modified()).ok()?;
  if let Some((_, _, v)) = PROBED.lock().unwrap().iter().find(|(p, m, _)| p == exe && *m == modified) {
    return v.clone();
  }
  let mut cmd = std::process::Command::new(exe);
  cmd.args(tool.version_args).stdin(std::process::Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  let v = cmd.output().ok().filter(|o| o.status.success()).and_then(|o| parse_version(tool.id, &String::from_utf8_lossy(&o.stdout)));
  let mut cache = PROBED.lock().unwrap();
  cache.retain(|(p, _, _)| p != exe);
  cache.push((exe.to_path_buf(), modified, v.clone()));
  v
}

// --- Where it is

/// `engines/<id>/`: the updated copy (what `sidecar::bundled` checks first).
pub fn own_dir<R: Runtime>(app: &AppHandle<R>, tool: &Tool) -> Option<PathBuf> {
  app.path().app_local_data_dir().ok().map(|d| d.join("engines").join(tool.id))
}

/// The copy the app ships (resource dir, then beside the exe).
fn shipped<R: Runtime>(app: &AppHandle<R>, tool: &Tool) -> Option<PathBuf> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  crate::sidecar::find(tool.id, [app.path().resource_dir().ok(), exe_dir])
}

/// The version an update wrote beside its exe (no process to run).
const VERSION_FILE: &str = "version.txt";

pub fn status<R: Runtime>(app: &AppHandle<R>, tool: &Tool) -> Status {
  let own = own_dir(app, tool).and_then(|d| crate::sidecar::find(tool.id, [Some(d)]));
  let found = own
    .clone()
    .map(|p| ("updated", p))
    .or_else(|| shipped(app, tool).map(|p| ("bundled", p)))
    .or_else(|| crate::sidecar::find(tool.id, engines::system_dirs().into_iter().map(Some)).map(|p| ("system", p)));
  let version = found.as_ref().and_then(|(_, p)| probe(tool, p));
  let install_command = match (found.is_some(), std::env::consts::OS) {
    (false, "macos") => Some(tool.install_command[0]),
    (false, "linux") => Some(tool.install_command[1]),
    _ => None,
  };
  Status {
    id: tool.id,
    kind: "tool",
    name: tool.name,
    state: found.as_ref().map_or("missing", |(s, _)| s),
    path: found.map(|(_, p)| p.to_string_lossy().into_owned()),
    version,
    user_path: None,
    license: tool.license,
    homepage: tool.homepage,
    install_command,
    installable: cfg!(windows),
    installed: own.is_some(),
    download_size: None,
    optional: tool.optional,
  }
}

/// At startup (a thread): an updated copy that the bundled one has caught up
/// with (the app itself was updated since) is deleted, so it can't shadow a
/// newer bundled build. ponytail: a job already running it keeps the files
/// locked; then it goes at the next start.
pub fn drop_stale<R: Runtime>(app: &AppHandle<R>) {
  for tool in &TOOLS {
    let Some(dir) = own_dir(app, tool).filter(|d| d.is_dir()) else { continue };
    let Some(mine) = std::fs::read_to_string(dir.join(VERSION_FILE)).ok() else { continue };
    let Some(bundled) = shipped(app, tool).and_then(|p| probe(tool, &p)) else { continue };
    if !newer(mine.trim(), &bundled) {
      let _ = std::fs::remove_dir_all(&dir);
    }
  }
}

// --- The newest release

/// What `latest` found for one tool.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
  pub id: &'static str,
  pub version: Option<String>,
  /// Download bytes.
  pub size: Option<u64>,
  pub error: Option<String>,
}

/// The release download for a tool, from its release JSON.
#[derive(Debug, PartialEq)]
pub struct Asset {
  pub version: String,
  pub url: String,
  pub size: u64,
  /// Hex SHA-256 (GitHub's `digest`); None where the host gives none.
  pub sha256: Option<String>,
}

/// The file to download from `release` (GitHub / Gitea release JSON).
pub fn pick_asset(tool: &Tool, release: &Value) -> Result<Asset, String> {
  let tag = release["tag_name"].as_str().ok_or("no tag_name in the release")?;
  let want = match tool.id {
    "ffmpeg" => "ffmpeg-master-latest-win64-gpl.zip".to_string(),
    "qpdf" => format!("qpdf-{}-mingw64.zip", tag.trim_start_matches('v')),
    "deno" => "deno-x86_64-pc-windows-msvc.zip".to_string(),
    "oxipng" => format!("oxipng-{}-x86_64-pc-windows-msvc.zip", tag.trim_start_matches('v')),
    "wordcraft-cli" => format!("wordcraft-{}-windows-x64-portable.zip", tag.trim_start_matches('v')),
    id => format!("{id}.exe"),
  };
  let asset = release["assets"]
    .as_array()
    .and_then(|a| a.iter().find(|a| a["name"] == want.as_str()))
    .ok_or_else(|| format!("{want} is not in release {tag}"))?;
  let version = match tool.id {
    // "latest" is rebuilt daily: its date is the version (as parse_version gives it).
    "ffmpeg" => asset["updated_at"].as_str().and_then(|d| d.get(..10)).ok_or("no updated_at")?.to_string(),
    _ => tag.trim_start_matches('v').to_string(),
  };
  Ok(Asset {
    version,
    url: asset["browser_download_url"].as_str().ok_or("no browser_download_url")?.to_string(),
    size: asset["size"].as_u64().unwrap_or(0),
    sha256: asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_string),
  })
}

/// Where release JSON comes from. Dev builds (`debug_assertions`) honour
/// `SORAI_TOOLS_API` for the hub E2E's local server: GitHub's API under
/// it, Gitea's under `<it>/gitea`.
fn release_url(tool: &Tool) -> String {
  #[cfg(debug_assertions)]
  if let Ok(base) = std::env::var("SORAI_TOOLS_API") {
    return match tool.release {
      Release::GitHub(repo, which) => format!("{base}/repos/{repo}/releases/{which}"),
      Release::Gitea(repo) => format!("{base}/gitea/repos/{repo}/releases/latest"),
    };
  }
  match tool.release {
    Release::GitHub(repo, which) => format!("https://api.github.com/repos/{repo}/releases/{which}"),
    Release::Gitea(repo) => format!("https://gitlab.mister-muffin.de/api/v1/repos/{repo}/releases/latest"),
  }
}

async fn newest(tool: &Tool) -> Result<Asset, String> {
  let url = release_url(tool);
  let body = engines::client()?
    .get(&url)
    .header("Accept", "application/json")
    .send()
    .await
    .and_then(|r| r.error_for_status())
    .map_err(|e| format!("{url}: {e}"))?
    .text()
    .await
    .map_err(|e| format!("{url}: {e}"))?;
  let release: Value = serde_json::from_str(&body).map_err(|e| format!("{url}: {e}"))?;
  pick_asset(tool, &release)
}

/// One tool's newest release (one request; a failed lookup is `error`).
pub async fn latest(tool: &Tool) -> Latest {
  match newest(tool).await {
    Ok(a) => Latest { id: tool.id, version: Some(a.version), size: Some(a.size), error: None },
    Err(e) => Latest { id: tool.id, version: None, size: None, error: Some(e) },
  }
}

// --- Install / update (Windows)

/// The files to take from a release zip: ffmpeg only its `bin/ffmpeg.exe`
/// (ffprobe / ffplay aren't used); qpdf every exe and dll in `bin/`
/// (qpdf.exe needs its DLLs beside it); the others just `<id>.exe`, in any
/// folder (WordCraft's zip also has the 139 MB desktop app).
pub fn wanted(tool: &Tool, zip_path: &str) -> Option<String> {
  let (dir, name) = zip_path.rsplit_once('/').unwrap_or(("", zip_path));
  let lower = name.to_ascii_lowercase();
  let in_bin = dir == "bin" || dir.ends_with("/bin");
  let keep = match tool.id {
    "ffmpeg" => in_bin && lower == "ffmpeg.exe",
    "qpdf" => in_bin && (lower.ends_with(".exe") || lower.ends_with(".dll")),
    id => lower == format!("{id}.exe"),
  };
  keep.then(|| name.to_string())
}

/// Writes the `wanted` files of `zip` flat into `dest`.
pub fn extract(tool: &Tool, zip: &Path, dest: &Path, cancel: &AtomicBool) -> Result<(), String> {
  let err = |e: &dyn std::fmt::Display| format!("{}: {e}", zip.display());
  let mut archive = zip::ZipArchive::new(std::fs::File::open(zip).map_err(|e| err(&e))?).map_err(|e| err(&e))?;
  std::fs::create_dir_all(dest).map_err(|e| err(&e))?;
  for i in 0..archive.len() {
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    let mut entry = archive.by_index(i).map_err(|e| err(&e))?;
    if !entry.is_file() {
      continue;
    }
    let Some(name) = entry.name().ok().and_then(|n| wanted(tool, &n.replace('\\', "/"))) else { continue };
    let mut out = std::fs::File::create(dest.join(&name)).map_err(|e| err(&e))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| err(&e))?;
  }
  Ok(())
}

/// After the download (`staging/download`): checks the hash, unpacks into
/// `staging/<id>/`, runs it, writes `version.txt`, then renames it over
/// `dest`. The caller always removes `staging`.
pub fn finish(tool: &Tool, staging: &Path, asset: &Asset, dest: &Path, cancel: &AtomicBool) -> Result<String, String> {
  let download = staging.join("download");
  if let Some(want) = &asset.sha256 {
    let got = engines::sha256_file(&download)?;
    if !got.eq_ignore_ascii_case(want) {
      return Err(format!("SHA-256 mismatch: expected {want}, got {got}"));
    }
  }
  let bin = staging.join(tool.id);
  if asset.url.to_ascii_lowercase().ends_with(".zip") {
    extract(tool, &download, &bin, cancel)?;
  } else {
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    std::fs::rename(&download, bin.join(format!("{}{}", tool.id, std::env::consts::EXE_SUFFIX))).map_err(|e| e.to_string())?;
  }
  let exe = crate::sidecar::find(tool.id, [Some(bin.clone())]).ok_or_else(|| format!("no {} in the download", tool.id))?;
  let version = probe(tool, &exe).ok_or_else(|| format!("the downloaded {} doesn't run", tool.name))?;
  std::fs::write(bin.join(VERSION_FILE), &version).map_err(|e| e.to_string())?;
  if cancel.load(Ordering::Relaxed) {
    return Err("cancelled".into());
  }
  match std::fs::remove_dir_all(dest) {
    // In use (a job is running it): Windows won't delete a running exe.
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{}: {e}", dest.display())),
    _ => {}
  }
  std::fs::rename(&bin, dest).map_err(|e| format!("{}: {e}", dest.display()))?;
  Ok(version)
}

/// Downloads the newest release into `engines/.<id>.partial/` and installs
/// it as the updated copy. Progress: download 0-95, then 100 (by the caller).
pub async fn install<R: Runtime>(app: &AppHandle<R>, tool: &'static Tool, cancel: std::sync::Arc<AtomicBool>, progress: &(dyn Fn(f64) + Sync)) -> Result<(), String> {
  let dest = own_dir(app, tool).ok_or("no app data folder")?;
  let staging = dest.with_file_name(format!(".{}.partial", tool.id));
  let result = async {
    let asset = newest(tool).await?;
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    let pkg = Package { url: asset.url.clone(), sha256: String::new(), size: Some(asset.size).filter(|&s| s > 0) };
    engines::download(&pkg, &staging.join("download"), &cancel, &|p| progress(p * 0.95)).await?;
    let (s, d, c) = (staging.clone(), dest.clone(), cancel.clone());
    tauri::async_runtime::spawn_blocking(move || finish(tool, &s, &asset, &d, &c)).await.map_err(|e| e.to_string())?.map(drop)
  }
  .await;
  let _ = std::fs::remove_dir_all(&staging);
  result
}

/// Back to the bundled copy.
pub fn remove<R: Runtime>(app: &AppHandle<R>, tool: &Tool) -> Result<(), String> {
  let dir = own_dir(app, tool).ok_or("no app data folder")?;
  match std::fs::remove_dir_all(&dir) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", dir.display())),
    _ => Ok(()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn tool(id: &str) -> &'static Tool {
    find(id).unwrap()
  }

  #[test]
  fn versions_from_each_tools_output() {
    assert_eq!(parse_version("ffmpeg", "ffmpeg version N-125628-ga5e6c0175a-20260715 Copyright (c) 2000-2026\nbuilt with"), Some("2026-07-15".into()));
    assert_eq!(parse_version("ffmpeg", "ffmpeg version 7.1.1 Copyright (c) 2000-2025"), Some("7.1.1".into()));
    assert_eq!(parse_version("yt-dlp", "2026.08.19\n"), Some("2026.08.19".into()));
    assert_eq!(parse_version("qpdf", "qpdf version 12.3.2\nRun qpdf --copyright"), Some("12.3.2".into()));
    assert_eq!(parse_version("img2pdf", "img2pdf.exe 0.5.1\n"), Some("0.5.1".into()));
    assert_eq!(parse_version("deno", "deno 2.9.8 (stable, release, x86_64-pc-windows-msvc)
v8 14.2
typescript 5.9"), Some("2.9.8".into()));
    assert_eq!(parse_version("oxipng", "oxipng 10.2.1
"), Some("10.2.1".into()));
    assert_eq!(parse_version("wordcraft-cli", "wordcraft-cli 0.16.0
"), Some("0.16.0".into()));
    assert_eq!(parse_version("qpdf", "something else"), None);
    assert_eq!(parse_version("yt-dlp", ""), None);
  }

  #[test]
  fn newer_compares_number_groups() {
    assert!(newer("2026.10.26", "2026.08.19"));
    assert!(newer("2026-11-06", "2026-07-15"));
    assert!(newer("12.4.2", "12.3.10"));
    assert!(!newer("12.3.10", "12.4.2"));
    assert!(newer("12.10.0", "12.9.9"));
    assert!(!newer("0.5.1", "0.5.1"));
    assert!(!newer("", "1.0"));
  }

  #[test]
  fn picks_the_windows_download_from_a_release() {
    let gh = |tag: &str, assets: Value| json!({ "tag_name": tag, "assets": assets });
    let a = |name: &str| json!({ "name": name, "browser_download_url": format!("https://x/{name}"), "size": 10, "digest": "sha256:ab12", "updated_at": "2026-11-06T13:11:06Z" });
    assert_eq!(
      pick_asset(tool("yt-dlp"), &gh("2026.10.26", json!([a("yt-dlp_macos.zip"), a("yt-dlp.exe")]))),
      Ok(Asset { version: "2026.10.26".into(), url: "https://x/yt-dlp.exe".into(), size: 10, sha256: Some("ab12".into()) })
    );
    let q = pick_asset(tool("qpdf"), &gh("v12.4.2", json!([a("qpdf-12.4.2-msvc64.zip"), a("qpdf-12.4.2-mingw64.zip")]))).unwrap();
    assert_eq!((q.version.as_str(), q.url.as_str()), ("12.4.2", "https://x/qpdf-12.4.2-mingw64.zip"));
    // ffmpeg's rebuilt-daily "latest": the asset's date is the version.
    let f = pick_asset(tool("ffmpeg"), &gh("latest", json!([a("ffmpeg-n9.0-latest-win64-gpl-9.0.zip"), a("ffmpeg-master-latest-win64-gpl.zip")]))).unwrap();
    assert_eq!((f.version.as_str(), f.url.as_str()), ("2026-11-06", "https://x/ffmpeg-master-latest-win64-gpl.zip"));
    // Gitea: no digest -> not verified by hash.
    let img = pick_asset(tool("img2pdf"), &json!({ "tag_name": "0.6.0", "assets": [{ "name": "img2pdf.exe", "browser_download_url": "https://g/img2pdf.exe", "size": 5 }] })).unwrap();
    assert_eq!(img.sha256, None);
    assert!(pick_asset(tool("yt-dlp"), &gh("1", json!([a("yt-dlp_linux.zip")]))).unwrap_err().contains("yt-dlp.exe is not in release 1"));
    // The optional tools (asset names as in their real releases).
    let d = pick_asset(tool("deno"), &gh("v2.9.8", json!([a("deno-aarch64-pc-windows-msvc.zip"), a("deno-x86_64-pc-windows-msvc.zip.sha256sum"), a("deno-x86_64-pc-windows-msvc.zip")]))).unwrap();
    assert_eq!((d.version.as_str(), d.url.as_str()), ("2.9.8", "https://x/deno-x86_64-pc-windows-msvc.zip"));
    let o = pick_asset(tool("oxipng"), &gh("v10.2.1", json!([a("oxipng-10.2.1-i686-pc-windows-msvc.zip"), a("oxipng-10.2.1-x86_64-pc-windows-msvc.zip")]))).unwrap();
    assert_eq!(o.url, "https://x/oxipng-10.2.1-x86_64-pc-windows-msvc.zip");
    let w = pick_asset(tool("wordcraft-cli"), &gh("v0.16.0", json!([a("wordcraft-0.16.0-windows-x64.msi"), a("wordcraft-0.16.0-windows-arm64-portable.zip"), a("wordcraft-0.16.0-windows-x64-portable.zip")]))).unwrap();
    assert_eq!((w.version.as_str(), w.url.as_str()), ("0.16.0", "https://x/wordcraft-0.16.0-windows-x64-portable.zip"));
  }

  #[test]
  fn takes_only_the_needed_files_from_a_zip() {
    let ff = tool("ffmpeg");
    assert_eq!(wanted(ff, "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe"), Some("ffmpeg.exe".into()));
    assert_eq!(wanted(ff, "ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe"), None);
    assert_eq!(wanted(ff, "ffmpeg-master-latest-win64-gpl/doc/ffmpeg.exe"), None);
    let q = tool("qpdf");
    assert_eq!(wanted(q, "qpdf-12.4.2-mingw64/bin/qpdf30.dll"), Some("qpdf30.dll".into()));
    assert_eq!(wanted(q, "qpdf-12.4.2-mingw64/bin/"), None);
    assert_eq!(wanted(q, "qpdf-12.4.2-mingw64/include/qpdf.h"), None);
    assert_eq!(wanted(q, "bin/qpdf.exe"), Some("qpdf.exe".into()));
    // The others: just <id>.exe, wherever it is.
    assert_eq!(wanted(tool("deno"), "deno.exe"), Some("deno.exe".into()));
    assert_eq!(wanted(tool("oxipng"), "oxipng-10.2.1-x86_64-pc-windows-msvc/oxipng.exe"), Some("oxipng.exe".into()));
    assert_eq!(wanted(tool("oxipng"), "oxipng-10.2.1-x86_64-pc-windows-msvc/README.md"), None);
    let wc = tool("wordcraft-cli");
    assert_eq!(wanted(wc, "wordcraft-0.16.0-windows-x64-portable/wordcraft-cli.exe"), Some("wordcraft-cli.exe".into()));
    assert_eq!(wanted(wc, "wordcraft-0.16.0-windows-x64-portable/wordcraft.exe"), None, "not the desktop app");
  }

  fn staging(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sorai-tools-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
  }

  #[test]
  fn extracts_the_wanted_files_flat() {
    use std::io::Write;
    let dir = staging("zip");
    let zip_path = dir.join("download");
    let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in [("qpdf-1-mingw64/bin/qpdf.exe", "exe"), ("qpdf-1-mingw64/bin/qpdf30.dll", "dll"), ("qpdf-1-mingw64/README.md", "x")] {
      w.start_file(name, opts).unwrap();
      w.write_all(body.as_bytes()).unwrap();
    }
    w.finish().unwrap();
    let out = dir.join("out");
    extract(tool("qpdf"), &zip_path, &out, &AtomicBool::new(false)).unwrap();
    let mut names: Vec<_> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["qpdf.exe", "qpdf30.dll"]);
    assert_eq!(std::fs::read_to_string(out.join("qpdf30.dll")).unwrap(), "dll");
    assert_eq!(extract(tool("qpdf"), &zip_path, &dir.join("c"), &AtomicBool::new(true)), Err("cancelled".into()));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_hash_mismatch_installs_nothing() {
    let dir = staging("hash");
    std::fs::write(dir.join("download"), b"not yt-dlp").unwrap();
    let dest = dir.join("yt-dlp-dest");
    let asset = Asset { version: "9".into(), url: "https://x/yt-dlp.exe".into(), size: 10, sha256: Some("00".into()) };
    let err = finish(tool("yt-dlp"), &dir, &asset, &dest, &AtomicBool::new(false)).unwrap_err();
    assert!(err.starts_with("SHA-256 mismatch"), "{err}");
    assert!(!dest.exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_download_that_does_not_run_installs_nothing() {
    let dir = staging("norun");
    std::fs::write(dir.join("download"), b"MZ but not really").unwrap();
    let dest = dir.join("yt-dlp-dest");
    let asset = Asset { version: "9".into(), url: "https://x/yt-dlp.exe".into(), size: 10, sha256: None };
    let err = finish(tool("yt-dlp"), &dir, &asset, &dest, &AtomicBool::new(false)).unwrap_err();
    assert!(err.contains("doesn't run"), "{err}");
    assert!(!dest.exists());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
