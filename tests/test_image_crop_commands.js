// Node-only unit coverage for buildImageCommand's crop integration and
// estimateImageMB's crop area-ratio factor (resources/js/lib/ffmpeg-commands.js,
// resources/js/lib/size-estimate.js). No browser/neu needed — these are pure
// string/math functions, so this runs fast and deterministically, directly
// targeting the CLAUDE.md-flagged regression risks: crop-before-scale
// ordering, the PNG palettegen filter_complex branch, and the ICO
// mandatory-256-cap branch.
// Run with: node tests/test_image_crop_commands.js
// Exits 0 on success, 1 on any failure.

// resources/js/lib/*.js are written as `(function (global) {...})(window)`
// IIFEs that attach to `global.EstellaLib` — stubbing `window === global`
// (Node's implicit-global convention) lets them load unmodified under `require`.
global.window = global;
require('../resources/js/lib/ffmpeg-commands.js');
require('../resources/js/lib/size-estimate.js');
const { buildImageCommand } = global.EstellaLib.ffmpegCommands;
const { estimateImageMB } = global.EstellaLib.sizeEstimate;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra !== undefined ? '  -> ' + extra : ''}`);
}

const base = { binPath: 'C:\\App', file: 'C:\\in.jpg', outPath: 'C:\\out.jpg' };
const crop = { x: 10, y: 20, width: 300, height: 200 };

// ---- crop only, no scale (plain branch) ----
{
  const cmd = buildImageCommand({ ...base, format: '.jpg', quality: 85, scale: 100, crop });
  check('crop-only: -vf contains crop=W:H:X:Y', cmd.includes('-vf "crop=300:200:10:20"'), cmd);
  check('crop-only: no scale= filter emitted', !cmd.includes('scale='), cmd);
}

// ---- crop + scale (plain branch): crop must precede scale ----
{
  const cmd = buildImageCommand({ ...base, format: '.jpg', quality: 85, scale: 50, crop });
  const cropIdx = cmd.indexOf('crop=300:200:10:20');
  const scaleIdx = cmd.indexOf('scale=');
  check('crop+scale: both filters present', cropIdx !== -1 && scaleIdx !== -1, cmd);
  check('crop+scale: crop comes before scale', cropIdx !== -1 && scaleIdx !== -1 && cropIdx < scaleIdx, cmd);
  check('crop+scale: joined with a single -vf (comma-joined)', cmd.includes(`-vf "crop=300:200:10:20,scale=`), cmd);
}

// ---- no crop, scale only: unaffected by the crop param (regression guard) ----
{
  const cmd = buildImageCommand({ ...base, format: '.jpg', quality: 85, scale: 50, crop: undefined });
  check('no-crop: scale-only output unchanged (no crop= filter)', !cmd.includes('crop='), cmd);
  check('no-crop: still has -vf scale=', cmd.includes('-vf "scale='), cmd);
}

// ---- no crop, no scale: no -vf at all (regression guard) ----
{
  const cmd = buildImageCommand({ ...base, format: '.jpg', quality: 85, scale: 100, crop: undefined });
  check('no-crop/no-scale: no -vf emitted', !cmd.includes('-vf'), cmd);
}

// ---- PNG quality<100 (palettegen path) + crop: CLAUDE.md-flagged branch ----
{
  const cmd = buildImageCommand({ ...base, outPath: 'C:\\out.png', format: '.png', quality: 40, scale: 100, crop });
  check(
    'png+palettegen+crop: filter_complex opens with [0:v]crop=...[s]',
    cmd.includes('-filter_complex "[0:v]crop=300:200:10:20[s];[s]split[a][b];'),
    cmd
  );
  check('png+palettegen+crop: palettegen/paletteuse still present', cmd.includes('palettegen=max_colors=') && cmd.includes('paletteuse'), cmd);
}

// ---- PNG quality<100 + crop + scale: both filters folded into filter_complex, crop first ----
{
  const cmd = buildImageCommand({ ...base, outPath: 'C:\\out.png', format: '.png', quality: 40, scale: 50, crop });
  const cropIdx = cmd.indexOf('crop=300:200:10:20');
  const scaleIdx = cmd.indexOf('scale=');
  check('png+palettegen+crop+scale: crop precedes scale inside filter_complex', cropIdx !== -1 && scaleIdx !== -1 && cropIdx < scaleIdx, cmd);
  check('png+palettegen+crop+scale: single [0:v]...[s] chain (not two separate stages)', cmd.includes(`[0:v]crop=300:200:10:20,scale=`), cmd);
}

// ---- PNG quality<100, no crop: unaffected (regression guard for existing I7 behavior) ----
{
  const cmd = buildImageCommand({ ...base, outPath: 'C:\\out.png', format: '.png', quality: 40, scale: 100, crop: undefined });
  check('png+palettegen no-crop: falls back to the no-filter [0:v]split form', cmd.includes('-filter_complex "[0:v]split[a][b];'), cmd);
}

// ---- ICO output + crop: crop chains before the mandatory 256 cap ----
{
  const cmd = buildImageCommand({ ...base, outPath: 'C:\\out.ico', format: '.ico', quality: 40, scale: 100, crop });
  check(
    'ico+crop: crop chained before the mandatory min(256) cap',
    cmd.includes(`-vf "crop=300:200:10:20,scale='min(256,iw)'`),
    cmd
  );
  check('ico+crop: does not trigger palettegen', !cmd.includes('palettegen'), cmd);
}

// ---- ICO output + crop + scale slider: crop, then preScale, then mandatory cap ----
{
  const cmd = buildImageCommand({ ...base, outPath: 'C:\\out.ico', format: '.ico', quality: 100, scale: 50, crop });
  check(
    'ico+crop+scale: crop,preScale both precede the mandatory cap',
    /^"C:\\App\\binaries\\ffmpeg\.exe" -y -i "C:\\in\.jpg" -vf "crop=300:200:10:20,scale=trunc\(iw\*0\.5\/2\)\*2:-2:flags=lanczos,scale='min\(256,iw\)'/.test(cmd),
    cmd
  );
}

// ---- crop with zero width/height is treated as "no crop" (defensive) ----
{
  const cmd = buildImageCommand({ ...base, format: '.jpg', quality: 85, scale: 100, crop: { x: 0, y: 0, width: 0, height: 0 } });
  check('zero-size crop is ignored (no crop= filter)', !cmd.includes('crop='), cmd);
}

// ---- estimateImageMB: crop area ratio ----
{
  const noCrop = estimateImageMB({ currentSizeMB: 10, format: '.jpg', quality: 100, scale: 100, sourcePath: 'x.jpg' });
  const halfArea = estimateImageMB({ currentSizeMB: 10, format: '.jpg', quality: 100, scale: 100, sourcePath: 'x.jpg', cropAreaRatio: 0.5 });
  check('estimateImageMB: cropAreaRatio scales the estimate down proportionally', Math.abs(halfArea - noCrop * 0.5) < 1e-9, `${halfArea} vs ${noCrop * 0.5}`);
  check('estimateImageMB: omitted cropAreaRatio behaves as ratio 1 (regression guard)', noCrop === estimateImageMB({ currentSizeMB: 10, format: '.jpg', quality: 100, scale: 100, sourcePath: 'x.jpg', cropAreaRatio: undefined }));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
process.exit(failed.length ? 1 : 0);
