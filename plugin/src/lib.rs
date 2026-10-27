use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::Serialize;
use tauri::{
  plugin::{Builder, TauriPlugin},
  AppHandle, Manager, RunEvent, Runtime,
};
pub mod convert;
pub mod engines;
pub mod pdf_compress;
pub mod preview;
pub mod runner;
pub mod sidecar;

/// Plugin name: JS calls commands as `plugin:sorai-converter|<command>`,
/// the hub grants `sorai-converter:default`.
pub const NAME: &str = "sorai-converter";

/// Thumbnails are written to `<system temp>/<THUMBNAIL_SUBDIR>`. Host-app
/// contract: its asset-protocol scope must allow exactly this directory
/// (hub: `$TEMP/sorai-toolkit/thumbnails/*`), or `<img>` can't load them.
pub const THUMBNAIL_SUBDIR: &str = "sorai-toolkit/thumbnails";

/// URI scheme Trim/Crop load queued sources from (JS:
/// `convertFileSrc(path, PREVIEW_SCHEME)`). Serves exactly the files in
/// `PreviewFiles` -- unlike the asset protocol's scope, entries can be removed.
pub const PREVIEW_SCHEME: &str = "sorai-media";

/// The converter's current queue, kept in sync by `set_preview_files`.
#[derive(Default)]
struct PreviewFiles(Mutex<Vec<String>>);

/// Thumbnails older than this are deleted at plugin setup. Age-based, not
/// "everything": several instances (dev worktrees) share the temp dir, and a
/// running one may still show its thumbnails.
const THUMBNAIL_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Deletes files in `dir` last modified more than `max_age` ago. Best effort.
pub fn prune_old_files(dir: &Path, max_age: std::time::Duration) {
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  for e in entries.flatten() {
    let old = e.metadata().ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max_age);
    if old {
      let _ = std::fs::remove_file(e.path());
    }
  }
}

/// Liveness reply; the hub's E2E smoke test checks it end to end.
pub fn pong(value: &str) -> String {
  format!("{NAME} pong: {value}")
}

#[tauri::command]
fn ping(value: String) -> String {
  pong(&value)
}

/// What `ffmpeg -i <file>` tells us about a source. Zero / empty = unknown.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct MediaInfo {
  pub duration: f64,
  pub fps: f64,
  pub width: u32,
  pub height: u32,
  /// First video stream's codec (`h264`, `vp9`, `png`...). Empty for audio-only.
  pub codec: String,
}

static DURATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Duration:\s+(\d+):(\d+):(\d+\.\d+)").unwrap());
static FPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+(?:\.\d+)?)\s+fps").unwrap());
static DIMS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",\s+(\d+)x(\d+)(?:[,\s]|$)").unwrap());
static CODEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Video:\s+(\w+)").unwrap());

/// Parses ffmpeg's `-i` banner (stderr). Same patterns the old JS
/// getMediaInfo used.
pub fn parse_media_info(stderr: &str) -> MediaInfo {
  let mut info = MediaInfo::default();
  if let Some(c) = DURATION.captures(stderr) {
    let n = |i: usize| c[i].parse::<f64>().unwrap_or(0.0);
    info.duration = n(1) * 3600.0 + n(2) * 60.0 + n(3);
  }
  if let Some(c) = FPS.captures(stderr) {
    info.fps = c[1].parse().unwrap_or(0.0);
  }
  if let Some(c) = DIMS.captures(stderr) {
    info.width = c[1].parse().unwrap_or(0);
    info.height = c[2].parse().unwrap_or(0);
  }
  if let Some(c) = CODEC.captures(stderr) {
    info.codec = c[1].to_string();
  }
  info
}

