// Extracted unchanged (logic-for-logic) from resources/js/main.js's execute
// handler. Framework-agnostic strangler-fig seam: the future React port
// imports these unchanged — see design-system/MASTER.md do-not-touch list.
// Do NOT alter the string-building here without a dedicated CLAUDE.md review;
// these must stay byte-identical to pre-migration output.
(function (global) {
  // fileObj: { fps, duration, size, trimStart, trimEnd } (subset of the app's file record)
  function buildVideoCommand({ binPath, file, outPath, format, codec, qualityPercent, speed, targetFpsStr, fileObj }) {
    const targetFps = targetFpsStr === 'original' ? fileObj.fps : parseFloat(targetFpsStr);
    const fps = targetFpsStr;

    let trimCmd = '';
    if (fileObj.trimStart !== undefined) trimCmd += `-ss ${fileObj.trimStart} `;
    if (fileObj.trimEnd !== undefined) trimCmd += `-to ${fileObj.trimEnd} `;

    if (format === '.gif') {
      let filterGraph = [];
      if (targetFps) filterGraph.push(`fps=${targetFps}`);

      const speedFloat = parseFloat(speed);
      if (speedFloat !== 1.0) filterGraph.push(`setpts=${1 / speedFloat}*PTS`);

      let scaleFactor = qualityPercent / 100;
      if (scaleFactor < 1.0) {
        filterGraph.push(`scale=trunc(iw*${scaleFactor}/2)*2:-2:flags=lanczos`);
      }

      let preFilters = filterGraph.length > 0 ? filterGraph.join(',') + ',' : '';
      let fullFilter = `${preFilters}split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;

      return `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" -filter_complex "${fullFilter}" "${outPath}"`;
    }

    let fpsFactor = 1.0;
    if (targetFps && fileObj.fps) {
      fpsFactor = targetFps / fileObj.fps;
    }

    let targetBitrateCmd = '';
    if (fileObj.duration > 0) {
      const originalBitrateKbps = (fileObj.size * 8) / (fileObj.duration * 1024);
      const targetBitrateKbps = Math.max(10, Math.floor(originalBitrateKbps * (qualityPercent / 100) * fpsFactor));
      targetBitrateCmd = `-b:v ${targetBitrateKbps}k -bufsize ${targetBitrateKbps * 2}k`;
    } else {
      const crf = 51 - Math.round((qualityPercent / 100) * 51);
      targetBitrateCmd = `-crf ${crf}`;
    }

    let extraFilters = [];
    let audioFilters = [];

    if (fps !== 'original') {
      extraFilters.push(`fps=${fps}`);
    }

    if (speed !== '1.0' && speed !== '1') {
      const speedFloat = parseFloat(speed);
      const ptsRatio = 1 / speedFloat;
      extraFilters.push(`setpts=${ptsRatio}*PTS`);
      audioFilters.push(`atempo=${speedFloat}`);
    }

    let filterCmd = '';
    if (extraFilters.length > 0) {
      filterCmd += `-vf "${extraFilters.join(',')}" `;
    }
    if (audioFilters.length > 0) {
      filterCmd += `-af "${audioFilters.join(',')}" `;
    }

    return `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" -c:v ${codec} ${filterCmd}${targetBitrateCmd} "${outPath}"`;
  }

  function buildImageCommand({ binPath, file, outPath, format, quality, scale }) {
    let qCmd = '';
    let filterCmd = '';

    if (format === '.jpg' || format === '.jpeg') {
      let qv = Math.max(2, Math.min(31, 31 - Math.round((quality / 100) * 29)));
      qCmd = `-q:v ${qv}`;
    } else if (format === '.webp') {
      qCmd = `-q:v ${quality}`;
    }

    let scaleFilter = '';
    if (scale < 100) {
      let scaleFactor = scale / 100;
      scaleFilter = `scale=trunc(iw*${scaleFactor}/2)*2:-2:flags=lanczos`;
    }

    if (format === '.ico') {
      // ffmpeg's ico muxer hard-caps output at 256x256 -- anything larger
      // fails outright with "Unsupported dimensions" (confirmed against
      // the bundled binary). Always fit-within-256 regardless of the
      // scale slider, which is honored as an *additional* reduction
      // chained in front of the mandatory cap (unlike every other format,
      // where the scale filter only applies when scale < 100).
      const preScale = scaleFilter ? `${scaleFilter},` : '';
      filterCmd = `-vf "${preScale}scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease"`;
    } else if (format === '.png' && quality < 100) {
      let colors = Math.max(2, Math.floor(256 * (quality / 100)));
      if (scaleFilter) {
        filterCmd = `-filter_complex "[0:v]${scaleFilter}[s];[s]split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse"`;
      } else {
        filterCmd = `-filter_complex "[0:v]split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse"`;
      }
    } else if (scaleFilter) {
      filterCmd = `-vf "${scaleFilter}"`;
    }

    return `"${binPath}\\binaries\\ffmpeg.exe" -y -i "${file}" ${filterCmd} ${qCmd} "${outPath}"`;
  }

  // fileObj: { trimStart, trimEnd }
  function buildAudioCommand({ binPath, file, outPath, bitrate, speed, format, fileObj }) {
    let filterCmd = '';
    const speedFloat = parseFloat(speed);
    if (speedFloat !== 1.0) {
      filterCmd = `-af "atempo=${speedFloat}" `;
    }

    let trimCmd = '';
    if (fileObj.trimStart !== undefined) trimCmd += `-ss ${fileObj.trimStart} `;
    if (fileObj.trimEnd !== undefined) trimCmd += `-to ${fileObj.trimEnd} `;

    // Explicit rather than relying on ffmpeg's default muxer-implied encoder
    // choice for .ogg — every other format keeps codecCmd === '' (unchanged).
    const codecCmd = format === '.ogg' ? '-c:a libvorbis ' : '';

    return `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" ${filterCmd}${codecCmd}-b:a ${bitrate} "${outPath}"`;
  }

  global.EstellaLib = global.EstellaLib || {};
  global.EstellaLib.ffmpegCommands = { buildVideoCommand, buildImageCommand, buildAudioCommand };
})(window);
