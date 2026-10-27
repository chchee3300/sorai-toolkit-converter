//! `sorai-media://` -- serves the converter's queued files to Trim/Crop
//! (`<video>` / `<img>`). Only exact paths in the current queue are served;
//! the asset protocol can't do that because its scope has no "remove".

use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Response, StatusCode};

/// Largest body for one Range request (`<video>` asks again for the rest).
const MAX_CHUNK: u64 = 1 << 20;

fn mime(path: &str) -> &'static str {
  let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
  match ext.as_str() {
    "mp4" | "mov" => "video/mp4",
    "webm" => "video/webm",
    "mkv" => "video/x-matroska",
    "avi" => "video/x-msvideo",
    "mp3" => "audio/mpeg",
    "wav" => "audio/wav",
    "aac" => "audio/aac",
    "m4a" => "audio/mp4",
    "flac" => "audio/flac",
    "ogg" => "audio/ogg",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "webp" => "image/webp",
    "avif" => "image/avif",
    "gif" => "image/gif",
    "ico" => "image/x-icon",
    _ => "application/octet-stream",
  }
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` -> inclusive (start, end) clamped
/// to MAX_CHUNK. None = unsatisfiable or unsupported (multi-range).
fn byte_range(spec: &str, len: u64) -> Option<(u64, u64)> {
  let (a, b) = spec.strip_prefix("bytes=")?.split_once('-')?;
  let (start, end) = match (a.trim(), b.trim()) {
    ("", n) => (len.saturating_sub(n.parse().ok()?), len.checked_sub(1)?),
    (s, "") => (s.parse().ok()?, len.checked_sub(1)?),
    (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
  };
  (start <= end).then(|| (start, end.min(start + MAX_CHUNK - 1)))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
  Response::builder().status(code).body(vec![]).unwrap()
}

/// Response for request path `uri_path` (`/<percent-encoded abs path>`, as
/// `convertFileSrc` builds it) given the queue `allowed` and a Range header.
pub fn respond(allowed: &[String], uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
  let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
  let path = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();
  if !allowed.iter().any(|p| *p == path) {
    return status(StatusCode::FORBIDDEN);
  }
  let Ok(mut file) = std::fs::File::open(path.as_ref()) else { return status(StatusCode::NOT_FOUND) };
  let len = file.metadata().map(|m| m.len()).unwrap_or(0);
  let resp = Response::builder().header(header::CONTENT_TYPE, mime(&path)).header(header::ACCEPT_RANGES, "bytes");
  let Some(spec) = range else {
    let mut body = Vec::with_capacity(len as usize);
    return match file.read_to_end(&mut body) {
      Ok(_) => resp.body(body).unwrap(),
      Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR),
    };
  };
  let Some((start, end)) = byte_range(spec, len) else {
    return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(vec![]).unwrap();
  };
  let mut body = vec![0; (end - start + 1) as usize];
  if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
    return status(StatusCode::INTERNAL_SERVER_ERROR);
  }
  resp.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")).body(body).unwrap()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn serves_only_queued_paths_with_ranges() {
    let f = std::env::temp_dir().join(format!("sorai 預覽 {}.mp4", std::process::id()));
    std::fs::write(&f, b"0123456789").unwrap();
    let p = f.to_string_lossy().into_owned();
    let url = format!("/{}", percent_encoding::utf8_percent_encode(&p, percent_encoding::NON_ALPHANUMERIC));
    let q = [p.clone()];

    assert_eq!(respond(&[], &url, None).status(), 403, "not queued");
    let full = respond(&q, &url, None);
    assert_eq!((full.status().as_u16(), full.body().as_slice()), (200, &b"0123456789"[..]));
    assert_eq!(full.headers()[header::CONTENT_TYPE], "video/mp4");
    let r = respond(&q, &url, Some("bytes=2-4"));
    assert_eq!((r.status().as_u16(), r.body().as_slice()), (206, &b"234"[..]));
    assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
    assert_eq!(respond(&q, &url, Some("bytes=7-")).body().as_slice(), b"789");
    assert_eq!(respond(&q, &url, Some("bytes=-3")).body().as_slice(), b"789");
    assert_eq!(respond(&q, &url, Some("bytes=20-")).status(), 416);
    std::fs::remove_file(&f).unwrap();
    assert_eq!(respond(&q, &url, None).status(), 404);
  }

  #[test]
  fn big_open_ranges_are_chunked() {
    assert_eq!(byte_range("bytes=0-", 10 << 20), Some((0, MAX_CHUNK - 1)));
    assert_eq!(byte_range("bytes=5-2", 10), None);
    assert_eq!(byte_range("bytes=0-1,4-5", 10), None);
  }
}