/// ffmpeg args for a 160px-wide preview: video = middle frame, audio =
/// embedded cover art (none -> no output file), image = downscaled copy.
pub fn thumbnail_args(file: &str, out: &str, file_type: &str, duration: f64) -> Vec<String> {
  let scale = ["-vf", "scale=160:-1"];
  let mut args: Vec<&str> = vec!["-hide_banner", "-y"];
  let mid;
  match file_type {
    "video" => {
      mid = if duration > 0.0 { duration / 2.0 } else { 0.0 }.to_string();
      args.extend(["-ss", &mid, "-i", file, "-frames:v", "1"]);
      args.extend(scale);
    }
    "audio" => {
      args.extend(["-i", file, "-an"]);
      args.extend(scale);
      args.extend(["-frames:v", "1"]);
    }
    _ => {
      args.extend(["-i", file, "-frames:v", "1"]);
      args.extend(scale);
    }
  }
  args.push(out);
  args.into_iter().map(String::from).collect()
}

/// Everything the file list shows for one queued source.
#[derive(Serialize, Debug)]
pub struct SourceInfo {
  pub size: u64,
  #[serde(flatten)]
  pub media: MediaInfo,
  /// Absolute path of the generated thumbnail (JS turns it into an asset
  /// URL), or null when ffmpeg produced nothing (e.g. audio without cover).
  pub thumbnail: Option<String>,
}

/// Size of a regular file; directories and missing paths are errors, which
/// is how a dropped folder gets skipped instead of queued.
pub fn file_size(path: &Path) -> Result<u64, String> {
  let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
  if !meta.is_file() {
    return Err(format!("{}: not a file", path.display()));
  }
  Ok(meta.len())
}

static THUMB_SEQ: AtomicU64 = AtomicU64::new(0);

