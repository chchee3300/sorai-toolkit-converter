//! Pure conversion logic: ffmpeg args, target-size bitrates, progress
//! parsing, size estimates, collision-free output names. Ported from the
//! hub's old JS resources/js/lib/{ffmpeg-commands,progress-parser,
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
  /// Codec names as `ffmpeg -i` prints them (`h264`, `aac`); empty = none / unknown.
  pub video_codec: String,
  pub audio_codec: String,
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
  /// M4A only: Apple Lossless instead of AAC (bitrate unused).
  #[serde(default)]
  pub alac: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PdfSettings {
  /// The operation: compress | linearize | extract | split | rotate | encrypt
  /// (the old key name, so older settings and presets still read).
  pub optimize: String,
  /// screen | ebook | printer (compress only). Older settings and presets have
  /// none and read as the default.
  #[serde(default = "default_pdf_level")]
  pub level: String,
  /// qpdf page range ("1-3,5", "z" = last): extract (required), rotate (empty = all).
  #[serde(default)]
  pub pages: String,
  /// rotate: 90 | 180 | 270, clockwise.
  #[serde(default = "default_angle")]
  pub angle: i32,
  /// encrypt: opens the PDF (user and owner password alike), AES-256.
  #[serde(default)]
  pub password: String,
}

fn default_pdf_level() -> String {
  "ebook".into()
}

fn default_angle() -> i32 {
  90
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

/// Several queued files into one output, in this order ("Merge into one file").
#[derive(Deserialize, Debug, Clone)]
pub struct MergeJob {
  pub sources: Vec<Source>,
  #[serde(flatten)]
  pub kind: Kind,
}

impl Kind {
  /// Output extension, dot included ("" for a folder).
  pub fn out_ext(&self) -> &str {
    match self {
      Kind::Video(v) => &v.format,
      Kind::Image(i) => &i.format,
      Kind::Audio(a) => &a.format,
      Kind::Pdf(p) if p.optimize == "split" => "",
      Kind::Pdf(_) => ".pdf",
    }
  }
}

impl MergeJob {
  /// Output extension: always one file (a PDF merge ignores the operation, split included).
  pub fn out_ext(&self) -> &str {
    if matches!(self.kind, Kind::Pdf(_)) { ".pdf" } else { self.kind.out_ext() }
  }
}

impl Job {
  /// Output extension, dot included ("" for a folder, see `out_is_dir`).
  pub fn out_ext(&self) -> &str {
    self.kind.out_ext()
  }

  /// PDF split writes one PDF per page into a new folder.
  pub fn out_is_dir(&self) -> bool {
    matches!(&self.kind, Kind::Pdf(p) if p.optimize == "split")
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

fn target_mb(v: &VideoSettings) -> Option<f64> {
  v.target_size_mode.then_some(v.target_size_mb).flatten()
}

/// Video formats that take only some encoders; any other pick gets the first.
/// The WebM muxer takes only VP8/VP9/AV1 (H.264/H.265, the default codec and
/// target-size mode's, would fail at the header); MOV/M4V/TS get H.264/H.265;
/// WMV and MPG have their own. SettingsPanel.jsx's CONTAINER_CODECS mirrors it.
fn container_codecs(format: &str) -> Option<&'static [&'static str]> {
  match format {
    ".webm" => Some(&["libvpx-vp9", "libsvtav1"]),
    ".mov" | ".m4v" | ".ts" => Some(&["libx264", "libx265"]),
    ".wmv" => Some(&["wmv2"]),
    ".mpg" => Some(&["mpeg2video"]),
    _ => None,
  }
}

/// The codec actually used (SettingsPanel.jsx's effectiveCodec mirrors it for
/// the UI). Target-size mode forces libx264: VBV (-maxrate/-bufsize) only
/// reliably caps the size there. "copy" keeps the source's streams where the
/// container takes them (`video_encoder`).
pub fn effective_codec(v: &VideoSettings) -> &str {
  let codec = if target_mb(v).is_some() { "libx264" } else { v.codec.as_str() };
  match container_codecs(&v.format) {
    Some(ok) if codec != "copy" && !ok.contains(&codec) => ok[0],
    _ => codec,
  }
}

/// Can video `format` hold this video stream (codec as `ffmpeg -i` names it) as is?
pub fn holds_video(format: &str, codec: &str) -> bool {
  match format {
    ".mkv" => !codec.is_empty(),
    ".mp4" => matches!(codec, "h264" | "hevc" | "av1" | "vp9" | "mpeg4"),
    ".mov" | ".m4v" => matches!(codec, "h264" | "hevc" | "mpeg4" | "prores"),
    ".webm" => matches!(codec, "vp8" | "vp9" | "av1"),
    ".avi" => matches!(codec, "h264" | "mpeg4" | "mjpeg" | "msmpeg4v3"),
    ".ts" => matches!(codec, "h264" | "hevc" | "mpeg2video"),
    ".wmv" => matches!(codec, "wmv1" | "wmv2" | "wmv3" | "vc1"),
    ".mpg" => matches!(codec, "mpeg1video" | "mpeg2video"),
    _ => false,
  }
}

/// Can video `format` hold this audio stream as is? (No audio: yes.)
pub fn holds_audio(format: &str, codec: &str) -> bool {
  codec.is_empty()
    || match format {
      ".mkv" => true,
      ".mp4" | ".m4v" | ".mov" => matches!(codec, "aac" | "alac" | "ac3" | "eac3" | "mp3"),
      ".webm" => matches!(codec, "opus" | "vorbis"),
      ".avi" => matches!(codec, "mp3" | "ac3" | "aac" | "pcm_s16le"),
      ".ts" => matches!(codec, "aac" | "ac3" | "mp3" | "mp2"),
      ".wmv" => matches!(codec, "wmav1" | "wmav2"),
      ".mpg" => matches!(codec, "mp2" | "mp3" | "ac3"),
      _ => false,
    }
}

/// Encoder for a video's sound when it's re-encoded explicitly.
fn audio_encoder(format: &str) -> &'static str {
  match format {
    ".webm" => "libopus",
    ".wmv" => "wmav2",
    ".mpg" => "mp2",
    _ => "aac",
  }
}

/// Video encoder for a source whose video is `codec`: "copy" the container
/// can't hold falls back to the container's default encoder.
fn video_encoder<'a>(v: &'a VideoSettings, codec: &str) -> &'a str {
  match effective_codec(v) {
    "copy" if !holds_video(&v.format, codec) => container_codecs(&v.format).map_or("libx264", |c| c[0]),
    c => c,
  }
}

