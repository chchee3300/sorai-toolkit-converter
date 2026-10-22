//! Pure conversion logic: ffmpeg args, target-size bitrates, progress
//! parsing, size estimates, collision-free output names. Ported from the
//! hub's Neutralino-era resources/js/lib/{ffmpeg-commands,progress-parser,
//! size-estimate,filename-collision}.js + the converter's estimateDisplay.js.
//! Args are a Vec handed straight to the process (no shell string), so no
//! quoting anywhere -- Chinese / space paths just work.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// One queued file as the JS file list holds it (extra fields ignored).
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
  pub path: String,
  pub size: u64,
  pub duration: f64,
  pub fps: f64,
  pub width: u32,
  pub height: u32,
  pub trim_start: Option<f64>,
  pub trim_end: Option<f64>,
  pub crop: Option<Crop>,
}

/// Source-pixel crop rect (CropModal).
#[derive(Deserialize, Debug, Default, Clone, Copy)]
pub struct Crop {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
  pub format: String,
  pub codec: String,
  pub quality: f64,
  pub speed: f64,
  /// None = keep the source fps.
  pub fps: Option<f64>,
  #[serde(default)]
  pub target_size_mode: bool,
  #[serde(default, rename = "targetSizeMB")]
  pub target_size_mb: Option<f64>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImageSettings {
  pub format: String,
  pub quality: f64,
  pub scale: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct AudioSettings {
  pub format: String,
  /// e.g. "320k"
  pub bitrate: String,
  pub speed: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PdfSettings {
  /// compress | linearize
  pub optimize: String,
}

/// JS sends `{ fileType, settings: settings[fileType] }`.
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "fileType", content = "settings", rename_all = "lowercase")]
pub enum Kind {
  Video(VideoSettings),
  Image(ImageSettings),
  Audio(AudioSettings),
  Pdf(PdfSettings),
}

#[derive(Deserialize, Debug, Clone)]
pub struct Job {
  pub source: Source,
  #[serde(flatten)]
  pub kind: Kind,
}

impl Job {
  /// Output extension, dot included.
  pub fn out_ext(&self) -> &str {
    match &self.kind {
      Kind::Video(v) => &v.format,
      Kind::Image(i) => &i.format,
      Kind::Audio(a) => &a.format,
      Kind::Pdf(_) => ".pdf",
    }
  }