async fn ffmpeg<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) -> Result<String, String> {
  let out = sidecar::command(app, "ffmpeg")
    .args(args)
    .output()
    .await
    .map_err(|e| e.to_string())?;
  Ok(String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Size + (for video/audio/image) ffmpeg info and a thumbnail. `fileType`
/// is the converter's category: video | image | audio | pdf.
#[tauri::command]
async fn probe_source<R: Runtime>(app: AppHandle<R>, path: String, file_type: String) -> Result<SourceInfo, String> {
  let size = file_size(Path::new(&path))?;
  if !matches!(file_type.as_str(), "video" | "audio" | "image") {
    return Ok(SourceInfo { size, media: MediaInfo::default(), thumbnail: None });
  }
  let media = parse_media_info(&ffmpeg(&app, vec!["-hide_banner".into(), "-i".into(), path.clone()]).await?);

  let dir: PathBuf = app.path().temp_dir().map_err(|e| e.to_string())?.join(THUMBNAIL_SUBDIR);
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  // pid + seq: unique per call, and never reuses a name a previous run's
  // (possibly cached) asset URL pointed at.
  let seq = THUMB_SEQ.fetch_add(1, Ordering::Relaxed);
  let out = dir.join(format!("thumb-{}-{seq}.jpg", std::process::id()));
  let out_str = out.to_string_lossy().into_owned();
  ffmpeg(&app, thumbnail_args(&path, &out_str, &file_type, media.duration)).await?;
  let thumbnail = file_size(&out).is_ok_and(|n| n > 0).then_some(out_str);
  Ok(SourceInfo { size, media, thumbnail })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
  job_id: u64,
  out_path: String,
}

/// Where output goes: `out_dir` if absolute, else the source's folder. A
/// relative path would land in the process cwd, so it's never used.
pub fn resolve_out_dir(out_dir: &str, src: &Path) -> Result<PathBuf, String> {
  [Path::new(out_dir), src.parent().unwrap_or(Path::new(""))]
    .into_iter()
    .find(|p| p.is_absolute())
    .map(Path::to_path_buf)
    .ok_or_else(|| format!("no absolute output folder (got {out_dir:?}, source {})", src.display()))
}

/// Starts converting one file into `outDir` (never overwriting: picks a
/// free `<name>_converted...` name and reserves it as an empty file right
/// away, so concurrent jobs never share it; removed again if the job can't
/// start, and by the runner on error / cancel). Returns once the job runs;
/// log / progress / finished arrive on `on_event` (see runner.rs). Async
/// only so reading a PDF to compress stays off the main thread.
#[tauri::command]
async fn start_convert<R: Runtime>(
  app: AppHandle<R>,
  job: convert::Job,
  out_dir: String,
  on_event: tauri::ipc::Channel<runner::JobEvent>,
) -> Result<Started, String> {
  let src = Path::new(&job.source.path);
  let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
  let out = convert::unique_out_path(&resolve_out_dir(&out_dir, src)?, &stem, job.out_ext(), convert::taken);
  let out_path = out.to_string_lossy().into_owned();
  let started = start_job(&app, &job, out.clone(), on_event).await;
  if started.is_err() {
    let _ = std::fs::remove_file(&out);
  }
  Ok(Started { job_id: started?, out_path })
}

async fn start_job<R: Runtime>(app: &AppHandle<R>, job: &convert::Job, out: PathBuf, on_event: tauri::ipc::Channel<runner::JobEvent>) -> Result<u64, String> {
  let out_path = out.to_string_lossy().into_owned();
  let args = convert::build_args(job, &out_path)?;
  // PDF compress: built-in, except encrypted files stay on qpdf (keeps the
  // encryption; a missing open password gets qpdf's own error).
  let compress_level = match &job.kind {
    convert::Kind::Pdf(p) if p.optimize == "compress" => Some(p.level.clone()),
    _ => None,
  };
  if let Some(level) = compress_level {
    // Whole-file read: blocking, so not on the async runtime's threads.
    let path = PathBuf::from(&job.source.path);
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display())))
      .await
      .map_err(|e| e.to_string())??;
    if !pdf_compress::is_encrypted(&bytes) {
      let header = convert::display_command("builtin-pdf-compress", &[job.source.path.clone(), out_path]);
      // With Ghostscript (engines.rs) it runs too and the smaller result wins;
      // a file the built-in can't read goes to gs, else qpdf.
      let (gs, src, log) = (engines::ghostscript(app), job.source.path.clone(), on_event.clone());
      let qpdf = sidecar::bundled(app, "qpdf").unwrap_or_else(|| "qpdf".into());
      return Ok(runner::start_task(app, &header, src.clone().into(), out, on_event, move |cancel, progress| {
        let log = |line| _ = log.send(runner::JobEvent::Log { line });
        engines::compress_best(&bytes, &src, &level, gs, &qpdf, cancel, progress, &log)
      }));
    }
  }
  let (duration, speed) = (job.source.duration, job.speed());
  runner::start(app, convert::program(job), args, out, move |line| convert::parse_progress(line, duration, speed), on_event)
}

/// Optional engines for the hub's settings and the PDF status line.
#[tauri::command]
fn engine_status<R: Runtime>(app: AppHandle<R>) -> Result<Vec<engines::Status>, String> {
  engines::status(&app)
}

/// "Use my own program..." (`path`), or back to auto-detect (null / "").
#[tauri::command]
fn engine_set_path<R: Runtime>(app: AppHandle<R>, engine: String, path: Option<String>) -> Result<Vec<engines::Status>, String> {
  engines::set_path(&app, &engine, path.as_deref())
}

/// Downloads and installs the engine (Windows); progress 0-100 on
/// `on_progress`. Resolves the new status list once installed.
#[tauri::command]
async fn engine_install<R: Runtime>(app: AppHandle<R>, engine: String, on_progress: tauri::ipc::Channel<f64>) -> Result<Vec<engines::Status>, String> {
  engines::install(&app, &engine, |p| _ = on_progress.send(p)).await
}

/// Stops a running `engine_install` (it then rejects with "cancelled").
#[tauri::command]
fn engine_cancel() {
  engines::cancel_install()
}

/// Show the first-run engine prompt? (never shown yet, no Ghostscript)
#[tauri::command]
fn engine_prompt<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
  engines::prompt_due(&app)
}

