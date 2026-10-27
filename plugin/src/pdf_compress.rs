//! Built-in PDF compressor (no sidecar): PDF bytes in, smaller PDF bytes out.
//! Pure function so the job runner, cargo tests and (ticket 04) a
//! Ghostscript best-of can all call it.
//!
//! Passes: drop page thumbnails and `PieceInfo`, downsample / re-encode
//! images by level, re-Flate every stream at level 9 (kept only when
//! smaller), store byte-identical streams once, prune unreachable objects.
//! Never returns something bigger than the input.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};

use image::codecs::jpeg::JpegEncoder;
use image::{imageops::FilterType, DynamicImage, ExtendedColorType, ImageBuffer, ImageEncoder};
use lopdf::{Document, LoadOptions, Object, ObjectId, Stream};

/// Any single stream may decode to at most this (decompression bombs).
const MAX_DECODED: usize = 512 * 1024 * 1024;

pub struct Outcome {
  /// The compressed PDF, or a copy of the input when `not_smaller`.
  pub bytes: Vec<u8>,
  /// Nothing came out smaller than the input: `bytes` is the input.
  pub not_smaller: bool,
}

/// `level` is the PDF setting (`screen` / `ebook` / `printer`; anything
/// else is `ebook`). `cancel` is polled between streams (returns `Err` once
/// set); `progress` gets 0..=100 by images processed. Encrypted input is an
/// error: callers route it to qpdf, because lopdf silently decrypts
/// owner-password-only files on load.
pub fn compress(src: &[u8], level: &str, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<Outcome, String> {
  let options = LoadOptions { max_decompressed_size: Some(MAX_DECODED), ..Default::default() };
  let mut doc = Document::load_mem_with_options(src, options).map_err(|e| format!("not a readable PDF: {e}"))?;
  if doc.is_encrypted() || doc.was_encrypted() {
    return Err("encrypted PDF (use qpdf)".into());
  }
  strip_private_data(&mut doc);

  // (max dpi, JPEG quality): Ghostscript's /screen, /ebook, /printer dpi.
  let (dpi, quality) = match level {
    "screen" => (72.0, 55),
    "printer" => (300.0, 85),
    _ => (150.0, 65),
  };
  let (shown, page) = (display_sizes(&doc), page_size(&doc));
  // Soft masks are resized with their image, never on their own.
  let all: Vec<_> = doc.objects.iter().filter_map(|(id, o)| Some((*id, o.as_stream().ok()?))).collect();
  let smasks: HashSet<ObjectId> = all.iter().filter_map(|(_, s)| s.dict.get(b"SMask").ok()?.as_reference().ok()).collect();
  let images: Vec<ObjectId> =
    all.iter().filter(|(id, s)| !smasks.contains(id) && s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")).map(|(id, _)| *id).collect();
  let ids: Vec<ObjectId> = all.iter().map(|(id, _)| *id).collect();
  for (i, id) in images.iter().enumerate() {
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    for (id, s) in shrink(&doc, *id, shown.get(id).copied().unwrap_or(page), dpi, quality).unwrap_or_default() {
      doc.objects.insert(id, Object::Stream(s));
    }
    progress((i + 1) as f64 * 100.0 / images.len() as f64);
  }
  for id in ids {
    if cancel.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    if let Some(Object::Stream(s)) = doc.objects.get_mut(&id) {
      reflate(s);
    }
  }
  if images.is_empty() {
    progress(100.0);
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

/// The replacement for image `id` (and its soft mask) drawn at most `shown`
/// points large: downsampled to `dpi` when above 1.5x that, then JPEG, or
/// lossless Flate for 256 colors (16 gray levels) or fewer. `None` keeps it as it is: not
/// 8-bit Gray / RGB / ICCBased N=1,3 in DCT / Flate / no filter, has a
/// Mask or Decode array, or the result isn't smaller (an unresized JPEG must
/// save 10%).
fn shrink(doc: &Document, id: ObjectId, shown: (f64, f64), dpi: f64, quality: u8) -> Option<Vec<(ObjectId, Stream)>> {
  let s = doc.get_object(id).ok()?.as_stream().ok()?;
  let d = &s.dict;
  if d.get(b"BitsPerComponent").ok()?.as_i64().ok()? != 8 || d.get(b"ImageMask").and_then(Object::as_bool).ok() == Some(true) || d.has(b"Mask") || d.has(b"Decode") {
    return None;
  }
  let n = match deref(doc, d.get(b"ColorSpace").ok()?)? {
    Object::Name(c) if c == b"DeviceGray" => 1,
    Object::Name(c) if c == b"DeviceRGB" => 3,
    Object::Array(a) if a.first().and_then(|c| c.as_name().ok()) == Some(b"ICCBased") => {
      match deref(doc, a.get(1)?)?.as_stream().ok()?.dict.get(b"N").ok()?.as_i64().ok()? {
        n @ (1 | 3) => n as u8,
        _ => return None,
      }
    }
    _ => return None,
  };
  let (w, h) = size(s)?;
  let filters = s.filters().unwrap_or_default();
  let jpeg_in = filters == [b"DCTDecode"];
  let raw = if jpeg_in && !d.has(b"DecodeParms") {
    let img = image::load_from_memory_with_format(&s.content, image::ImageFormat::Jpeg).ok()?;
    if img.color().channel_count() != n {
      return None;
    }
    img.into_bytes()
  } else if filters.iter().all(|f| *f == b"FlateDecode") {
    decoded(s)?
  } else {
    return None;
  };
  if raw.len() as u64 != w as u64 * h as u64 * n as u64 {
    return None;
  }

  let res = (w as f64 * 72.0 / shown.0).min(h as f64 * 72.0 / shown.1);
  let k = if res.is_finite() && res > dpi * 1.5 { dpi / res } else { 1.0 };
  let (nw, nh) = (scale(w, k), scale(h, k));
  let resized = (nw, nh) != (w, h);
  // ponytail: an 8-bit gray image never has more than 256 levels, so for
  // gray "few colors" means line art / text (16 levels); a gray scan is a photo.
  let few_colors = {
    let (mut seen, max) = (HashSet::new(), if n == 1 { 16 } else { 256 });
    raw.chunks(n as usize).all(|px| {
      seen.insert(px);
      seen.len() <= max
    })
  };
  if !resized && few_colors {
    return None; // lossless already: reflate's job
  }
  let px = resize(raw, n, (w, h), (nw, nh))?;
  let mut new = s.clone();
  new.dict.remove(b"DecodeParms");
  new.dict.set("Width", nw as i64);
  new.dict.set("Height", nh as i64);
  if few_colors {
    new.set_plain_content(px);
    new.compress().ok()?;
  } else {
    let mut jpeg = vec![];
    let color = if n == 1 { ExtendedColorType::L8 } else { ExtendedColorType::Rgb8 };
    JpegEncoder::new_with_quality(&mut jpeg, quality).write_image(&px, nw, nh, color).ok()?;
    new.dict.set("Filter", "DCTDecode");
    new.set_content(jpeg);
  }
  let budget = if jpeg_in && !resized { s.content.len() * 9 / 10 } else { s.content.len() };
  if new.content.len() >= budget {
    return None;
  }
  let mut out = vec![(id, new)];
  if let (true, Ok(mask)) = (resized, d.get(b"SMask").and_then(Object::as_reference)) {
    out.push((mask, scale_smask(doc.get_object(mask).ok()?.as_stream().ok()?, k)?));
  }
  Some(out)
}

/// A soft mask scaled by `k`, kept lossless (Flate). `None` (so the image
/// isn't resized either) unless it's plain 8-bit gray.
fn scale_smask(s: &Stream, k: f64) -> Option<Stream> {
  let (w, h) = size(s)?;
  if s.dict.get(b"BitsPerComponent").and_then(Object::as_i64).ok() != Some(8) || s.dict.has(b"Decode") || !s.filters().unwrap_or_default().iter().all(|f| *f == b"FlateDecode") {
    return None;
  }
  let raw = decoded(s).filter(|r| r.len() as u64 == w as u64 * h as u64)?;
  let (nw, nh) = (scale(w, k), scale(h, k));
  let mut new = s.clone();
  new.dict.remove(b"DecodeParms");
  new.dict.set("Width", nw as i64);
  new.dict.set("Height", nh as i64);
  new.set_plain_content(resize(raw, 1, (w, h), (nw, nh))?);
  new.compress().ok()?;
  Some(new)
}

fn scale(v: u32, k: f64) -> u32 {
  ((v as f64 * k).round() as u32).max(1)
}

fn size(s: &Stream) -> Option<(u32, u32)> {
  let int = |k: &[u8]| s.dict.get(k).ok()?.as_i64().ok().and_then(|v| u32::try_from(v).ok()).filter(|v| *v > 0);
  Some((int(b"Width")?, int(b"Height")?))
}

/// Lanczos resize of 8-bit samples with `n` (1 or 3) channels.
fn resize(raw: Vec<u8>, n: u8, (w, h): (u32, u32), (nw, nh): (u32, u32)) -> Option<Vec<u8>> {
  if (w, h) == (nw, nh) {
    return Some(raw);
  }
  let img = if n == 1 { DynamicImage::ImageLuma8(ImageBuffer::from_raw(w, h, raw)?) } else { DynamicImage::ImageRgb8(ImageBuffer::from_raw(w, h, raw)?) };
  Some(img.resize_exact(nw, nh, FilterType::Lanczos3).into_bytes())
}

type Matrix = [f64; 6];
const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` then `b` (PDF row-vector order: `a × b`).
fn mul(a: Matrix, b: Matrix) -> Matrix {
  [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

fn numbers(o: Option<&Object>) -> Vec<f64> {
  o.and_then(|o| o.as_array().ok()).map(|a| a.iter().filter_map(|n| n.as_float().ok()).map(f64::from).collect()).unwrap_or_default()
}

fn matrix(o: Option<&Object>) -> Matrix {
  numbers(o).try_into().unwrap_or(IDENTITY)
}

fn deref<'a>(doc: &'a Document, o: &'a Object) -> Option<&'a Object> {
  doc.dereference(o).ok().map(|(_, o)| o)
}

fn decoded(s: &Stream) -> Option<Vec<u8>> {
  if s.dict.has(b"Filter") { s.decompressed_content_with_limit(MAX_DECODED).ok() } else { Some(s.content.clone()) }
}

/// Largest size (points, width x height) each image XObject is drawn at, by
/// walking `q`/`Q`/`cm`/`Do` through pages, form XObjects and annotation
/// appearances. Images missing here weren't found (patterns, Type3 fonts,
/// unreferenced): callers assume they fill the page.
fn display_sizes(doc: &Document) -> HashMap<ObjectId, (f64, f64)> {
  let mut sizes = HashMap::new();
  for page in doc.get_pages().into_values() {
    let Ok((inline, ids)) = doc.get_page_resources(page) else { continue };
    let res: Vec<&lopdf::Dictionary> = inline.into_iter().chain(ids.iter().filter_map(|id| doc.get_dictionary(*id).ok())).collect();
    let content = doc.get_page_content_with_limit(page, MAX_DECODED).unwrap_or_default();
    walk(doc, &content, &res, IDENTITY, 0, &mut sizes);
    let annots = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Annots").ok()).and_then(|a| deref(doc, a)).and_then(|a| a.as_array().ok());
    for annot in annots.into_iter().flatten().filter_map(|a| deref(doc, a)?.as_dict().ok()) {
      let rect = numbers(annot.get(b"Rect").ok());
      // /AP /N is a form, or a dictionary of forms by appearance state.
      let Some(normal) = annot.get(b"AP").ok().and_then(|ap| deref(doc, ap)?.as_dict().ok()?.get(b"N").ok()) else { continue };
      let forms: Vec<&Object> = match deref(doc, normal) {
        Some(Object::Dictionary(d)) => d.iter().map(|(_, o)| o).collect(),
        _ => vec![normal],
      };
      for form in forms.into_iter().filter_map(|f| deref(doc, f)?.as_stream().ok()) {
        let (Some(bbox), true) = (bounds(numbers(form.dict.get(b"BBox").ok()), matrix(form.dict.get(b"Matrix").ok())), rect.len() == 4) else { continue };
        // The appearance's transformed BBox is stretched onto Rect.
        let (sx, sy) = ((rect[2] - rect[0]).abs() / (bbox.2 - bbox.0), (rect[3] - rect[1]).abs() / (bbox.3 - bbox.1));
        if sx.is_finite() && sy.is_finite() {
          form_xobject(doc, form, &[], [sx, 0.0, 0.0, sy, 0.0, 0.0], 0, &mut sizes);
        }
      }
    }
  }
  sizes
}

/// `bbox` mapped through `m`, as (x0, y0, x1, y1).
fn bounds(bbox: Vec<f64>, m: Matrix) -> Option<(f64, f64, f64, f64)> {
  let [x0, y0, x1, y1] = bbox.try_into().ok()?;
  let pts = [(x0, y0), (x0, y1), (x1, y0), (x1, y1)].map(|(x, y)| (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]));
  let xs = pts.map(|p| p.0);
  let ys = pts.map(|p| p.1);
  let (min, max) = (|v: [f64; 4]| v.into_iter().fold(f64::MAX, f64::min), |v: [f64; 4]| v.into_iter().fold(f64::MIN, f64::max));
  Some((min(xs), min(ys), max(xs), max(ys)))
}

/// Draws a form XObject under `ctm`: its own /Resources, else the caller's.
fn form_xobject(doc: &Document, form: &Stream, outer: &[&lopdf::Dictionary], ctm: Matrix, depth: u8, sizes: &mut HashMap<ObjectId, (f64, f64)>) {
  let own = form.dict.get(b"Resources").ok().and_then(|r| deref(doc, r)?.as_dict().ok());
  let res: Vec<&lopdf::Dictionary> = own.map_or_else(|| outer.to_vec(), |d| vec![d]);
  let Some(content) = decoded(form) else { return };
  walk(doc, &content, &res, mul(matrix(form.dict.get(b"Matrix").ok()), ctm), depth + 1, sizes);
}

fn walk(doc: &Document, content: &[u8], res: &[&lopdf::Dictionary], ctm: Matrix, depth: u8, sizes: &mut HashMap<ObjectId, (f64, f64)>) {
  // ponytail: depth cap instead of cycle tracking; forms nest a few levels.
  if depth > 12 {
    return;
  }
  let Ok(ops) = lopdf::content::Content::decode(content) else { return };
  let (mut ctm, mut stack) = (ctm, vec![]);
  for op in ops.operations {
    match op.operator.as_str() {
      "q" => stack.push(ctm),
      "Q" => ctm = stack.pop().unwrap_or(ctm),
      "cm" => {
        if let Ok(m) = <Matrix>::try_from(op.operands.iter().filter_map(|n| n.as_float().ok()).map(f64::from).collect::<Vec<_>>()) {
          ctm = mul(m, ctm);
        }
      }
      "Do" => {
        let Some(name) = op.operands.first().and_then(|n| n.as_name().ok()) else { continue };
        let found = res.iter().find_map(|r| deref(doc, r.get(b"XObject").ok()?)?.as_dict().ok()?.get(name).ok()?.as_reference().ok());
        let Some(id) = found else { continue };
        let Ok(s) = doc.get_object(id).and_then(Object::as_stream) else { continue };
        match s.dict.get(b"Subtype").and_then(Object::as_name) {
          Ok(b"Image") => {
            // The unit square under the CTM: its two edge lengths.
            let (w, h) = ((ctm[0] * ctm[0] + ctm[1] * ctm[1]).sqrt(), (ctm[2] * ctm[2] + ctm[3] * ctm[3]).sqrt());
            let e = sizes.entry(id).or_insert((0.0, 0.0));
            *e = (e.0.max(w), e.1.max(h));
          }
          Ok(b"Form") => form_xobject(doc, s, res, ctm, depth, sizes),
          _ => {}
        }
      }
      _ => {}
    }
  }
}

/// Largest page (points) in the document, for images we couldn't track.
fn page_size(doc: &Document) -> (f64, f64) {
  doc.get_pages().into_values().fold((0.0, 0.0), |acc, page| {
    let b = doc.get_dictionary(page).ok().and_then(|d| d.get(b"MediaBox").ok()).map(|m| numbers(Some(m))).unwrap_or_default();
    match b[..] {
      [x0, y0, x1, y1] => (acc.0.max((x1 - x0).abs()), acc.1.max((y1 - y0).abs())),
      _ => acc,
    }
  })
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
    compress(src, "ebook", &AtomicBool::new(false), &|_| {}).unwrap()
  }

  fn images(doc: &Document) -> usize {
    doc.objects.values().filter(|o| matches!(o, Object::Stream(s) if s.dict.get(b"Subtype").and_then(|n| n.as_name()).ok() == Some(b"Image"))).count()
  }

  /// A one-page (612x792) doc drawing `content`. Returns (doc, page id).
  fn page_doc(content: &str) -> (Document, ObjectId) {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let content = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let page = doc.add_object(dictionary! {
      "Type" => "Page", "Parent" => pages_id, "Contents" => content,
      "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
      "Resources" => dictionary! {},
    });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    (doc, page)
  }

  fn set_xobjects(doc: &mut Document, page: ObjectId, xobjects: lopdf::Dictionary) {
    let res = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").unwrap().as_dict_mut().unwrap();
    res.set("XObject", xobjects);
  }

  fn gray(doc: &mut Document) -> ObjectId {
    doc.add_object(Stream::new(
      dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
      vec![0; 16],
    ))
  }

  #[test]
  fn display_size_follows_nested_cm_and_keeps_the_largest_use() {
    let (mut doc, page) = page_doc("q 2 0 0 2 0 0 cm q 100 0 0 50 0 0 cm /Im0 Do Q Q q 10 0 0 10 0 0 cm /Im0 Do Q");
    let im = gray(&mut doc);
    set_xobjects(&mut doc, page, dictionary! { "Im0" => im });
    assert_eq!(display_sizes(&doc)[&im], (200.0, 100.0));
  }

  #[test]
  fn display_size_goes_through_form_xobjects_and_their_matrix() {
    let (mut doc, page) = page_doc("q 3 0 0 3 0 0 cm /Fm0 Do Q");
    let im = gray(&mut doc);
    let form = doc.add_object(Stream::new(
      dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        "Matrix" => vec![2.into(), 0.into(), 0.into(), 2.into(), 0.into(), 0.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im1" => im } } },
      b"q 10 0 0 20 0 0 cm /Im1 Do Q".to_vec(),
    ));
    set_xobjects(&mut doc, page, dictionary! { "Fm0" => form });
    assert_eq!(display_sizes(&doc)[&im], (60.0, 120.0));
  }

  #[test]
  fn display_size_includes_annotation_appearances_and_unused_images_get_the_page() {
    let (mut doc, page) = page_doc("");
    let (im, stray) = (gray(&mut doc), gray(&mut doc));
    let ap = doc.add_object(Stream::new(
      dictionary! { "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => im } } },
      b"10 0 0 10 0 0 cm /Im0 Do".to_vec(),
    ));
    let annot = doc.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Stamp",
      "Rect" => vec![100.into(), 100.into(), 150.into(), 200.into()], "AP" => dictionary! { "N" => ap } });
    doc.get_dictionary_mut(page).unwrap().set("Annots", vec![annot.into()]);
    let sizes = display_sizes(&doc);
    assert_eq!(sizes[&im], (50.0, 100.0)); // BBox 10x10 stretched onto the 50x100 Rect
    assert!(!sizes.contains_key(&stray));
    assert_eq!(page_size(&doc), (612.0, 792.0));
  }

  /// A ramp plus noise: a photo (well over 256 colors / 16 gray levels),
  /// still compressible enough for Flate.
  fn photo(w: u32, h: u32, n: u32) -> Vec<u8> {
    let mut x: u32 = 1;
    (0..w * h * n)
      .map(|i| {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
        ((i / n) % 240) as u8 + ((x >> 16) as u8 & 15)
      })
      .collect()
  }

  /// One page drawing image `dict` (+ Width/Height, Type, Subtype) with
  /// `data` at `pt` x `pt` points. Returns (pdf bytes, image id).
  fn image_pdf(mut dict: lopdf::Dictionary, w: u32, h: u32, data: Vec<u8>, pt: u32) -> (Vec<u8>, ObjectId) {
    let (mut doc, page) = page_doc(&format!("q {pt} 0 0 {pt} 0 0 cm /Im0 Do Q"));
    for (k, v) in [("Type", "XObject"), ("Subtype", "Image")] {
      dict.set(k, v);
    }
    dict.set("Width", w as i64);
    dict.set("Height", h as i64);
    let im = doc.add_object(Stream::new(dict, data));
    set_xobjects(&mut doc, page, dictionary! { "Im0" => im });
    (bytes(&mut doc), im)
  }

  fn rgb() -> lopdf::Dictionary {
    dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }
  }

  /// The (only) image stream after compressing at `level`.
  fn image_after(src: &[u8], level: &str) -> Stream {
    let out = compress(src, level, &AtomicBool::new(false), &|_| {}).unwrap();
    let doc = Document::load_mem(&out.bytes).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    let (res, _) = doc.get_page_resources(page).unwrap();
    let id = res.unwrap().get(b"XObject").unwrap().as_dict().unwrap().get(b"Im0").unwrap().as_reference().unwrap();
    doc.get_object(id).unwrap().as_stream().unwrap().clone()
  }

  fn dim(s: &Stream) -> (i64, i64) {
    (s.dict.get(b"Width").unwrap().as_i64().unwrap(), s.dict.get(b"Height").unwrap().as_i64().unwrap())
  }

  fn filter(s: &Stream) -> Vec<u8> {
    s.filters().unwrap_or_default().concat()
  }

  #[test]
  fn photo_above_the_level_is_downsampled_to_jpeg_at_its_dpi() {
    // 600 px drawn over 72 pt = 600 dpi.
    let (src, _) = image_pdf(rgb(), 600, 600, photo(600, 600, 3), 72);
    for (level, px) in [("screen", 72), ("ebook", 150), ("printer", 300)] {
      let im = image_after(&src, level);
      assert_eq!(dim(&im), (px, px), "{level}");
      assert_eq!(filter(&im), b"DCTDecode");
    }
  }

  #[test]
  fn images_up_to_one_and_a_half_times_the_level_keep_their_size() {
    // 220 dpi at ebook (150 dpi): under the 225 dpi threshold.
    let (src, _) = image_pdf(rgb(), 220, 220, photo(220, 220, 3), 72);
    assert_eq!(dim(&image_after(&src, "ebook")), (220, 220));
  }

  fn zlib(data: Vec<u8>) -> Vec<u8> {
    let mut s = Stream::new(dictionary! {}, data);
    s.compress().unwrap();
    s.content
  }

  fn jpeg(px: &[u8], w: u32, h: u32, q: u8) -> Vec<u8> {
    let mut out = vec![];
    JpegEncoder::new_with_quality(&mut out, q).write_image(px, w, h, ExtendedColorType::L8).unwrap();
    out
  }

  #[test]
  fn unsupported_images_are_kept_as_they_are() {
    let cases: Vec<(&str, lopdf::Dictionary, Vec<u8>)> = vec![
      ("cmyk", dictionary! { "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8 }, photo(600, 600, 4)),
      ("1-bit", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1 }, photo(600, 75, 1)),
      ("16-bit", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 16 }, photo(600, 600, 2)),
      ("mask", dictionary! { "ImageMask" => true, "BitsPerComponent" => 1 }, photo(600, 75, 1)),
      ("indexed", dictionary! { "ColorSpace" => vec!["Indexed".into(), "DeviceGray".into(), 255.into(), Object::String((0..=255).collect(), lopdf::StringFormat::Hexadecimal)], "BitsPerComponent" => 8 }, photo(600, 600, 1)),
      ("jpx", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "JPXDecode" }, photo(100, 100, 1)),
      ("jbig2", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1, "Filter" => "JBIG2Decode" }, photo(100, 100, 1)),
      ("ccitt", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1, "Filter" => "CCITTFaxDecode" }, photo(100, 100, 1)),
      ("color-key", dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Mask" => vec![0.into(), 10.into()] }, photo(600, 600, 1)),
    ];
    for (name, dict, data) in cases {
      let (src, _) = image_pdf(dict, 600, 600, data, 72);
      let im = image_after(&src, "screen");
      assert_eq!(dim(&im), (600, 600), "{name}");
      assert_ne!(filter(&im), b"DCTDecode", "{name}");
    }
  }

  #[test]
  fn icc_rgb_flate_with_png_predictor_is_processed() {
    let icc = Stream::new(dictionary! { "N" => 3 }, vec![0; 16]);
    let (mut doc, page) = page_doc("q 72 0 0 72 0 0 cm /Im0 Do Q");
    let icc = doc.add_object(icc);
    // PNG "None" predictor: a 0 byte before every row.
    let rows: Vec<u8> = photo(600, 600, 3).chunks(1800).flat_map(|r| std::iter::once(0).chain(r.iter().copied())).collect();
    let im = doc.add_object(Stream::new(
      dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 600, "Height" => 600, "BitsPerComponent" => 8,
        "ColorSpace" => vec!["ICCBased".into(), icc.into()], "Filter" => "FlateDecode",
        "DecodeParms" => dictionary! { "Predictor" => 15, "Colors" => 3, "Columns" => 600 } },
      zlib(rows),
    ));
    set_xobjects(&mut doc, page, dictionary! { "Im0" => im });
    let im = image_after(&bytes(&mut doc), "ebook");
    assert_eq!((dim(&im), filter(&im)), ((150, 150), b"DCTDecode".to_vec()));
    assert!(!im.dict.has(b"DecodeParms"));
  }

  #[test]
  fn up_to_256_colors_stay_lossless_flate() {
    let px: Vec<u8> = (0..600 * 600).map(|i| if (i / 600 + i % 600) % 50 < 25 { 0 } else { 255 }).collect();
    let (src, _) = image_pdf(dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, 600, 600, px, 72);
    let im = image_after(&src, "ebook");
    assert_eq!((dim(&im), filter(&im)), ((150, 150), b"FlateDecode".to_vec()));
  }

  #[test]
  fn soft_mask_is_scaled_with_its_image_and_stays_lossless() {
    let (mut doc, page) = page_doc("q 72 0 0 72 0 0 cm /Im0 Do Q");
    let mask = doc.add_object(Stream::new(
      dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 600, "Height" => 600, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
      photo(600, 600, 1),
    ));
    let im = doc.add_object(Stream::new(
      dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 600, "Height" => 600, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "SMask" => mask },
      photo(600, 600, 3),
    ));
    set_xobjects(&mut doc, page, dictionary! { "Im0" => im });
    let out = compress(&bytes(&mut doc), "ebook", &AtomicBool::new(false), &|_| {}).unwrap();
    let doc = Document::load_mem(&out.bytes).unwrap();
    let im = doc.get_object(im).unwrap().as_stream().unwrap();
    let mask = doc.get_object(im.dict.get(b"SMask").unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
    assert_eq!((dim(im), filter(im)), ((150, 150), b"DCTDecode".to_vec()));
    assert_eq!((dim(mask), filter(mask)), ((150, 150), b"FlateDecode".to_vec()));
  }

  #[test]
  fn gray_jpeg_is_downsampled_and_unresized_jpeg_needs_ten_percent() {
    let (src, _) = image_pdf(dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "DCTDecode" }, 600, 600, jpeg(&photo(600, 600, 1), 600, 600, 95), 72);
    assert_eq!(dim(&image_after(&src, "screen")), (72, 72));
    // 200 dpi at printer: not resized. q30 -> q85 would grow: kept byte for byte.
    let low = jpeg(&photo(200, 200, 1), 200, 200, 30);
    let (src, _) = image_pdf(dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "DCTDecode" }, 200, 200, low.clone(), 72);
    assert_eq!(image_after(&src, "printer").content, low);
    // q100 -> q85 saves well over 10%: re-encoded.
    let high = jpeg(&photo(200, 200, 1), 200, 200, 100);
    let (src, _) = image_pdf(dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "DCTDecode" }, 200, 200, high.clone(), 72);
    let im = image_after(&src, "printer");
    assert!(im.content.len() < high.len() * 9 / 10);
    assert_eq!(dim(&im), (200, 200));
  }

  #[test]
  fn progress_counts_images() {
    let seen = std::cell::RefCell::new(vec![]);
    let src = bytes(&mut doc_with_pages(&[vec![1; 16], vec![2; 16], vec![3; 16], vec![4; 16]]));
    compress(&src, "ebook", &AtomicBool::new(false), &|p| seen.borrow_mut().push(p)).unwrap();
    assert_eq!(*seen.borrow(), [25.0, 50.0, 75.0, 100.0]);
  }

  /// tests/fixtures/scan.pdf: one A4 page, a 2480x3508 (300 dpi) RGB JPEG
  /// from img2pdf (`ffmpeg -f lavfi -i testsrc2=size=2480x3508 -frames:v 1
  /// -q:v 3 page.jpg && img2pdf --pagesize A4 page.jpg -o scan.pdf`).
  #[test]
  fn scanned_pdf_shrinks_by_half_at_balanced_and_by_level() {
    let src = include_bytes!("../tests/fixtures/scan.pdf");
    let size = |level| {
      let out = compress(src, level, &AtomicBool::new(false), &|_| {}).unwrap();
      assert_eq!(Document::load_mem(&out.bytes).unwrap().get_pages().len(), 1);
      out.bytes.len()
    };
    let (smallest, balanced, high) = (size("screen"), size("ebook"), size("printer"));
    println!("scan.pdf {} -> screen {smallest}, ebook {balanced}, printer {high}", src.len());
    assert!(balanced * 2 <= src.len());
    assert!(smallest < balanced && balanced < high);
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
    assert!(compress(&src, "ebook", &AtomicBool::new(true), &|_| {}).is_err());
  }

  #[test]
  fn progress_ends_at_100() {
    let last = std::cell::Cell::new(0.0);
    run_with_progress(&bytes(&mut doc_with_pages(&[vec![1; 16]])), &|p| last.set(p));
    assert_eq!(last.get(), 100.0);
  }

  fn run_with_progress(src: &[u8], p: &dyn Fn(f64)) {
    compress(src, "ebook", &AtomicBool::new(false), p).unwrap();
  }

  #[test]
  fn garbage_is_an_error() {
    assert!(compress(b"not a pdf", "ebook", &AtomicBool::new(false), &|_| {}).is_err());
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
