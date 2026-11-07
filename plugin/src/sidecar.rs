//! Where the host's bundled sidecars live. The downloader plugin has its own
//! copy of this file on purpose (each plugin owns its runner); keep them alike.
//!
//! Order: an update from Settings (`<app local data>/engines/<name>/`,
//! written by the converter's tools.rs), the app's resource dir, then next
//! to the app exe, then PATH.
//! - Linux deb/rpm: the hub ships ffmpeg / yt-dlp as resources in
//!   `/usr/lib/<app>/` so `/usr/bin/ffmpeg` stays the distro's. The exe sits in
//!   `/usr/bin`, which is why the resource dir is checked first.
//! - Windows and dev builds: resource dir == exe dir.
//! - macOS: externalBin lands next to the exe (`Contents/MacOS`).
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::{process::Command, ShellExt};

/// First `<dir>/<name>[.exe]` that is a file, in `dirs` order.
pub fn find(name: &str, dirs: impl IntoIterator<Item = Option<PathBuf>>) -> Option<PathBuf> {
  let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
  dirs.into_iter().flatten().map(|d| d.join(&file)).find(|p| p.is_file())
}

/// The host's bundled `name` (or its update), or None when it ships none (use PATH).
pub fn bundled<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
  let updated = app.path().app_local_data_dir().ok().map(|d| d.join("engines").join(name));
  find(name, [updated, app.path().resource_dir().ok(), exe_dir])
}

/// Command for `name`: the bundled copy, else `name` from PATH.
/// PYTHONIOENCODING: img2pdf (Python) writes paths in errors as UTF-8
/// instead of the console codepage (cp950 on zh-TW Windows); others ignore it.
pub fn command<R: Runtime>(app: &AppHandle<R>, name: &str) -> Command {
  app.shell().command(bundled(app, name).unwrap_or_else(|| name.into())).env("PYTHONIOENCODING", "utf-8")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn dir_with(tag: &str, names: &[&str]) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sorai-sidecar-test-cv-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    for n in names {
      std::fs::write(d.join(format!("{n}{}", std::env::consts::EXE_SUFFIX)), b"").unwrap();
    }
    d
  }

  #[test]
  fn resource_dir_wins_over_exe_dir() {
    // Linux deb: /usr/lib/<app>/ffmpeg (ours) beats /usr/bin/ffmpeg (distro's).
    let res = dir_with("res", &["ffmpeg"]);
    let exe = dir_with("exe", &["ffmpeg", "yt-dlp"]);
    let ff = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    assert_eq!(find("ffmpeg", [Some(res.clone()), Some(exe.clone())]), Some(res.join(&ff)));
    // Not in the resource dir (macOS: externalBin is next to the exe).
    let yt = format!("yt-dlp{}", std::env::consts::EXE_SUFFIX);
    assert_eq!(find("yt-dlp", [Some(res), Some(exe.clone())]), Some(exe.join(yt)));
  }

  #[test]
  fn none_when_not_bundled_or_dir_unknown() {
    let empty = dir_with("empty", &[]);
    assert_eq!(find("ffmpeg", [None, Some(empty.clone())]), None);
    // A directory with the sidecar's name is not a sidecar.
    std::fs::create_dir_all(empty.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX))).unwrap();
    assert_eq!(find("ffmpeg", [Some(empty)]), None);
  }
}