/// Records that the prompt was shown (E2E resets it with false).
#[tauri::command]
fn engine_set_prompted<R: Runtime>(app: AppHandle<R>, prompted: bool) -> Result<(), String> {
  engines::mark_prompted(&app, prompted)
}

/// Deletes the app's own copy.
#[tauri::command]
fn engine_remove<R: Runtime>(app: AppHandle<R>, engine: String) -> Result<Vec<engines::Status>, String> {
  engines::remove(&app, &engine)
}

#[tauri::command]
fn cancel_job<R: Runtime>(app: AppHandle<R>, job_id: u64) {
  runner::cancel(&app, job_id)
}

/// Replaces the set of files the preview scheme may serve (the JS queue).
#[tauri::command]
fn set_preview_files(state: tauri::State<PreviewFiles>, paths: Vec<String>) {
  *state.0.lock().unwrap() = paths;
}

/// Output-size preview per queued file, same order as `jobs`.
#[tauri::command]
fn estimate_sizes(jobs: Vec<convert::Job>) -> Vec<convert::Estimate> {
  jobs.iter().map(convert::estimate).collect()
}

/// Registered by the hub: `.plugin(tauri_plugin_sorai_converter::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new(NAME)
    .invoke_handler(tauri::generate_handler![ping, probe_source, start_convert, cancel_job, estimate_sizes, set_preview_files, engine_status, engine_set_path, engine_install, engine_cancel, engine_remove, engine_prompt, engine_set_prompted])
    .register_asynchronous_uri_scheme_protocol(PREVIEW_SCHEME, |ctx, request, responder| {
      let allowed = ctx.app_handle().state::<PreviewFiles>().0.lock().unwrap().clone();
      std::thread::spawn(move || {
        let range = request.headers().get(tauri::http::header::RANGE).and_then(|v| v.to_str().ok());
        responder.respond(preview::respond(&allowed, request.uri().path(), range));
      });
    })
    // Every quit path (window close, tray Quit, app.exit, restart) ends here:
    // no ffmpeg outlives the app, no truncated output is left behind.
    .on_event(|app, event| {
      if let RunEvent::Exit = event {
        app.state::<runner::Jobs>().kill_all();
      }
    })
    .setup(|app, _| {
      app.manage(runner::Jobs::default());
      app.manage(PreviewFiles::default());
      if let Ok(tmp) = app.path().temp_dir() {
        std::thread::spawn(move || prune_old_files(&tmp.join(THUMBNAIL_SUBDIR), THUMBNAIL_MAX_AGE));
      }
      Ok(())
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn prune_deletes_only_files_older_than_max_age() {
    let dir = std::env::temp_dir().join(format!("sorai-prune-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    let (old, new) = (dir.join("old.jpg"), dir.join("new.jpg"));
    std::fs::write(&old, b"x").unwrap();
    std::fs::write(&new, b"x").unwrap();
    let two_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 24 * 60 * 60);
    std::fs::File::options().write(true).open(&old).unwrap().set_modified(two_days_ago).unwrap();
    prune_old_files(&dir, THUMBNAIL_MAX_AGE);
    let left = (old.exists(), new.exists(), dir.join("sub").exists());
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(left, (false, true, true));
    prune_old_files(&dir, THUMBNAIL_MAX_AGE); // missing dir: no panic
  }

  #[test]
  fn out_dir_must_be_absolute_else_source_folder() {
    let abs = std::env::temp_dir();
    let src = abs.join("a.mp4");
    assert_eq!(resolve_out_dir(abs.to_str().unwrap(), Path::new("rel/a.mp4")), Ok(abs.clone()));
    assert_eq!(resolve_out_dir("", &src), Ok(abs.clone()));
    assert_eq!(resolve_out_dir("out", &src), Ok(abs));
    assert!(resolve_out_dir("", Path::new("a.mp4")).is_err());
    assert!(resolve_out_dir("out", Path::new("rel/a.mp4")).is_err());
  }

  #[test]
  fn pong_echoes_value_with_plugin_name() {
    assert_eq!(pong("hi"), "sorai-converter pong: hi");
  }

  // Real `ffmpeg -hide_banner -i` output for the hub's tests/fixtures/*.
  const MP4: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test_fps.mp4':\n  Duration: 00:00:02.00, start: 0.000000, bitrate: 13 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 7 kb/s, 30 fps, 30 tbr, 15360 tbn (default)\nAt least one output file must be specified\n";
  const WEBM: &str = "  Duration: 01:02:03.50, start: 0.000000, bitrate: 7 kb/s\n  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 1920x1080, SAR 1:1 DAR 16:9, 29.97 fps, 25 tbr, 1k tbn (default)\n";
  const MP3: &str = "Input #0, mp3, from 'a.mp3':\n  Duration: 00:00:02.00, start: 0.025057, bitrate: 66 kb/s\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, mono, fltp, 64 kb/s, start 0.025057\n";
  const PNG: &str = "Input #0, png_pipe, from 'test_in.png':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: png, rgb24(pc, gbr/unknown/unknown), 320x240 [SAR 1:1 DAR 4:3], 25 fps, 25 tbr, 25 tbn\n";

  #[test]
  fn parses_video_resolution_fps_codec_duration() {
    let want = MediaInfo { duration: 2.0, fps: 30.0, width: 320, height: 240, codec: "h264".into() };
    assert_eq!(parse_media_info(MP4), want);
  }

  #[test]
  fn parses_fractional_fps_and_hours() {
    let i = parse_media_info(WEBM);
    assert_eq!((i.duration, i.fps, i.width, i.height, i.codec.as_str()), (3723.5, 29.97, 1920, 1080, "vp9"));
  }

  #[test]
  fn audio_only_has_duration_but_no_video_fields() {
    assert_eq!(parse_media_info(MP3), MediaInfo { duration: 2.0, ..Default::default() });
  }

  #[test]
  fn image_has_dimensions_and_no_duration() {
    let i = parse_media_info(PNG);
    assert_eq!((i.duration, i.width, i.height, i.codec.as_str()), (0.0, 320, 240, "png"));
  }

  #[test]
  fn garbage_parses_to_unknown() {
    assert_eq!(parse_media_info("C:\\x.mp4: Invalid data found"), MediaInfo::default());
  }

  #[test]
  fn video_thumbnail_seeks_to_middle_frame() {
    assert_eq!(
      thumbnail_args("C:\\a b\\影片.mp4", "C:\\t\\o.jpg", "video", 10.0),
      ["-hide_banner", "-y", "-ss", "5", "-i", "C:\\a b\\影片.mp4", "-frames:v", "1", "-vf", "scale=160:-1", "C:\\t\\o.jpg"]
    );
  }

  #[test]
  fn audio_thumbnail_takes_cover_art_without_audio() {
    assert_eq!(
      thumbnail_args("a.mp3", "o.jpg", "audio", 2.0),
      ["-hide_banner", "-y", "-i", "a.mp3", "-an", "-vf", "scale=160:-1", "-frames:v", "1", "o.jpg"]
    );
  }

  #[test]
  fn image_thumbnail_is_a_downscaled_frame() {
    assert_eq!(
      thumbnail_args("a.png", "o.jpg", "image", 0.0),
      ["-hide_banner", "-y", "-i", "a.png", "-frames:v", "1", "-vf", "scale=160:-1", "o.jpg"]
    );
  }

  #[test]
  fn file_size_rejects_directories_and_missing_paths() {
    let dir = std::env::temp_dir();
    assert!(file_size(&dir).unwrap_err().ends_with("not a file"));
    assert!(file_size(&dir.join("sorai-no-such-file.mp4")).is_err());
    let f = dir.join(format!("sorai-size-{}.bin", std::process::id()));
    std::fs::write(&f, [0u8; 7]).unwrap();
    assert_eq!(file_size(&f), Ok(7));
    std::fs::remove_file(f).unwrap();
  }
}