/// Video-tab outputs that aren't a video container: animations, one still
/// frame, the sound only. They can't be merged.
pub fn is_special_video_out(format: &str) -> bool {
  matches!(format, ".gif" | ".apng" | ".png" | ".m4a" | ".mp3")
}

/// -c:v/-b:v... for an encoded video: target size over `out_secs`, else
/// `quality` % of the source's kbps (scaled by the fps change), else CRF.
fn rate_args(v: &VideoSettings, out_secs: f64, src_kbps: Option<f64>, src_fps: f64, a: &mut Vec<String>) {
  match target_mb(v) {
    Some(mb) if out_secs > 0.0 => {
      let (vk, buf, ak) = target_size_bitrates(mb, out_secs);
      a.extend(
        [
          "-b:v".into(), format!("{vk}k"), "-maxrate".into(), format!("{vk}k"), "-bufsize".into(), format!("{buf}k"),
          "-c:a".into(), audio_encoder(&v.format).into(), "-b:a".into(), format!("{ak}k"),
        ],
      );
    }
    _ => match src_kbps {
      Some(orig_kbps) => {
        let fps_factor = match v.fps {
          Some(t) if src_fps > 0.0 => t / src_fps,
          _ => 1.0,
        };
        let k = ((orig_kbps * (v.quality / 100.0) * fps_factor).floor() as i64).max(10);
        a.extend(["-b:v".into(), format!("{k}k")]);
        // lavc's own wmv2/mpeg2video refuse -bufsize without -maxrate.
        if !matches!(effective_codec(v), "wmv2" | "mpeg2video") {
          a.extend(["-bufsize".into(), format!("{}k", k * 2)]);
        }
      }
      None => {
        let crf = 51 - ((v.quality / 100.0) * 51.0).round() as i64;
        a.extend(["-crf".into(), crf.to_string()]);
      }
    },
  }
}

/// GIF / APNG frame chain: fps (picked, else the source's), speed, scale by quality.
fn anim_chain(v: &VideoSettings, src: &Source) -> Vec<String> {
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
  chain
}

/// Encoder args for an audio target. `cover`: copy the source's cover art
/// (M4A); every format new in 2.2 drops it (`-vn`).
fn audio_codec_args(au: &AudioSettings, cover: bool) -> Vec<String> {
  let s = |x: &str| x.to_string();
  let b = au.bitrate.clone();
  match au.format.as_str() {
    // libvorbis ABR (-b:a) rejects bitrates above its per-channel/rate
    // ceiling ("encoder setup failed": 320k on a mono 44.1k source);
    // VBR quality works for any layout, so map the kbps onto -q:a.
    ".ogg" => vec![s("-c:a"), s("libvorbis"), s("-q:a"), vorbis_quality(&b).to_string()],
    ".m4a" => {
      // The ipod muxer refuses the h264 ffmpeg would re-encode cover art
      // to; copy it as an attached picture instead.
      let mut a = if cover { vec![s("-c:v"), s("copy"), s("-disposition:v"), s("attached_pic")] } else { vec![s("-vn")] };
      a.extend(if au.alac { vec![s("-c:a"), s("alac")] } else { vec![s("-c:a"), s("aac"), s("-b:a"), b] });
      a
    }
    // libopus refuses more than 256k per channel (320k on a mono source fails).
    ".opus" => vec![s("-vn"), s("-c:a"), s("libopus"), s("-b:a"), format!("{}k", kbps(&b).min(256.0))],
    ".wma" => vec![s("-vn"), s("-c:a"), s("wmav2"), s("-b:a"), b],
    ".ac3" => vec![s("-vn"), s("-c:a"), s("ac3"), s("-b:a"), b],
    ".aiff" => vec![s("-vn")],
    _ => vec![s("-b:a"), b],
  }
}

fn kbps(bitrate: &str) -> f64 {
  bitrate.trim_end_matches('k').parse().unwrap_or(128.0)
}

/// qpdf page range from what the user typed ("1-3, 5" -> "1-3,5"; "z" = last
/// page, "r1" = counted from the end).
pub fn page_range(s: &str) -> Result<String, String> {
  let r: String = s.chars().filter(|c| !c.is_whitespace()).collect();
  if r.is_empty() || !r.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '-' | 'z' | 'r')) {
    return Err(format!("invalid page range {s:?} (e.g. 1-3,5)"));
  }
  Ok(r)
}

/// Sidecar that runs `job`: qpdf for PDFs, img2pdf for image -> PDF
/// (lossless embed: quality / scale / crop don't apply), ffmpeg otherwise.
pub fn program(job: &Job) -> &'static str {
  match &job.kind {
    Kind::Pdf(_) => "qpdf",
    Kind::Image(i) if i.format == ".pdf" => "img2pdf",
    _ => "ffmpeg",
  }
}