  /// Playback speed (progress scales the timeline by it).
  pub fn speed(&self) -> f64 {
    let s = match &self.kind {
      Kind::Video(v) => v.speed,
      Kind::Audio(a) => a.speed,
      _ => 1.0,
    };
    if s > 0.0 { s } else { 1.0 }
  }
}

fn trim_args(src: &Source, args: &mut Vec<String>) {
  if let Some(s) = src.trim_start {
    args.extend(["-ss".into(), s.to_string()]);
  }
  if let Some(e) = src.trim_end {
    args.extend(["-to".into(), e.to_string()]);
  }
}

/// Output timeline length in seconds: trimmed range, sped up / slowed down.
fn output_duration(src: &Source, speed: f64) -> f64 {
  let d = match (src.trim_start, src.trim_end) {
    (Some(s), Some(e)) if e > s => e - s,
    (s, Some(e)) => e - s.unwrap_or(0.0),
    (Some(s), None) => src.duration - s,
    _ => src.duration,
  };
  d / if speed > 0.0 { speed } else { 1.0 }
}

/// 8% headroom for container/mux + audio overshoot.
pub const TARGET_SIZE_SAFETY_MARGIN: f64 = 0.92;

/// VBV buffer length. libx264 may exceed -maxrate by up to one (initially
/// ~full) buffer, so the video budget reserves it. Measured on a noisy 2 s
/// 720p clip at a 5 MB target: the old 2 s buffer without a reserve came
/// out at 6.5 MB; this lands at 3.7 MB (8 s clip: 4.4 MB).
pub const VBV_BUFFER_SECS: f64 = 0.5;

/// "Quick compress to under N MB" over an output of `seconds`:
/// (video kbps = -b:v/-maxrate, -bufsize kbps, audio kbps), single pass,
/// lands UNDER the target. Decimal MB (stricter than MiB). Audio gets at
/// most half the budget, clamped to 32..=128 kbps.
pub fn target_size_bitrates(target_mb: f64, seconds: f64) -> (u64, u64, u64) {
  let total_kbps = target_mb * 1_000_000.0 * 8.0 * TARGET_SIZE_SAFETY_MARGIN / 1000.0 / seconds;
  let audio = (total_kbps * 0.5).floor().clamp(32.0, 128.0);
  let video = ((total_kbps - audio) * seconds / (seconds + VBV_BUFFER_SECS)).floor().max(100.0);
  (video as u64, (video * VBV_BUFFER_SECS).floor() as u64, audio as u64)
}

/// ffmpeg args (without the program) to convert `src` into `out`.
/// Err for PDF / image->PDF: qpdf / img2pdf jobs are ticket 08.
pub fn build_args(job: &Job, out: &str) -> Result<Vec<String>, String> {
  let src = &job.source;
  let mut a: Vec<String> = vec!["-y".into()];
  let s = |x: &str| x.to_string();
  match &job.kind {
    Kind::Video(v) => {
      trim_args(src, &mut a);
      a.extend([s("-i"), src.path.clone()]);
      if v.format == ".gif" {
        let mut chain = vec![];
        if let Some(fps) = v.fps.or((src.fps > 0.0).then_some(src.fps)) {
          chain.push(format!("fps={fps}"));
        }
        if v.speed != 1.0 {
          chain.push(format!("setpts={}*PTS", 1.0 / v.speed));
        }
        let scale = v.quality / 100.0;
        if scale < 1.0 {
          chain.push(format!("scale=trunc(iw*{scale}/2)*2:-2:flags=lanczos"));
        }
        let pre = if chain.is_empty() { String::new() } else { chain.join(",") + "," };
        a.extend([s("-filter_complex"), format!("{pre}split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse")]);
      } else {
        // Target-size mode forces libx264: VBV (-maxrate/-bufsize) only
        // reliably caps the size there.
        let target = v.target_size_mode.then_some(v.target_size_mb).flatten();
        let codec = if target.is_some() { "libx264" } else { v.codec.as_str() };
        a.extend([s("-c:v"), s(codec)]);
        let mut vf = vec![];
        let mut af = vec![];
        if let Some(fps) = v.fps {
          vf.push(format!("fps={fps}"));
        }
        if v.speed != 1.0 {
          vf.push(format!("setpts={}*PTS", 1.0 / v.speed));
          af.push(format!("atempo={}", v.speed));
        }
        if !vf.is_empty() {
          a.extend([s("-vf"), vf.join(",")]);
        }
        if !af.is_empty() {
          a.extend([s("-af"), af.join(",")]);
        }
        let out_secs = output_duration(src, v.speed);
        match target {
          Some(mb) if out_secs > 0.0 => {
            let (vk, buf, ak) = target_size_bitrates(mb, out_secs);
            a.extend([
              s("-b:v"), format!("{vk}k"), s("-maxrate"), format!("{vk}k"), s("-bufsize"), format!("{buf}k"),
              s("-c:a"), s("aac"), s("-b:a"), format!("{ak}k"),
            ]);
          }
          _ if src.duration > 0.0 => {
            let fps_factor = match v.fps {
              Some(t) if src.fps > 0.0 => t / src.fps,
              _ => 1.0,
            };
            let orig_kbps = src.size as f64 * 8.0 / (src.duration * 1024.0);
            let k = ((orig_kbps * (v.quality / 100.0) * fps_factor).floor() as i64).max(10);
            a.extend([s("-b:v"), format!("{k}k"), s("-bufsize"), format!("{}k", k * 2)]);
          }
          _ => {
            let crf = 51 - ((v.quality / 100.0) * 51.0).round() as i64;
            a.extend([s("-crf"), crf.to_string()]);
          }
        }
      }
    }
    Kind::Image(i) => {
      if i.format == ".pdf" {
        return Err("Image to PDF is not available in this build yet".into());
      }
      a.extend([s("-i"), src.path.clone()]);
      let crop = src
        .crop
        .filter(|c| c.width > 0.0 && c.height > 0.0)
        .map(|c| format!("crop={}:{}:{}:{}", c.width, c.height, c.x, c.y));
      let scale = (i.scale < 100.0).then(|| format!("scale=trunc(iw*{}/2)*2:-2:flags=lanczos", i.scale / 100.0));
      let crop_scale = [crop, scale].into_iter().flatten().collect::<Vec<_>>().join(",");
      if i.format == ".ico" {
        // ico muxer hard-caps at 256x256: always fit within it, after crop/scale.
        let pre = if crop_scale.is_empty() { String::new() } else { crop_scale + "," };
        a.extend([s("-vf"), format!("{pre}scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease")]);
      } else if i.format == ".png" && i.quality < 100.0 {
        let colors = ((256.0 * i.quality / 100.0).floor() as i64).max(2);
        let head = if crop_scale.is_empty() { "[0:v]".to_string() } else { format!("[0:v]{crop_scale}[s];[s]") };
        a.extend([s("-filter_complex"), format!("{head}split[a][b];[a]palettegen=max_colors={colors}[p];[b][p]paletteuse")]);
      } else if !crop_scale.is_empty() {
        a.extend([s("-vf"), crop_scale]);
      }
      match i.format.as_str() {
        ".jpg" | ".jpeg" => {
          let qv = (31 - ((i.quality / 100.0) * 29.0).round() as i64).clamp(2, 31);
          a.extend([s("-q:v"), qv.to_string()]);
        }
        ".webp" => a.extend([s("-q:v"), i.quality.to_string()]),
        _ => {}
      }
    }
    Kind::Audio(au) => {
      trim_args(src, &mut a);
      a.extend([s("-i"), src.path.clone()]);
      if au.speed != 1.0 {
        a.extend([s("-af"), format!("atempo={}", au.speed)]);
      }
      if au.format == ".ogg" {
        a.extend([s("-c:a"), s("libvorbis")]);
      }
      a.extend([s("-b:a"), au.bitrate.clone()]);
    }
    Kind::Pdf(_) => return Err("PDF jobs are not available in this build yet".into()),
  }
  a.push(out.into());
  Ok(a)
}

/// For the log line: args joined, quoting the ones with spaces.
pub fn display_command(program: &str, args: &[String]) -> String {
  std::iter::once(program)
    .chain(args.iter().map(String::as_str))
    .map(|x| if x.contains(' ') || x.is_empty() { format!("\"{x}\"") } else { x.to_string() })
    .collect::<Vec<_>>()
    .join(" ")
}

static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"time=(\d{2}):(\d{2}):(\d{2}\.\d{2})").unwrap());

