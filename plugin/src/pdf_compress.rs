//! Built-in PDF compressor (no sidecar): PDF bytes in, smaller PDF bytes out.
//! Pure function so the job runner, cargo tests and (ticket 04) a
//! Ghostscript best-of can all call it.
//!
//! Passes: drop page thumbnails and `PieceInfo`, re-Flate every stream at
//! level 9 (kept only when smaller), store byte-identical streams once,
//! prune unreachable objects. Never returns something bigger than the input.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};

use lopdf::{Document, LoadOptions, Object, ObjectId, Stream};

/// Any single stream may decode to at most this (decompression bombs).
const MAX_DECODED: usize = 512 * 1024 * 1024;

pub struct Outcome {
  /// The compressed PDF, or a copy of the input when `not_smaller`.
  pub bytes: Vec<u8>,
  /// Nothing came out smaller than the input: `bytes` is the input.
  pub not_smaller: bool,
}

/// `cancel` is polled between streams (returns `Err` once set); `progress`
/// gets 0..=100. Encrypted input is an error: callers route it to qpdf,
/// because lopdf silently decrypts owner-password-only files on load.
pub fn compress(src: &[u8], cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<Outcome, String> {
  let options = LoadOptions { max_decompressed_size: Some(MAX_DECODED), ..Default::default() };
  let mut doc = Document::load_mem_with_options(src, options).map_err(|e| format!("not a readable PDF: {e}"))?;
  if doc.is_encrypted() || doc.was_encrypted() {
    return Err("encrypted PDF (use qpdf)".into());
  }
  strip_private_data(&mut doc);

  let ids: Vec<ObjectId> = doc.objects.iter().filter(|(_, o)| matches!(o, Object::Stream(_))).map(|(id, _)| *id).collect();
  for (i, id) in ids.iter().enumerate() {
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    let Some(Object::Stream(s)) = doc.objects.get_mut(id) else { continue };
    // Images: ticket 03 downsamples / re-encodes them here; until then they
    // get the same lossless re-Flate as everything else.
    reflate(s);
    progress((i + 1) as f64 * 100.0 / ids.len() as f64);
  }
  dedupe_streams(&mut doc);
  // ponytail: lopdf's prune is O(n^2) (Vec::contains); fine below ~10k objects.
  doc.prune_objects();

  let mut out = vec![];
  doc.save_to(&mut out).map_err(|e| e.to_string())?;
  Ok(if out.len() < src.len() { Outcome { bytes: out, not_smaller: false } } else { Outcome { bytes: src.to_vec(), not_smaller: true } })
}

/// Has an `/Encrypt` key (classic trailer or xref-stream dictionary, both
/// uncompressed). Such files keep going through qpdf, which preserves the
/// encryption; a stray match inside an uncompressed stream just means qpdf.
pub fn is_encrypted(src: &[u8]) -> bool {
  src.windows(8).any(|w| w == b"/Encrypt")
}

/// Page `Thumb` images and application-private `PieceInfo` (Illustrator /
/// Photoshop round-trip data, often bigger than the page) aren't rendered.
fn strip_private_data(doc: &mut Document) {
  for o in doc.objects.values_mut() {
    let dict = match o {
      Object::Dictionary(d) => d,
      Object::Stream(s) => &mut s.dict,
      _ => continue,
    };
    dict.remove(b"PieceInfo");
    if dict.get(b"Type").and_then(Object::as_name).ok() == Some(b"Page") {
      dict.remove(b"Thumb");
    }
  }
}

/// Decodes and recompresses at zlib level 9, keeping it only if smaller.
/// Skips anything with DecodeParms (predictors: re-encoding without them is
/// usually bigger, and image samples are ticket 03's job), lossy / bilevel
/// image codecs, and XMP metadata (some readers want it uncompressed).
fn reflate(s: &mut Stream) {
  const LOSSLESS: [&[u8]; 5] = [b"FlateDecode", b"LZWDecode", b"ASCII85Decode", b"ASCIIHexDecode", b"RunLengthDecode"];
  let filters = s.filters().unwrap_or_default();
  if !s.allows_compression
    || s.dict.has(b"DecodeParms")
    || !filters.iter().all(|f| LOSSLESS.contains(f))
    || s.dict.get(b"Type").and_then(Object::as_name).ok() == Some(b"Metadata")
  {
    return;
  }
  let Ok(plain) = (if filters.is_empty() { Ok(s.content.clone()) } else { s.decompressed_content_with_limit(MAX_DECODED) }) else { return };
  let mut new = s.clone();
  new.set_plain_content(plain);
  if new.compress().is_ok() && new.content.len() < s.content.len() {
    *s = new;
  }
}

/// Byte-identical streams (same dictionary and data) become one object;
/// references to the duplicates are rewritten, the duplicates pruned.
fn dedupe_streams(doc: &mut Document) {
  let mut kept: HashMap<u64, Vec<ObjectId>> = HashMap::new();
  let mut dup: BTreeMap<ObjectId, ObjectId> = BTreeMap::new();
  for (id, o) in &doc.objects {
    let Object::Stream(s) = o else { continue };
    let mut h = DefaultHasher::new();
    s.content.hash(&mut h);
    let same = kept.entry(h.finish()).or_default();
    let twin = same.iter().find(|k| matches!(&doc.objects[*k], Object::Stream(t) if t.dict == s.dict && t.content == s.content));
    match twin {
      Some(k) => _ = dup.insert(*id, *k),
      None => same.push(*id),
    }
  }
  if dup.is_empty() {
    return;
  }
  fn rewrite(o: &mut Object, dup: &BTreeMap<ObjectId, ObjectId>) {
    match o {
      Object::Reference(r) => *r = *dup.get(r).unwrap_or(r),
      Object::Array(a) => a.iter_mut().for_each(|o| rewrite(o, dup)),
      Object::Dictionary(d) => d.iter_mut().for_each(|(_, o)| rewrite(o, dup)),
      Object::Stream(s) => s.dict.iter_mut().for_each(|(_, o)| rewrite(o, dup)),
      _ => {}
    }
  }
  doc.objects.values_mut().for_each(|o| rewrite(o, &dup));
  doc.trailer.iter_mut().for_each(|(_, o)| rewrite(o, &dup));
  for id in dup.keys() {
    doc.objects.remove(id);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use lopdf::{dictionary, Document, Object, Stream};

  /// One page per entry of `images` (each its own stream object, drawn as
  /// /Im0), plus a big uncompressed text content stream so there's
  /// something to gain.
  fn doc_with_pages(images: &[Vec<u8>]) -> Document {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let kids: Vec<Object> = images
      .iter()
      .map(|px| {
        let img = doc.add_object(Stream::new(
          dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
          px.clone(),
        ));
        let text = "BT /F1 12 Tf 72 720 Td (Hello hello hello) Tj ET\n".repeat(50);
        let content = doc.add_object(Stream::new(dictionary! {}, format!("q 100 0 0 100 0 0 cm /Im0 Do Q\n{text}").into_bytes()));
        doc.add_object(dictionary! {
          "Type" => "Page", "Parent" => pages_id, "Contents" => content,
          "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
          "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => img } },
        })
        .into()
      })
      .collect();
    let count = kids.len() as i64;
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc
  }

  fn bytes(doc: &mut Document) -> Vec<u8> {
    let mut v = vec![];
    doc.save_to(&mut v).unwrap();
    v
  }

  fn run(src: &[u8]) -> Outcome {
    compress(src, &AtomicBool::new(false), &|_| {}).unwrap()
  }

  fn images(doc: &Document) -> usize {
    doc.objects.values().filter(|o| matches!(o, Object::Stream(s) if s.dict.get(b"Subtype").and_then(|n| n.as_name()).ok() == Some(b"Image"))).count()
  }

  #[test]
  fn identical_streams_are_stored_once() {
    let src = bytes(&mut doc_with_pages(&[vec![7; 16], vec![7; 16], vec![9; 16]]));
    let out = run(&src);
    assert!(!out.not_smaller);
    let doc = Document::load_mem(&out.bytes).unwrap();
    assert_eq!(doc.get_pages().len(), 3);
    assert_eq!(images(&doc), 2);
    let first = *doc.get_pages().values().next().unwrap();
    assert!(String::from_utf8_lossy(&doc.get_page_content(first)).contains("(Hello hello hello) Tj"));
  }

  #[test]
  fn page_thumbnails_and_piece_info_are_removed() {
    let mut doc = doc_with_pages(&[vec![1; 16]]);
    let thumb = doc.add_object(Stream::new(
      dictionary! { "Subtype" => "Image", "Width" => 4, "Height" => 4, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
      vec![5; 16],
    ));
    let page = *doc.get_pages().values().next().unwrap();
    let d = doc.get_dictionary_mut(page).unwrap();
    d.set("Thumb", thumb);
    d.set("PieceInfo", dictionary! { "Illustrator" => dictionary! { "Private" => Object::string_literal("x".repeat(500)) } });
    let out = run(&bytes(&mut doc));
    let doc = Document::load_mem(&out.bytes).unwrap();
    let page = doc.get_dictionary(*doc.get_pages().values().next().unwrap()).unwrap();
    assert!(!page.has(b"Thumb") && !page.has(b"PieceInfo"));
    assert_eq!(images(&doc), 1); // the thumbnail object itself is gone too
  }

  #[test]
  fn already_compressed_input_comes_back_unchanged_as_not_smaller() {
    let once = run(&bytes(&mut doc_with_pages(&[vec![1; 16], vec![2; 16]])));
    assert!(!once.not_smaller);
    let twice = run(&once.bytes);
    assert!(twice.not_smaller);
    assert_eq!(twice.bytes, once.bytes);
  }

  #[test]
  fn cancel_stops_with_an_error() {
    let src = bytes(&mut doc_with_pages(&[vec![1; 16]]));
    assert!(compress(&src, &AtomicBool::new(true), &|_| {}).is_err());
  }

  #[test]
  fn progress_ends_at_100() {
    let last = std::cell::Cell::new(0.0);
    run_with_progress(&bytes(&mut doc_with_pages(&[vec![1; 16]])), &|p| last.set(p));
    assert_eq!(last.get(), 100.0);
  }

  fn run_with_progress(src: &[u8], p: &dyn Fn(f64)) {
    compress(src, &AtomicBool::new(false), p).unwrap();
  }

  #[test]
  fn garbage_is_an_error() {
    assert!(compress(b"not a pdf", &AtomicBool::new(false), &|_| {}).is_err());
  }

  #[test]
  fn encrypted_pdfs_are_detected_for_the_qpdf_route() {
    let mut doc = doc_with_pages(&[vec![1; 16]]);
    assert!(!is_encrypted(&bytes(&mut doc)));
    let enc = doc.add_object(dictionary! { "Filter" => "Standard", "V" => 2, "R" => 3 });
    doc.trailer.set("Encrypt", enc);
    assert!(is_encrypted(&bytes(&mut doc)));
  }
}