/// Args (without the program, see `program`) to convert `src` into `out`.
pub fn build_args(job: &Job, out: &str) -> Result<Vec<String>, String> {
  let src = &job.source;
  let s = |x: &str| x.to_string();
  match &job.kind {
    Kind::Pdf(p) => {
      let (i, o) = (src.path.clone(), s(out));
      return match p.optimize.as_str() {
        "linearize" => Ok(vec![s("--linearize"), i, o]),
        "extract" => Ok(vec![i, s("--pages"), s("."), page_range(&p.pages)?, s("--"), o]),
        "rotate" => {
          if ![90, 180, 270].contains(&p.angle) {
            return Err(format!("invalid angle {}", p.angle));
          }
          let pages = if p.pages.trim().is_empty() { String::new() } else { format!(":{}", page_range(&p.pages)?) };
          Ok(vec![i, o, format!("--rotate=+{}{pages}", p.angle)])
        }
        // Old positional syntax: macOS / Linux system qpdf may predate 11.
        // ponytail: the password is in argv (same-user process lists see it);
        // pass it via an @args file if that ever matters. The log masks it.
        "encrypt" if p.password.is_empty() => Err("no password".into()),
        "encrypt" => Ok(vec![s("--encrypt"), p.password.clone(), p.password.clone(), s("256"), s("--"), i, o]),
        // `out` is a new folder; qpdf puts the page number at %d.
        "split" => {
          let stem = Path::new(&src.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
          Ok(vec![s("--split-pages"), i, Path::new(out).join(format!("{stem}-%d.pdf")).to_string_lossy().into_owned()])
        }
        // compress: what the built-in compressor leaves to qpdf (encrypted files).
        _ => Ok(vec![s("--stream-data=compress"), i, o]),
      };
    }
    Kind::Image(i) if i.format == ".pdf" => return Ok(vec![src.path.clone(), "-o".into(), out.into()]),
    _ => {}
  }
  let mut a: Vec<String> = vec!["-y".into()];
  match &job.kind {
    // One still frame: the Trim start, else the middle (like the thumbnail).
    Kind::Video(v) if v.format == ".png" => {
      let at = src.trim_start.unwrap_or(src.duration / 2.0);
      a.extend([s("-ss"), at.to_string(), s("-i"), src.path.clone(), s("-frames:v"), s("1")]);
    }
    Kind::Video(v) => {
      trim_args(src, &mut a);
      a.extend([s("-i"), src.path.clone()]);
      match v.format.as_str() {
        ".gif" => {
          let chain = anim_chain(v, src);
          let pre = if chain.is_empty() { String::new() } else { chain.join(",") + "," };
          a.extend([s("-filter_complex"), format!("{pre}split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse")]);
        }
        ".apng" => {
          let chain = anim_chain(v, src);
          if !chain.is_empty() {
            a.extend([s("-vf"), chain.join(",")]);
          }
          a.extend([s("-plays"), s("0")]);
        }
        // The sound only: AAC / ALAC go into M4A as they are (unless sped up).
        ".m4a" | ".mp3" => {
          a.push(s("-vn"));
          if v.speed != 1.0 {
            a.extend([s("-af"), format!("atempo={}", v.speed)]);
          }
          if v.format == ".mp3" {
            a.extend([s("-c:a"), s("libmp3lame"), s("-q:a"), s("2")]);
          } else if v.speed == 1.0 && matches!(src.audio_codec.as_str(), "aac" | "alac") {
            a.extend([s("-c:a"), s("copy")]);
          } else {
            a.extend([s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
          }
        }
        _ => match video_encoder(v, &src.video_codec) {
          // Rewrap: quality / fps / speed don't apply (the UI hides them).
          "copy" => {
            let audio = if holds_audio(&v.format, &src.audio_codec) { "copy" } else { audio_encoder(&v.format) };
            a.extend([s("-c:v"), s("copy"), s("-c:a"), s(audio)]);
          }
          enc => {
            a.extend([s("-c:v"), s(enc)]);
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
            let src_kbps = (src.duration > 0.0).then(|| src.size as f64 * 8.0 / (src.duration * 1024.0));
            rate_args(v, output_duration(src, v.speed), src_kbps, src.fps, &mut a);
          }
        },
      }
    }
    Kind::Image(i) => {
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
      a.extend(audio_codec_args(au, true));
    }
    Kind::Pdf(_) => unreachable!("handled above"),
  }
  a.push(out.into());
  Ok(a)
}

/// Highest libvorbis -q:a whose nominal stereo 44.1k bitrate fits `bitrate`.
fn vorbis_quality(bitrate: &str) -> u8 {
  const NOMINAL: [f64; 11] = [64.0, 80.0, 96.0, 112.0, 128.0, 160.0, 192.0, 224.0, 256.0, 320.0, 500.0];
  NOMINAL.iter().rposition(|&n| n <= kbps(bitrate)).unwrap_or(0) as u8
}

/// A merge to run: `args` for `merge_program`, the concat list to write to
/// the `list` path given to `merge_args` (video stream copy only), and the
/// output length in seconds for progress.
#[derive(Debug, PartialEq)]
pub struct MergePlan {
  pub args: Vec<String>,
  pub list: Option<String>,
  pub seconds: f64,
}

pub fn merge_program(kind: &Kind) -> &'static str {
  if matches!(kind, Kind::Pdf(_)) { "qpdf" } else { "ffmpeg" }
}

/// One line of an ffmpeg concat list (`'` closes the quote, `\'` is a literal one).
fn concat_entry(src: &Source) -> String {
  let mut e = format!("file '{}'\n", src.path.replace('\'', r"'\''"));
  if let Some(s) = src.trim_start {
    e += &format!("inpoint {s}\n");
  }
  if let Some(t) = src.trim_end {
    e += &format!("outpoint {t}\n");
  }
  e
}

/// `m.sources`, in order, into `out`. PDFs: qpdf's page selection. Audio:
/// decoded and joined (concat filter, no gap). Video: when every clip has the
/// same codecs and size, "copy" picked and the container takes them, the
/// concat demuxer copies them (list at `list`); otherwise every clip is fitted
/// into the first one's frame and fps and encoded, a clip without sound gets
/// silence. Per-clip Trim applies; speed / fps / quality / target size apply
/// to the whole.
pub fn merge_args(m: &MergeJob, out: &str, list: &str) -> Result<MergePlan, String> {
  let s = |x: &str| x.to_string();
  let srcs = &m.sources;
  if srcs.len() < 2 {
    return Err("merge needs at least 2 files".into());
  }
  let total = |speed: f64| srcs.iter().map(|x| output_duration(x, 1.0)).sum::<f64>() / speed;
  let inputs = |a: &mut Vec<String>| {
    for x in srcs {
      trim_args(x, a);
      a.extend([s("-i"), x.path.clone()]);
    }
  };
  let n = srcs.len();
  let mut a = vec![s("-y")];
  match &m.kind {
    Kind::Pdf(_) => {
      let mut a = vec![s("--empty"), s("--pages")];
      a.extend(srcs.iter().map(|x| x.path.clone()));
      a.extend([s("--"), s(out)]);
      return Ok(MergePlan { args: a, list: None, seconds: 0.0 });
    }
    Kind::Image(_) => return Err("images can't be merged".into()),
    Kind::Audio(au) => {
      inputs(&mut a);
      let ins: String = (0..n).map(|i| format!("[{i}:a]")).collect();
      let tempo = if au.speed != 1.0 { format!(",atempo={}", au.speed) } else { String::new() };
      a.extend([s("-filter_complex"), format!("{ins}concat=n={n}:v=0:a=1{tempo}[a]"), s("-map"), s("[a]")]);
      a.extend(audio_codec_args(au, false));
      a.push(s(out));
      Ok(MergePlan { args: a, list: None, seconds: total(au.speed) })
    }
    Kind::Video(v) if is_special_video_out(&v.format) => Err(format!("{} can't be a merge output", v.format)),
    Kind::Video(v) => {
      let first = &srcs[0];
      let alike = srcs.iter().all(|x| (&x.video_codec, &x.audio_codec, x.width, x.height) == (&first.video_codec, &first.audio_codec, first.width, first.height));
      if alike && video_encoder(v, &first.video_codec) == "copy" && holds_audio(&v.format, &first.audio_codec) {
        let list_text: String = srcs.iter().map(concat_entry).collect();
        a.extend([s("-f"), s("concat"), s("-safe"), s("0"), s("-i"), s(list), s("-c"), s("copy"), s(out)]);
        return Ok(MergePlan { args: a, list: Some(list_text), seconds: total(1.0) });
      }
      let even = |x: u32, d: u32| if x >= 2 { x - x % 2 } else { d };
      let (w, h) = (even(first.width, 1280), even(first.height, 720));
      let fps = v.fps.or((first.fps > 0.0).then_some(first.fps)).unwrap_or(30.0);
      inputs(&mut a);
      let mut fc = String::new();
      let mut cat = String::new();
      let mut extra = n;
      for (i, x) in srcs.iter().enumerate() {
        fc += &format!("[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}];");
        let audio = if x.audio_codec.is_empty() {
          a.extend([s("-f"), s("lavfi"), s("-t"), output_duration(x, 1.0).to_string(), s("-i"), s("anullsrc=r=48000:cl=stereo")]);
          extra += 1;
          format!("[{}:a]", extra - 1)
        } else {
          format!("[{i}:a]")
        };
        cat += &format!("[v{i}]{audio}");
      }
      fc += &format!("{cat}concat=n={n}:v=1:a=1[cv][ca]");
      let (vo, ao) = if v.speed != 1.0 {
        fc += &format!(";[cv]setpts={}*PTS[v];[ca]atempo={}[a]", 1.0 / v.speed, v.speed);
        ("[v]", "[a]")
      } else {
        ("[cv]", "[ca]")
      };
      let enc = match effective_codec(v) {
        "copy" => container_codecs(&v.format).map_or("libx264", |c| c[0]),
        c => c,
      };
      a.extend([s("-filter_complex"), fc, s("-map"), s(vo), s("-map"), s(ao), s("-c:v"), s(enc)]);
      if target_mb(v).is_none() {
        a.extend([s("-c:a"), s(audio_encoder(&v.format))]);
      }
      let (size, secs) = srcs.iter().fold((0.0, 0.0), |(z, d), x| (z + x.size as f64, d + x.duration));
      let src_kbps = (secs > 0.0).then(|| size * 8.0 / (secs * 1024.0));
      let seconds = total(v.speed);
      rate_args(v, seconds, src_kbps, first.fps, &mut a);
      a.push(s(out));
      Ok(MergePlan { args: a, list: None, seconds })
    }
  }
}

/// For the log line: args joined, quoting the ones with spaces; the two
/// passwords after qpdf's `--encrypt` show as `***`.
pub fn display_command(program: &str, args: &[String]) -> String {
  let secret = args.iter().position(|x| x == "--encrypt").map_or(0..0, |i| i + 1..i + 3);
  std::iter::once(program)
    .chain(args.iter().enumerate().map(|(i, x)| if secret.contains(&i) { "***" } else { x.as_str() }))
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

/// `<dir>/<stem><suffix><ext>` (suffix `_converted`, `_merged`, `_pages`),
/// adding the suffix again until `exists` says the name is free. Never overwrites.
pub fn unique_out_path(dir: &Path, stem: &str, suffix: &str, ext: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
  let mut base = format!("{stem}{suffix}");
  loop {
    let p = dir.join(format!("{base}{ext}"));
    if !exists(&p) {
      return p;
    }
    base.push_str(suffix);
  }
}

/// `taken` for a folder output (PDF split): reserves it by creating it.
pub fn taken_dir(p: &Path) -> bool {
  std::fs::create_dir(p).is_err_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists || p.exists())
}

/// `exists` for `unique_out_path` that also reserves: creates `p` empty
/// (atomically, `create_new`), so a job started a moment later can't pick
/// the same name before this one writes. Taken = something is there (a
/// folder on Windows fails with access denied); any other error leaves the
/// name to the job, which then fails on it.
pub fn taken(p: &Path) -> bool {
  std::fs::File::create_new(p).is_err_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists || p.exists())
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
        // A frame: about 1.5 bytes a pixel as PNG.
        _ if v.format == ".png" => (src.width as f64 * src.height as f64 * 1.5 / MIB).max(0.01),
        _ if matches!(v.format.as_str(), ".m4a" | ".mp3") => (192_000.0 * src.duration * ratio / 8.0 / MIB / v.speed).max(0.01),
        _ if video_encoder(v, &src.video_codec) == "copy" => current * ratio,
        _ => {
          let target_fps = v.fps.unwrap_or(src.fps);
          let fps_factor = if target_fps > 0.0 && src.fps > 0.0 { target_fps / src.fps } else { 1.0 };
          let q = v.quality / 100.0;
          let e = if v.format == ".gif" || v.format == ".apng" {
            current * ratio * q * q * fps_factor * 2.5 / v.speed
          } else {
            let codec = match effective_codec(v) {
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
        ".m4a" if a.alac => 900.0,
        ".wav" | ".aiff" => 1411.0,
        ".opus" => kbps(&a.bitrate).min(256.0),
        _ => kbps(&a.bitrate),
      };
      let same_lossless = [".flac", ".wav", ".aiff"].iter().any(|f| a.format == *f && lower.ends_with(f));
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
    // hub tests/fixtures/test_fixture_video.mp4-ish: 1 MiB, 10 s, 30 fps
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
    Kind::Audio(AudioSettings { format: format.into(), bitrate: bitrate.into(), speed, alac: false })
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
  fn pdf_level_defaults_to_ebook_for_old_settings() {
    let level = |settings: &str| {
      let j: Job = serde_json::from_str(&format!(r#"{{"source":{{"path":"a.pdf"}},"fileType":"pdf","settings":{settings}}}"#)).unwrap();
      let Kind::Pdf(p) = j.kind else { panic!() };
      p.level
    };
    assert_eq!(level(r#"{"optimize":"compress"}"#), "ebook");
    assert_eq!(level(r#"{"optimize":"compress","level":"screen"}"#), "screen");
  }

  #[test]
  fn video_default_uses_codec_and_relative_bitrate() {
    // 1 MiB over 10 s = 819.2 kbps original
    assert_eq!(args(src("in.mp4"), video(|_| {})), ["-y", "-i", "in.mp4", "-c:v", "libx264", "-b:v", "819k", "-bufsize", "1638k", "o.x"]);
  }

  #[test]
  fn webm_only_gets_webm_codecs() {
    let c = |codec: &str, target: bool| {
      let a = args(src("in.mp4"), video(|v| {
        v.format = ".webm".into();
        v.codec = codec.into();
        v.target_size_mode = target;
        v.target_size_mb = Some(5.0);
      }));
      let at = |flag: &str| a[a.iter().position(|x| x == flag).unwrap() + 1].clone();
      (at("-c:v"), target.then(|| at("-c:a")))
    };
    assert_eq!(c("libx264", false), ("libvpx-vp9".into(), None));
    assert_eq!(c("libx265", false), ("libvpx-vp9".into(), None));
    assert_eq!(c("libsvtav1", false), ("libsvtav1".into(), None));
    assert_eq!(c("libvpx-vp9", true), ("libvpx-vp9".into(), Some("libopus".into())));
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
    assert_eq!(joined(src("a.mp3"), audio(".ogg", "192k", 1.0)), "-y -i a.mp3 -c:a libvorbis -q:a 6 o.x");
    // M4A: AAC; cover art copied as an attached picture (re-encoding it to
    // h264 is refused by the ipod muxer).
    assert_eq!(joined(src("a.flac"), audio(".m4a", "192k", 1.0)), "-y -i a.flac -c:v copy -disposition:v attached_pic -c:a aac -b:a 192k o.x");
  }

  #[test]
  fn ogg_uses_vbr_quality_so_mono_sources_encode() {
    let q = |b| joined(src("a.mp3"), audio(".ogg", b, 1.0));
    assert_eq!(q("320k"), "-y -i a.mp3 -c:a libvorbis -q:a 9 o.x");
    assert_eq!(q("256k"), "-y -i a.mp3 -c:a libvorbis -q:a 8 o.x");
    assert_eq!(q("128k"), "-y -i a.mp3 -c:a libvorbis -q:a 4 o.x");
    assert_eq!(q("64k"), "-y -i a.mp3 -c:a libvorbis -q:a 0 o.x");
    assert_eq!(q("32k"), "-y -i a.mp3 -c:a libvorbis -q:a 0 o.x");
  }

  fn pdf(optimize: &str) -> Kind {
    Kind::Pdf(PdfSettings { optimize: optimize.into(), level: default_pdf_level(), pages: String::new(), angle: 90, password: String::new() })
  }

  #[test]
  fn pdf_compress_and_linearize_run_qpdf() {
    let j = Job { source: src(r"C:\a b\文件.pdf"), kind: pdf("compress") };
    assert_eq!(program(&j), "qpdf");
    assert_eq!(build_args(&j, "o.pdf").unwrap(), ["--stream-data=compress", r"C:\a b\文件.pdf", "o.pdf"]);
    assert_eq!(args(src("a.pdf"), pdf("linearize")), ["--linearize", "a.pdf", "o.x"]);
  }

  #[test]
  fn image_to_pdf_runs_img2pdf_ignoring_quality_scale_crop() {
    let s = Source { crop: Some(Crop { x: 1.0, y: 1.0, width: 9.0, height: 9.0 }), ..src("圖 片.png") };
    let j = Job { source: s, kind: image(".pdf", 40.0, 50.0) };
    assert_eq!(program(&j), "img2pdf");
    assert_eq!(build_args(&j, "o.pdf").unwrap(), ["圖 片.png", "-o", "o.pdf"]);
  }

  #[test]
  fn everything_else_runs_ffmpeg() {
    assert_eq!(program(&Job { source: src("a.png"), kind: image(".jpg", 85.0, 100.0) }), "ffmpeg");
    assert_eq!(program(&Job { source: src("a.mp4"), kind: video(|_| {}) }), "ffmpeg");
    assert_eq!(program(&Job { source: src("a.mp3"), kind: audio(".aac", "128k", 1.0) }), "ffmpeg");
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
    let p = unique_out_path(Path::new("d"), "a", "_converted", ".mp4", |p| taken.iter().any(|t| t == p));
    assert_eq!(p, PathBuf::from("d").join("a_converted_converted_converted.mp4"));
    assert_eq!(unique_out_path(Path::new("d"), "影片 一", "_converted", ".gif", |_| false), PathBuf::from("d").join("影片 一_converted.gif"));
  }

  #[test]
  fn taken_reserves_the_name_so_concurrent_jobs_never_share_it() {
    let dir = std::env::temp_dir().join(format!("sorai-reserve-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let a = unique_out_path(&dir, "文件", "_converted", ".pdf", taken);
    let b = unique_out_path(&dir, "文件", "_converted", ".pdf", taken);
    assert_eq!((a.file_name().unwrap(), b.file_name().unwrap()), ("文件_converted.pdf".as_ref(), "文件_converted_converted.pdf".as_ref()));
    assert_eq!(std::fs::metadata(&a).unwrap().len(), 0); // reserved: an empty file
    // A folder it can't create in still gets a name (the job then fails on it).
    assert_eq!(unique_out_path(&dir.join("missing"), "x", "_converted", ".pdf", taken), dir.join("missing").join("x_converted.pdf"));
  }

  fn mov(vc: &str, ac: &str) -> Source {
    Source { video_codec: vc.into(), audio_codec: ac.into(), ..src("in.mov") }
  }

  #[test]
  fn keep_codec_copies_streams_the_container_holds() {
    let copy = |format: &str| video(|v| { v.format = format.into(); v.codec = "copy".into(); v.quality = 50.0; v.fps = Some(15.0); v.speed = 2.0; });
    // Fits: both streams copied, quality / fps / speed ignored.
    assert_eq!(joined(mov("h264", "aac"), copy(".mp4")), "-y -i in.mov -c:v copy -c:a copy o.x");
    // No audio stream: nothing to re-encode.
    assert_eq!(joined(mov("hevc", ""), copy(".mov")), "-y -i in.mov -c:v copy -c:a copy o.x");
    // Only the sound doesn't fit: just it is re-encoded, with the container's encoder.
    assert_eq!(joined(mov("h264", "opus"), copy(".mp4")), "-y -i in.mov -c:v copy -c:a aac o.x");
    assert_eq!(joined(mov("wmv2", "aac"), copy(".wmv")), "-y -i in.mov -c:v copy -c:a wmav2 o.x");
    // The video doesn't fit: the container's default encoder, like any encode.
    assert_eq!(
      joined(mov("h264", "aac"), copy(".webm")),
      "-y -i in.mov -c:v libvpx-vp9 -vf fps=15,setpts=0.5*PTS -af atempo=2 -b:v 204k -bufsize 408k o.x"
    );
    assert!(joined(mov("prores", "aac"), copy(".mpg")).starts_with("-y -i in.mov -c:v mpeg2video "));
    assert!(joined(mov("vp9", "opus"), copy(".avi")).starts_with("-y -i in.mov -c:v libx264 "));
    // Target size always encodes.
    assert!(joined(mov("h264", "aac"), video(|v| { v.codec = "copy".into(); v.target_size_mode = true; v.target_size_mb = Some(5.0); })).contains("-c:v libx264 -b:v"));
  }

  #[test]
  fn containers_limit_encoders() {
    let eff = |format: &str, codec: &str| effective_codec(&VideoSettings { format: format.into(), codec: codec.into(), quality: 100.0, speed: 1.0, fps: None, target_size_mode: false, target_size_mb: None }).to_string();
    assert_eq!(
      [eff(".mov", "libsvtav1"), eff(".ts", "libx265"), eff(".wmv", "libx264"), eff(".mpg", "libx265"), eff(".mkv", "libsvtav1"), eff(".webm", "copy")],
      ["libx264", "libx265", "wmv2", "mpeg2video", "libsvtav1", "copy"]
    );
    assert!(holds_video(".mkv", "anything") && !holds_video(".mkv", ""));
    assert!(holds_audio(".webm", "") && !holds_audio(".webm", "aac") && holds_audio(".mkv", "flac"));
  }

  // lavc's own wmv2/mpeg2video refuse -bufsize without -maxrate ("Either both
  // buffer size and max rate or neither must be specified").
  #[test]
  fn wmv_and_mpg_get_no_lone_bufsize() {
    assert_eq!(joined(src("in.mp4"), video(|v| v.format = ".wmv".into())), "-y -i in.mp4 -c:v wmv2 -b:v 819k o.x");
    assert_eq!(joined(src("in.mp4"), video(|v| v.format = ".mpg".into())), "-y -i in.mp4 -c:v mpeg2video -b:v 819k o.x");
    assert_eq!(joined(src("in.mp4"), video(|v| v.format = ".mov".into())), "-y -i in.mp4 -c:v libx264 -b:v 819k -bufsize 1638k o.x");
  }

  #[test]
  fn apng_shares_the_gif_chain_and_loops() {
    assert_eq!(joined(src("in.mp4"), video(|v| v.format = ".apng".into())), "-y -i in.mp4 -vf fps=30 -plays 0 o.x");
    assert_eq!(
      joined(src("in.mp4"), video(|v| { v.format = ".apng".into(); v.quality = 50.0; v.speed = 2.0; v.fps = Some(10.0); })),
      "-y -i in.mp4 -vf fps=10,setpts=0.5*PTS,scale=trunc(iw*0.5/2)*2:-2:flags=lanczos -plays 0 o.x"
    );
  }

  #[test]
  fn png_takes_one_frame_at_trim_start_else_the_middle() {
    let png = || video(|v| v.format = ".png".into());
    assert_eq!(joined(src("in.mp4"), png()), "-y -ss 5 -i in.mp4 -frames:v 1 o.x");
    let s = Source { trim_start: Some(2.5), trim_end: Some(4.0), ..src("in.mp4") };
    assert_eq!(joined(s, png()), "-y -ss 2.5 -i in.mp4 -frames:v 1 o.x");
  }

  #[test]
  fn sound_only_outputs() {
    let m4a = |speed: f64| video(|v| { v.format = ".m4a".into(); v.speed = speed; });
    assert_eq!(joined(mov("h264", "aac"), m4a(1.0)), "-y -i in.mov -vn -c:a copy o.x");
    assert_eq!(joined(mov("h264", "alac"), m4a(1.0)), "-y -i in.mov -vn -c:a copy o.x");
    assert_eq!(joined(mov("h264", "opus"), m4a(1.0)), "-y -i in.mov -vn -c:a aac -b:a 192k o.x");
    assert_eq!(joined(mov("h264", "aac"), m4a(2.0)), "-y -i in.mov -vn -af atempo=2 -c:a aac -b:a 192k o.x");
    let trimmed = Source { trim_start: Some(1.0), trim_end: Some(3.0), ..mov("h264", "aac") };
    assert_eq!(joined(trimmed, m4a(1.0)), "-y -ss 1 -to 3 -i in.mov -vn -c:a copy o.x");
    assert_eq!(joined(mov("h264", "aac"), video(|v| v.format = ".mp3".into())), "-y -i in.mov -vn -c:a libmp3lame -q:a 2 o.x");
  }

  #[test]
  fn new_audio_encoders() {
    assert_eq!(joined(src("a.mp3"), audio(".opus", "320k", 1.0)), "-y -i a.mp3 -vn -c:a libopus -b:a 256k o.x");
    assert_eq!(joined(src("a.mp3"), audio(".opus", "128k", 1.0)), "-y -i a.mp3 -vn -c:a libopus -b:a 128k o.x");
    let alac = Kind::Audio(AudioSettings { format: ".m4a".into(), bitrate: "320k".into(), speed: 1.0, alac: true });
    assert_eq!(joined(src("a.flac"), alac), "-y -i a.flac -c:v copy -disposition:v attached_pic -c:a alac o.x");
    assert_eq!(joined(src("a.mp3"), audio(".aiff", "320k", 1.0)), "-y -i a.mp3 -vn o.x");
    assert_eq!(joined(src("a.mp3"), audio(".wma", "192k", 1.0)), "-y -i a.mp3 -vn -c:a wmav2 -b:a 192k o.x");
    assert_eq!(joined(src("a.mp3"), audio(".ac3", "192k", 1.5)), "-y -i a.mp3 -af atempo=1.5 -vn -c:a ac3 -b:a 192k o.x");
  }

  fn pdf_op(f: impl FnOnce(&mut PdfSettings)) -> Kind {
    let Kind::Pdf(mut p) = pdf("compress") else { unreachable!() };
    f(&mut p);
    Kind::Pdf(p)
  }
  fn pdf_args(kind: Kind) -> Result<Vec<String>, String> {
    build_args(&Job { source: src("a.pdf"), kind }, "o.pdf")
  }

  #[test]
  fn pdf_extract_rotate_encrypt_split() {
    let extract = |pages: &str| pdf_args(pdf_op(|p| { p.optimize = "extract".into(); p.pages = pages.into(); }));
    assert_eq!(extract(" 1-3, 5 ").unwrap(), ["a.pdf", "--pages", ".", "1-3,5", "--", "o.pdf"]);
    assert!(extract("").is_err());
    let rotate = |angle: i32, pages: &str| pdf_args(pdf_op(|p| { p.optimize = "rotate".into(); p.angle = angle; p.pages = pages.into(); }));
    assert_eq!(rotate(90, "").unwrap(), ["a.pdf", "o.pdf", "--rotate=+90"]);
    assert_eq!(rotate(270, "1, 3-z").unwrap(), ["a.pdf", "o.pdf", "--rotate=+270:1,3-z"]);
    assert!(rotate(45, "").unwrap_err().contains("45"));
    assert!(rotate(180, "1;2").is_err());
    let encrypt = |pw: &str| pdf_args(pdf_op(|p| { p.optimize = "encrypt".into(); p.password = pw.into(); }));
    assert_eq!(encrypt("p w").unwrap(), ["--encrypt", "p w", "p w", "256", "--", "a.pdf", "o.pdf"]);
    assert!(encrypt("").is_err());
    let split = Job { source: src(r"C:\d\文件.pdf"), kind: pdf_op(|p| p.optimize = "split".into()) };
    assert!(split.out_is_dir() && split.out_ext().is_empty());
    let dir = Path::new(r"C:\d").join("文件_pages");
    assert_eq!(build_args(&split, dir.to_str().unwrap()).unwrap(), ["--split-pages", r"C:\d\文件.pdf", dir.join("文件-%d.pdf").to_str().unwrap()]);
    assert!(!Job { source: src("a.pdf"), kind: pdf("linearize") }.out_is_dir());
  }

  #[test]
  fn page_range_strips_spaces_and_rejects_the_rest() {
    assert_eq!(page_range(" 1 - 3 ,5,z, r2-r1").unwrap(), "1-3,5,z,r2-r1");
    for bad in ["", "   ", "1;2", "a", "1-3,x"] {
      assert!(page_range(bad).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn display_command_hides_the_password() {
    let a = pdf_args(pdf_op(|p| { p.optimize = "encrypt".into(); p.password = "hunter 2".into(); })).unwrap();
    let shown = display_command("qpdf", &a);
    assert_eq!(shown, "qpdf --encrypt *** *** 256 -- a.pdf o.pdf");
    assert!(!shown.contains("hunter"));
  }

  #[test]
  fn old_settings_without_new_keys_deserialize() {
    let kind = |file_type: &str, settings: &str| serde_json::from_str::<Job>(&format!(r#"{{"source":{{"path":"a"}},"fileType":"{file_type}","settings":{settings}}}"#)).unwrap().kind;
    let Kind::Audio(a) = kind("audio", r#"{"format":".m4a","bitrate":"192k","speed":1}"#) else { panic!() };
    assert!(!a.alac);
    let Kind::Pdf(p) = kind("pdf", r#"{"optimize":"linearize"}"#) else { panic!() };
    assert_eq!((p.pages.as_str(), p.angle, p.password.as_str(), p.level.as_str()), ("", 90, "", "ebook"));
    let j: Job = serde_json::from_str(r#"{"source":{"path":"a","videoCodec":"h264","audioCodec":"aac"},"fileType":"pdf","settings":{"optimize":"split"}}"#).unwrap();
    assert_eq!((j.source.video_codec.as_str(), j.source.audio_codec.as_str()), ("h264", "aac"));
  }

  #[test]
  fn taken_dir_reserves_a_folder() {
    let dir = std::env::temp_dir().join(format!("sorai-taken-dir-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let a = unique_out_path(&dir, "文件", "_pages", "", taken_dir);
    let b = unique_out_path(&dir, "文件", "_pages", "", taken_dir);
    let got = (a.file_name().unwrap().to_owned(), b.file_name().unwrap().to_owned(), a.is_dir(), b.is_dir());
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(got, ("文件_pages".into(), "文件_pages_pages".into(), true, true));
    assert_eq!(unique_out_path(Path::new("d"), "a", "_merged", ".mp4", |_| false), Path::new("d").join("a_merged.mp4"));
  }

  #[test]
  fn new_output_estimates() {
    let e = |source: Source, kind: Kind| est(source, kind).est_mb;
    assert_eq!(e(mov("h264", "aac"), video(|v| { v.codec = "copy".into(); v.quality = 10.0; })), 1.0); // = source
    assert_eq!(e(mov("h264", "aac"), video(|v| { v.format = ".png".into() })), 320.0 * 240.0 * 1.5 / MIB);
    assert_eq!(e(src("in.mp4"), video(|v| { v.format = ".mp3".into() })), 192_000.0 * 10.0 / 8.0 / MIB);
    let per_kbps = 1000.0 * 10.0 / 8.0 / MIB;
    let alac = Kind::Audio(AudioSettings { format: ".m4a".into(), bitrate: "128k".into(), speed: 1.0, alac: true });
    assert!((e(src("a.mp3"), alac) - 900.0 * per_kbps).abs() < 1e-9);
    assert!((e(src("a.mp3"), audio(".aiff", "128k", 1.0)) - 1411.0 * per_kbps).abs() < 1e-9);
    assert!((e(src("a.mp3"), audio(".opus", "320k", 1.0)) - 256.0 * per_kbps).abs() < 1e-9);
  }

  fn merge(sources: Vec<Source>, kind: Kind, out: &str) -> Result<MergePlan, String> {
    merge_args(&MergeJob { sources, kind }, out, "list.txt")
  }

  #[test]
  fn merge_output_is_always_one_file() {
    let job = |kind| MergeJob { sources: vec![], kind };
    assert_eq!(job(pdf("split")).out_ext(), ".pdf");
    assert_eq!(job(audio(".m4a", "128k", 1.0)).out_ext(), ".m4a");
  }

  #[test]
  fn merge_pdfs_with_qpdf() {
    let m = merge(vec![src("a.pdf"), src("b.pdf"), src("c d.pdf")], pdf("compress"), "o.pdf").unwrap();
    assert_eq!(m, MergePlan { args: ["--empty", "--pages", "a.pdf", "b.pdf", "c d.pdf", "--", "o.pdf"].map(String::from).to_vec(), list: None, seconds: 0.0 });
    assert_eq!(merge_program(&pdf("compress")), "qpdf");
  }

  #[test]
  fn merge_needs_two_files_and_a_mergeable_output() {
    assert!(merge(vec![src("a.mp4")], video(|_| {}), "o.mp4").is_err());
    assert!(merge(vec![], pdf("compress"), "o.pdf").is_err());
    for f in [".gif", ".apng", ".png", ".m4a", ".mp3"] {
      assert!(merge(vec![src("a.mp4"), src("b.mp4")], video(|v| v.format = f.into()), "o").is_err(), "{f}");
    }
    assert!(merge(vec![src("a.png"), src("b.png")], image(".jpg", 85.0, 100.0), "o.jpg").is_err());
  }

  #[test]
  fn merge_audio_joins_decoded_with_speed_and_trim() {
    let m = merge(vec![src("a.mp3"), src("b.mp3")], audio(".mp3", "192k", 1.0), "o.mp3").unwrap();
    assert_eq!(m.args.join(" "), "-y -i a.mp3 -i b.mp3 -filter_complex [0:a][1:a]concat=n=2:v=0:a=1[a] -map [a] -b:a 192k o.mp3");
    assert_eq!((m.list, m.seconds), (None, 20.0));
    let a = Source { trim_start: Some(1.0), trim_end: Some(4.0), ..src("a.flac") };
    let m = merge(vec![a, src("b.mp3")], audio(".m4a", "128k", 2.0), "o.m4a").unwrap();
    assert_eq!(m.args.join(" "), "-y -ss 1 -to 4 -i a.flac -i b.mp3 -filter_complex [0:a][1:a]concat=n=2:v=0:a=1,atempo=2[a] -map [a] -vn -c:a aac -b:a 128k o.m4a");
    assert_eq!(m.seconds, 6.5);
  }

  #[test]
  fn merge_alike_clips_copies_through_the_concat_list() {
    let a = Source { path: r"C:\it's\a.mp4".into(), trim_start: Some(1.0), trim_end: Some(4.0), ..mov("h264", "aac") };
    let b = Source { path: "b.mp4".into(), ..mov("h264", "aac") };
    let m = merge(vec![a, b], video(|v| v.codec = "copy".into()), "o.mp4").unwrap();
    assert_eq!(m.args.join(" "), "-y -f concat -safe 0 -i list.txt -c copy o.mp4");
    assert_eq!(m.list.as_deref(), Some("file 'C:\\it'\\''s\\a.mp4'\ninpoint 1\noutpoint 4\nfile 'b.mp4'\n"));
    assert_eq!(m.seconds, 13.0);
  }

  #[test]
  fn merge_unlike_clips_fits_them_into_the_first_and_encodes() {
    let b = Source { path: "b.mp4".into(), width: 640, height: 480, ..mov("h264", "") };
    let m = merge(vec![mov("h264", "aac"), b], video(|v| v.codec = "copy".into()), "o.mp4").unwrap();
    let fit = |i: usize| format!("[{i}:v]scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v{i}];");
    assert_eq!(
      m.args.join(" "),
      format!(
        "-y -i in.mov -i b.mp4 -f lavfi -t 10 -i anullsrc=r=48000:cl=stereo -filter_complex {}{}[v0][0:a][v1][2:a]concat=n=2:v=1:a=1[cv][ca] -map [cv] -map [ca] -c:v libx264 -c:a aac -b:v 819k -bufsize 1638k o.mp4",
        fit(0),
        fit(1)
      )
    );
    assert_eq!((m.list, m.seconds), (None, 20.0));
    // Same specs but not "copy": encoded too. Speed + target size over the whole output.
    let m = merge(vec![mov("h264", "aac"), mov("h264", "aac")], video(|v| { v.speed = 2.0; v.target_size_mode = true; v.target_size_mb = Some(5.0); }), "o.mp4").unwrap();
    let a = m.args.join(" ");
    assert!(a.contains("concat=n=2:v=1:a=1[cv][ca];[cv]setpts=0.5*PTS[v];[ca]atempo=2[a] -map [v] -map [a] -c:v libx264 "), "{a}");
    // 5 MB over 10 s of output.
    assert!(a.ends_with("-b:v 3382k -maxrate 3382k -bufsize 1691k -c:a aac -b:a 128k o.mp4"), "{a}");
    assert_eq!(a.matches("-c:a").count(), 1);
    assert_eq!(m.seconds, 10.0);
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
    // WebM estimates with the codec it really encodes (VP9 for H.264).
    assert_eq!(est(src("a.mp4"), video(|v| { v.format = ".webm".into(); v.quality = 50.0; })).est_mb, 0.5 * 0.65);
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
    assert!((est(src("a.pdf"), pdf("compress")).est_mb - 0.7).abs() < 1e-9);
  }
}