/// 0..=100 from an ffmpeg stderr progress line, or None if it carries no
/// `time=` (or the source duration is unknown).
pub fn parse_progress(line: &str, duration: f64, speed: f64) -> Option<f64> {
  if duration <= 0.0 {
    return None;
  }
  let c = TIME.captures(line)?;
  let n = |i: usize| c[i].parse::<f64>().unwrap_or(0.0);
  let secs = n(1) * 3600.0 + n(2) * 60.0 + n(3);
  Some((secs / (duration / if speed > 0.0 { speed } else { 1.0 }) * 100.0).min(100.0))
}

/// `<dir>/<stem>_converted<ext>`, adding `_converted` until `exists` says
/// the name is free. Never overwrites.
pub fn unique_out_path(dir: &Path, stem: &str, ext: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
  let mut base = format!("{stem}_converted");
  loop {
    let p = dir.join(format!("{base}{ext}"));
    if !exists(&p) {
      return p;
    }
    base.push_str("_converted");
  }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
  #[serde(rename = "estMB")]
  pub est_mb: f64,
  /// Output likely bigger than the source.
  pub warn: bool,
  pub target_fps_label: Option<String>,
}

const MIB: f64 = 1024.0 * 1024.0;

/// Output size preview for the file list (same heuristics as before).
pub fn estimate(job: &Job) -> Estimate {
  let src = &job.source;
  let current = src.size as f64 / MIB;
  let ratio = match (src.trim_start, src.trim_end) {
    (Some(s), Some(e)) if src.duration > 0.0 => (e - s) / src.duration,
    _ => 1.0,
  };
  let lower = src.path.to_lowercase();
  let mut target_fps_label = None;
  let est = match &job.kind {
    Kind::Video(v) => {
      target_fps_label = v.fps.map(|f| f.to_string());
      match v.target_size_mb {
        // Lands under the cap, so show a hair under it.
        Some(mb) if v.target_size_mode => mb * 0.95,
        _ => {
          let target_fps = v.fps.unwrap_or(src.fps);
          let fps_factor = if target_fps > 0.0 && src.fps > 0.0 { target_fps / src.fps } else { 1.0 };
          let q = v.quality / 100.0;
          let e = if v.format == ".gif" {
            current * ratio * q * q * fps_factor * 2.5 / v.speed
          } else {
            let codec = match v.codec.as_str() {
              "libx265" => 0.6,
              "libvpx-vp9" => 0.65,
              "libsvtav1" => 0.5,
              _ => 1.0,
            };
            current * ratio * q * fps_factor / v.speed * codec
          };
          e.max(0.1)
        }
      }
    }
    Kind::Audio(a) => {
      let kbps = match a.format.as_str() {
        ".flac" => 900.0,
        ".wav" => 1411.0,
        _ => a.bitrate.trim_end_matches('k').parse().unwrap_or(0.0),
      };
      let same_lossless = (a.format == ".flac" && lower.ends_with(".flac")) || (a.format == ".wav" && lower.ends_with(".wav"));
      if src.duration > 0.0 && !same_lossless {
        kbps * 1000.0 * src.duration * ratio / 8.0 / MIB / a.speed
      } else {
        current * ratio / a.speed
      }
    }
    Kind::Image(i) => {
      if i.format == ".pdf" {
        current + 0.05
      } else {
        let base = if i.format == ".png" {
          if lower.ends_with(".png") { current } else { current * 2.5 }
        } else if lower.ends_with(".png") {
          current * 0.4
        } else {
          current
        };
        let area = match src.crop {
          Some(c) if src.width > 0 && src.height > 0 => c.width * c.height / (src.width as f64 * src.height as f64),
          _ => 1.0,
        };
        base * (i.quality / 100.0) * (i.scale / 100.0).powi(2) * area
      }
    }
    Kind::Pdf(p) => current * if p.optimize == "compress" { 0.7 } else { 1.02 },
  };
  Estimate { est_mb: est, warn: est > current, target_fps_label }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn src(path: &str) -> Source {
    // tests/fixtures/test_fixture_video.mp4-ish: 1 MiB, 10 s, 30 fps
    Source { path: path.into(), size: 1024 * 1024, duration: 10.0, fps: 30.0, width: 320, height: 240, ..Default::default() }
  }
  fn video(f: impl FnOnce(&mut VideoSettings)) -> Kind {
    let mut v = VideoSettings { format: ".mp4".into(), codec: "libx264".into(), quality: 100.0, speed: 1.0, fps: None, target_size_mode: false, target_size_mb: None };
    f(&mut v);
    Kind::Video(v)
  }
  fn image(format: &str, quality: f64, scale: f64) -> Kind {
    Kind::Image(ImageSettings { format: format.into(), quality, scale })
  }
  fn audio(format: &str, bitrate: &str, speed: f64) -> Kind {
    Kind::Audio(AudioSettings { format: format.into(), bitrate: bitrate.into(), speed })
  }
  fn args(source: Source, kind: Kind) -> Vec<String> {
    build_args(&Job { source, kind }, "o.x").unwrap()
  }
  fn joined(source: Source, kind: Kind) -> String {
    args(source, kind).join(" ")
  }

  #[test]
  fn job_deserializes_from_the_js_shape() {
    let j: Job = serde_json::from_str(
      r#"{"source":{"path":"C:\\a.mp4","size":5,"duration":2,"fps":30,"width":1,"height":1,"videoCodec":"h264","crop":null},
          "fileType":"video","settings":{"format":".mp4","codec":"libx265","quality":50,"upscale":false,"fps":null,"fpsUpscale":false,"speed":1,"targetSizeMode":true,"targetSizeMB":5}}"#,
    )
    .unwrap();
    assert_eq!(j.out_ext(), ".mp4");
    let Kind::Video(v) = j.kind else { panic!() };
    assert_eq!((v.target_size_mb, v.fps), (Some(5.0), None));
  }

  #[test]
  fn video_default_uses_codec_and_relative_bitrate() {
    // 1 MiB over 10 s = 819.2 kbps original
    assert_eq!(args(src("in.mp4"), video(|_| {})), ["-y", "-i", "in.mp4", "-c:v", "libx264", "-b:v", "819k", "-bufsize", "1638k", "o.x"]);
  }

  #[test]
  fn video_quality_fps_and_speed() {
    let a = joined(src("in.mp4"), video(|v| { v.quality = 50.0; v.speed = 1.5; v.fps = Some(15.0); v.codec = "libx265".into(); }));
    assert_eq!(a, "-y -i in.mp4 -c:v libx265 -vf fps=15,setpts=0.6666666666666666*PTS -af atempo=1.5 -b:v 204k -bufsize 408k o.x");
  }

  #[test]
  fn video_unknown_duration_falls_back_to_crf() {
    let s = Source { duration: 0.0, ..src("in.mp4") };
    assert!(joined(s, video(|v| v.quality = 50.0)).ends_with("-c:v libx264 -crf 25 o.x"));
  }

  #[test]
  fn video_trim_goes_before_input() {
    let s = Source { trim_start: Some(1.5), trim_end: Some(4.0), ..src("in.mp4") };
    assert!(joined(s, video(|_| {})).starts_with("-y -ss 1.5 -to 4 -i in.mp4"));
  }

  #[test]
  fn gif_uses_palette_and_no_codec() {
    let a = joined(src("in.mp4"), video(|v| { v.format = ".gif".into(); v.quality = 50.0; }));
    assert_eq!(a, "-y -i in.mp4 -filter_complex fps=30,scale=trunc(iw*0.5/2)*2:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse o.x");
  }

  #[test]
  fn target_size_bitrates_stay_under_budget() {
    // 5 MB over 10 s: 3680 kbps total -> audio capped at 128, video keeps a 0.5 s VBV reserve
    assert_eq!(target_size_bitrates(5.0, 10.0), (3382, 1691, 128));
    // 5 MB over an hour: tiny budget -> audio floor 32, video floor 100
    assert_eq!(target_size_bitrates(5.0, 3600.0), (100, 50, 32));
    for (mb, secs) in [(5.0, 2.0), (5.0, 8.0), (25.0, 60.0), (50.0, 600.0)] {
      let (v, buf, a) = target_size_bitrates(mb, secs);
      // worst case: video overshoots -maxrate by one full buffer
      let worst_bytes = ((v as f64) * secs + buf as f64 + a as f64 * secs) * 1000.0 / 8.0;
      assert!(worst_bytes < mb * 1e6 * TARGET_SIZE_SAFETY_MARGIN, "{mb} MB / {secs} s");
    }
  }

  #[test]
  fn target_size_mode_forces_libx264_and_vbv() {
    let a = joined(src("in.mp4"), video(|v| { v.codec = "libsvtav1".into(); v.target_size_mode = true; v.target_size_mb = Some(5.0); }));
    assert_eq!(a, "-y -i in.mp4 -c:v libx264 -b:v 3382k -maxrate 3382k -bufsize 1691k -c:a aac -b:a 128k o.x");
  }

  #[test]
  fn target_size_budgets_for_slow_motion_output_length() {
    // 0.5x speed doubles the output to 20 s -> 1840 kbps total.
    let a = joined(src("in.mp4"), video(|v| { v.speed = 0.5; v.target_size_mode = true; v.target_size_mb = Some(5.0); }));
    assert!(a.contains("-b:v 1670k -maxrate 1670k -bufsize 835k -c:a aac -b:a 128k"), "{a}");
  }

  #[test]
  fn target_size_off_ignores_stale_mb() {
    let a = joined(src("in.mp4"), video(|v| { v.codec = "libx265".into(); v.target_size_mb = Some(5.0); }));
    assert!(a.contains("-c:v libx265") && !a.contains("-maxrate"), "{a}");
  }

  #[test]
  fn image_jpg_quality_and_webp() {
    assert_eq!(joined(src("a.png"), image(".jpg", 85.0, 100.0)), "-y -i a.png -q:v 6 o.x");
    assert_eq!(joined(src("a.png"), image(".webp", 60.0, 50.0)), "-y -i a.png -vf scale=trunc(iw*0.5/2)*2:-2:flags=lanczos -q:v 60 o.x");
  }

  #[test]
  fn png_below_100_uses_palettegen() {
    assert_eq!(joined(src("a.jpg"), image(".png", 40.0, 100.0)), "-y -i a.jpg -filter_complex [0:v]split[a][b];[a]palettegen=max_colors=102[p];[b][p]paletteuse o.x");
    assert_eq!(joined(src("a.jpg"), image(".png", 100.0, 100.0)), "-y -i a.jpg o.x");
  }

  #[test]
  fn crop_precedes_scale_everywhere() {
    let s = || Source { crop: Some(Crop { x: 10.0, y: 20.0, width: 300.0, height: 200.0 }), ..src("a.png") };
    assert_eq!(joined(s(), image(".jpg", 85.0, 100.0)), "-y -i a.png -vf crop=300:200:10:20 -q:v 6 o.x");
    assert!(joined(s(), image(".jpg", 85.0, 50.0)).contains("-vf crop=300:200:10:20,scale=trunc(iw*0.5/2)*2"));
    assert!(joined(s(), image(".png", 40.0, 50.0)).contains("[0:v]crop=300:200:10:20,scale=trunc(iw*0.5/2)*2:-2:flags=lanczos[s];[s]split[a][b];"));
    let ico = joined(s(), image(".ico", 40.0, 100.0));
    assert!(ico.contains("-vf crop=300:200:10:20,scale='min(256,iw)'") && !ico.contains("palettegen"), "{ico}");
    assert!(joined(s(), image(".png", 40.0, 100.0)).contains("-filter_complex [0:v]crop=300:200:10:20[s];[s]split[a][b];"));
    assert!(joined(s(), image(".ico", 100.0, 50.0))
      .starts_with("-y -i a.png -vf crop=300:200:10:20,scale=trunc(iw*0.5/2)*2:-2:flags=lanczos,scale='min(256,iw)'"));
    let zero = Source { crop: Some(Crop { width: 0.0, ..Default::default() }), ..src("a.png") };
    assert!(!joined(zero, image(".jpg", 85.0, 100.0)).contains("crop="));
  }

  #[test]
  fn ico_always_fits_256() {
    assert_eq!(joined(src("a.png"), image(".ico", 40.0, 100.0)), "-y -i a.png -vf scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease o.x");
  }

  #[test]
  fn audio_bitrate_speed_and_ogg_encoder() {
    assert_eq!(joined(src("a.mp3"), audio(".aac", "128k", 2.0)), "-y -i a.mp3 -af atempo=2 -b:a 128k o.x");
    assert_eq!(joined(src("a.mp3"), audio(".ogg", "192k", 1.0)), "-y -i a.mp3 -c:a libvorbis -b:a 192k o.x");
  }

  #[test]
  fn pdf_jobs_are_not_ported_yet() {
    assert!(build_args(&Job { source: src("a.pdf"), kind: Kind::Pdf(PdfSettings { optimize: "compress".into() }) }, "o").is_err());
    assert!(build_args(&Job { source: src("a.png"), kind: image(".pdf", 100.0, 100.0) }, "o").is_err());
  }

  #[test]
  fn display_command_quotes_spaced_args() {
    assert_eq!(display_command("ffmpeg", &["-i".into(), "C:\\a b\\影片.mp4".into()]), "ffmpeg -i \"C:\\a b\\影片.mp4\"");
  }

  #[test]
  fn progress_from_time_field() {
    let line = "frame=   30 fps=0.0 q=28.0 size=       0kB time=00:00:05.00 bitrate=   0.0kbits/s speed=10x";
    assert_eq!(parse_progress(line, 10.0, 1.0), Some(50.0));
    assert_eq!(parse_progress(line, 10.0, 2.0), Some(100.0)); // capped
    assert_eq!(parse_progress("time=01:00:00.00", 7200.0, 1.0), Some(50.0));
    assert_eq!(parse_progress(line, 0.0, 1.0), None);
    assert_eq!(parse_progress("Stream mapping:", 10.0, 1.0), None);
  }

  #[test]
  fn unique_out_path_appends_converted_until_free() {
    let taken = [PathBuf::from("d").join("a_converted.mp4"), PathBuf::from("d").join("a_converted_converted.mp4")];
    let p = unique_out_path(Path::new("d"), "a", ".mp4", |p| taken.iter().any(|t| t == p));
    assert_eq!(p, PathBuf::from("d").join("a_converted_converted_converted.mp4"));
    assert_eq!(unique_out_path(Path::new("d"), "影片 一", ".gif", |_| false), PathBuf::from("d").join("影片 一_converted.gif"));
  }

  fn est(source: Source, kind: Kind) -> Estimate {
    estimate(&Job { source, kind })
  }

  #[test]
  fn video_estimates() {
    assert_eq!(est(src("a.mp4"), video(|v| v.quality = 50.0)).est_mb, 0.5);
    let e = est(src("a.mp4"), video(|v| { v.codec = "libx265".into(); v.fps = Some(15.0); }));
    assert!((e.est_mb - 0.3).abs() < 1e-9 && e.target_fps_label.as_deref() == Some("15"));
    assert_eq!(est(src("a.mp4"), video(|v| { v.target_size_mode = true; v.target_size_mb = Some(25.0); })).est_mb, 23.75);
    assert_eq!(est(src("a.mp4"), video(|v| v.quality = 1.0)).est_mb, 0.1); // floor
    let up = est(src("a.mp4"), video(|v| v.quality = 200.0));
    assert!(up.warn);
    let trimmed = Source { trim_start: Some(0.0), trim_end: Some(5.0), ..src("a.mp4") };
    assert_eq!(est(trimmed, video(|_| {})).est_mb, 0.5);
  }

  #[test]
  fn audio_estimates() {
    // 128 kbps * 10 s
    assert!((est(src("a.mp3"), audio(".aac", "128k", 1.0)).est_mb - 128_000.0 * 10.0 / 8.0 / MIB).abs() < 1e-9);
    // same lossless format keeps the source size
    assert_eq!(est(src("a.flac"), audio(".flac", "320k", 2.0)).est_mb, 0.5);
  }

  #[test]
  fn image_and_pdf_estimates() {
    assert_eq!(est(src("a.png"), image(".jpg", 100.0, 100.0)).est_mb, 0.4);
    assert_eq!(est(src("a.jpg"), image(".png", 100.0, 50.0)).est_mb, 2.5 * 0.25);
    let half = Source { crop: Some(Crop { x: 0.0, y: 0.0, width: 160.0, height: 240.0 }), ..src("a.jpg") };
    assert_eq!(est(half, image(".jpg", 100.0, 100.0)).est_mb, 0.5);
    assert!((est(src("a.png"), image(".pdf", 1.0, 1.0)).est_mb - 1.05).abs() < 1e-9);
    assert!((est(src("a.pdf"), Kind::Pdf(PdfSettings { optimize: "compress".into() })).est_mb - 0.7).abs() < 1e-9);
  }
}
