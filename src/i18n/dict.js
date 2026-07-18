// Converter's own UI copy -- flat key -> string (or key -> (params) => string
// for interpolated/pluralized entries) per language. See
// src/hooks/useTranslation.js and resources/js/lib/i18n.js for the
// mechanism this feeds.
//
// IMPORTANT: several `en` entries below are pinned to the EXACT wording the
// existing Playwright regression suites assert against (tests/test_
// conversion.js, test_crop_ui.js, test_drop.js) -- e.g. "Completed {n} of
// {m}!", "Cancelled {n} of {m}", "Start Processing", "Cancelling…",
// "Processing: {name} ({i}/{n})", "[Crop: {w}x{h}]", and the mixed-type
// modal needing the literal words "video"/"image" to appear. Do not
// "improve" these specific en entries without also updating the
// corresponding test assertions -- the default language is English and
// these tests run against it unmodified.
//
// alert()/native OS dialog title strings (useFileManager.js/useExecute.js)
// are intentionally NOT in this dict -- scope decision for this pass keeps
// those in English (see the plan: "visible UI only, alerts stay English").
export const dict = {
  en: {
    // App.jsx
    'app.readingFiles': 'Reading files…',
    'app.fileCount': ({ count, type }) => `${count} file${count !== 1 ? 's' : ''} · ${type}`,
    'app.addFiles': 'Add files',
    'app.clearAll': 'Clear all',

    // Shared file-type category names -- EN stays uppercase to match
    // today's fileType.toUpperCase() badge exactly.
    'fileType.video': 'VIDEO',
    'fileType.image': 'IMAGE',
    'fileType.audio': 'AUDIO',
    'fileType.pdf': 'PDF',

    // DropZone.jsx
    'dropZone.ariaLabel': 'Drop files here, or click to browse',
    'dropZone.title': 'Drop files here',
    'dropZone.hint': 'Video · Image · Audio · PDF — same type per batch',
    'dropZone.cta': 'Click to browse',

    // FileList.jsx
    'fileList.trimBadge': ({ seconds }) => `[Trim: ${seconds}s]`,
    'fileList.fpsBadge': ({ fps }) => `[${fps} fps]`,
    'fileList.codecBadge': ({ codec }) => `[${codec}]`,
    'fileList.cropBadge': ({ width, height }) => `[Crop: ${width}x${height}]`,
    'fileList.estimateInflates': ' ⚠ inflates',
    'fileList.trimMedia': 'Trim Media',
    'fileList.cropImage': 'Crop Image',
    'fileList.removeFile': 'Remove file',

    // ToolIntro.jsx
    'toolIntro.about': 'About this tool',
    'toolIntro.lede': 'Drop files anywhere in this window to get started — video, image, audio, or PDF, one type per batch. Settings for the batch you load will appear here.',
    'toolIntro.video.title': 'Video',
    'toolIntro.video.desc': 'MP4, MKV, WebM, AVI, or animated GIF — trim a range, retime with speed, adjust quality and FPS.',
    'toolIntro.image.title': 'Image',
    'toolIntro.image.desc': 'JPG, PNG, WebP, AVIF, or ICO — control quality, scale resolution down, or export straight to PDF.',
    'toolIntro.audio.title': 'Audio',
    'toolIntro.audio.desc': 'MP3, WAV, AAC, FLAC, or OGG — set bitrate and change playback speed.',
    'toolIntro.pdf.title': 'PDF',
    'toolIntro.pdf.desc': 'Linearize for fast web view, or compress for maximum size reduction.',

    // SettingsPanel.jsx -- shared field labels across Video/Image/Audio/PDF
    'settings.outputFolder': 'Output folder',
    'settings.outputPlaceholder': 'Same as source directory',
    'settings.browse': 'Browse',
    'settings.format': 'Format',
    'settings.codec': 'Codec',
    'settings.quality': 'Quality',
    'settings.upscale': 'Upscale',
    'settings.fps': 'FPS',
    'settings.speed': 'Speed',
    'settings.scale': 'Scale',
    'settings.bitrate': 'Bitrate',
    'settings.video.subtitle': 'Video conversion',
    'settings.image.subtitle': 'Image conversion',
    'settings.audio.subtitle': 'Audio conversion',
    'settings.pdf.subtitle': 'PDF optimization',
    'settings.video.formatGif': 'GIF (Animated)',
    'settings.audio.bitrate320': '320 kbps — Studio Quality',
    'settings.audio.bitrate256': '256 kbps — High Quality',
    'settings.audio.bitrate192': '192 kbps — Standard',
    'settings.audio.bitrate128': '128 kbps — Compact',
    'settings.audio.bitrate64': '64 kbps — Voice / Podcast',
    'settings.pdf.optimizeLabel': 'Optimization mode',
    'settings.pdf.linearize': 'Linearize — Fast Web View',
    'settings.pdf.compress': 'Maximum Compression',
    // Pinned -- test_conversion.js asserts on "Cancelling"/"Start Processing" literally.
    'settings.cancelling': 'Cancelling…',
    'settings.cancel': 'Cancel',
    'settings.startProcessing': 'Start Processing',

    // MixedTypeModal.jsx -- EN reproduces today's exact interpolation (raw
    // fileType keys, lowercase) since test_drop.js's D2 check requires the
    // literal words "video"/"image" to appear.
    'mixedType.title': 'Different file type detected',
    'mixedType.body': ({ existingCount, existingType, incomingCount, incomingType }) =>
      `You have ${existingCount} ${existingType} file${existingCount === 1 ? '' : 's'} loaded. These ${incomingCount} file${incomingCount === 1 ? '' : 's'} ${incomingCount === 1 ? 'is' : 'are'} ${incomingType} — only one type can be converted per batch. Clear the current files and load the new ones instead?`,
    'mixedType.keepCurrent': 'Keep current files',
    'mixedType.clearAndLoad': ({ incomingType }) => `Clear & load ${incomingType} files`,

    // TrimModal.jsx
    'trimModal.title': 'Trim Media',
    'trimModal.selected': ({ duration, percent }) => `${duration}s selected (${percent}%)`,
    'trimModal.playPause': 'Play/Pause',
    'trimModal.mute': 'Mute',
    'trimModal.unmute': 'Unmute',
    'trimModal.setStart': 'In',
    'trimModal.setEnd': 'Out',
    'trimModal.toggleLoop': 'Toggle Loop',
    'trimModal.loop': 'Loop',
    'trimModal.clearTrim': 'Clear Trim',
    'trimModal.cancel': 'Cancel',
    'trimModal.save': 'Save',

    // CropModal.jsx
    'cropModal.title': 'Crop Image',
    'cropModal.resetZoomHint': 'Double-click the preview to reset zoom',
    'cropModal.controlsHint': 'Scroll to zoom · middle-drag to pan · double-click to reset',
    'cropModal.ratio.free': 'Free',
    'cropModal.ratio.original': 'Original',
    'cropModal.width': 'W',
    'cropModal.height': 'H',
    'cropModal.clearCrop': 'Clear Crop',
    'cropModal.cancel': 'Cancel',
    'cropModal.save': 'Save',

    // StatusBar.jsx default + useFileManager.js/useExecute.js status text
    // (visible UI, not alert()s -- in scope). "Completed {n} of {m}!" and
    // "Cancelled {n} of {m}" are pinned -- multiple tests assert on them.
    'status.ready': 'Ready',
    'status.cancelling': 'Cancelling…',
    'status.skippedUnsupported': ({ name }) => `Skipped unsupported file: ${name}`,
    'status.copyingDropped': ({ index, total, percent }) => `Copying dropped file ${index}/${total} — ${percent}%`,
    'status.failedImport': ({ name }) => `Failed to import ${name}`,
    'status.dropFailed': 'Drop failed — unrecognized payload',
    'status.processing': 'Processing…',
    'status.errorToolNotFound': ({ tool }) => `Error: ${tool} not found`,
    'status.errorFile': ({ name }) => `Error: ${name}`,
    'status.fatalError': 'Fatal error',
    'status.cancelledCount': ({ completed, total }) => `Cancelled — ${completed} of ${total} converted`,
    'status.doneCount': ({ completed, total }) => `Done — ${completed} of ${total} converted`,
    'progress.processingFile': ({ name, index, total }) => `Processing: ${name} (${index}/${total})`,
    'progress.processingFilePercent': ({ name, index, total, percent }) => `Processing: ${name} (${index}/${total}) - ${percent}%`,
    'progress.processingFileDone': ({ name, index, total }) => `Processing: ${name} (${index}/${total}) - 100%`,
    'progress.cancelledCount': ({ completed, total }) => `Cancelled ${completed} of ${total}`,
    'progress.completedCount': ({ completed, total }) => `Completed ${completed} of ${total}!`,
    'progress.idle': 'Processing…',
  },
  'zh-TW': {
    'app.readingFiles': '正在讀取檔案…',
    'app.fileCount': ({ count, type }) => `${count} 個檔案 · ${type}`,
    'app.addFiles': '新增檔案',
    'app.clearAll': '清除全部',

    'fileType.video': '影片',
    'fileType.image': '圖片',
    'fileType.audio': '音訊',
    'fileType.pdf': 'PDF',

    'dropZone.ariaLabel': '拖曳檔案到此處，或點擊瀏覽',
    'dropZone.title': '拖曳檔案到此處',
    'dropZone.hint': '影片・圖片・音訊・PDF — 每批次限同一類型',
    'dropZone.cta': '點擊瀏覽',

    'fileList.trimBadge': ({ seconds }) => `[剪輯：${seconds}秒]`,
    'fileList.fpsBadge': ({ fps }) => `[${fps} fps]`,
    'fileList.codecBadge': ({ codec }) => `[${codec}]`,
    'fileList.cropBadge': ({ width, height }) => `[裁切：${width}x${height}]`,
    'fileList.estimateInflates': '　⚠ 檔案會變大',
    'fileList.trimMedia': '剪輯媒體',
    'fileList.cropImage': '裁切圖片',
    'fileList.removeFile': '移除檔案',

    'toolIntro.about': '關於此工具',
    'toolIntro.lede': '將檔案拖曳到視窗任何位置即可開始 — 影片、圖片、音訊或 PDF，每批次限同一類型。載入批次後，設定選項會顯示在這裡。',
    'toolIntro.video.title': '影片',
    'toolIntro.video.desc': 'MP4、MKV、WebM、AVI 或動態 GIF — 剪輯片段、調整速度、畫質與影格率。',
    'toolIntro.image.title': '圖片',
    'toolIntro.image.desc': 'JPG、PNG、WebP、AVIF 或 ICO — 調整畫質、縮放解析度，或直接匯出成 PDF。',
    'toolIntro.audio.title': '音訊',
    'toolIntro.audio.desc': 'MP3、WAV、AAC、FLAC 或 OGG — 設定位元速率並調整播放速度。',
    'toolIntro.pdf.title': 'PDF',
    'toolIntro.pdf.desc': '線性化以加快網頁瀏覽，或壓縮以最大化縮小檔案大小。',

    'settings.outputFolder': '輸出資料夾',
    'settings.outputPlaceholder': '與來源目錄相同',
    'settings.browse': '瀏覽',
    'settings.format': '格式',
    'settings.codec': '編碼器',
    'settings.quality': '畫質',
    'settings.upscale': '放大上限',
    'settings.fps': '影格率',
    'settings.speed': '速度',
    'settings.scale': '縮放',
    'settings.bitrate': '位元速率',
    'settings.video.subtitle': '影片轉換',
    'settings.image.subtitle': '圖片轉換',
    'settings.audio.subtitle': '音訊轉換',
    'settings.pdf.subtitle': 'PDF 最佳化',
    'settings.video.formatGif': 'GIF（動態）',
    'settings.audio.bitrate320': '320 kbps－錄音室音質',
    'settings.audio.bitrate256': '256 kbps－高音質',
    'settings.audio.bitrate192': '192 kbps－標準',
    'settings.audio.bitrate128': '128 kbps－精簡',
    'settings.audio.bitrate64': '64 kbps－語音／podcast',
    'settings.pdf.optimizeLabel': '最佳化模式',
    'settings.pdf.linearize': '線性化－加速網頁瀏覽',
    'settings.pdf.compress': '最大壓縮',
    'settings.cancelling': '正在取消…',
    'settings.cancel': '取消',
    'settings.startProcessing': '開始處理',

    'mixedType.title': '偵測到不同的檔案類型',
    'mixedType.body': ({ existingCount, existingType, incomingCount, incomingType }) => {
      const name = { video: '影片', image: '圖片', audio: '音訊', pdf: 'PDF' }
      return `目前已載入 ${existingCount} 個${name[existingType] || existingType}檔案。這 ${incomingCount} 個檔案是${name[incomingType] || incomingType} — 每批次只能轉換同一種類型。要清除目前的檔案並改為載入新的檔案嗎？`
    },
    'mixedType.keepCurrent': '保留目前的檔案',
    'mixedType.clearAndLoad': ({ incomingType }) => {
      const name = { video: '影片', image: '圖片', audio: '音訊', pdf: 'PDF' }
      return `清除並載入${name[incomingType] || incomingType}檔案`
    },

    'trimModal.title': '剪輯媒體',
    'trimModal.selected': ({ duration, percent }) => `已選取 ${duration} 秒（${percent}%）`,
    'trimModal.playPause': '播放／暫停',
    'trimModal.mute': '靜音',
    'trimModal.unmute': '取消靜音',
    'trimModal.setStart': '起點',
    'trimModal.setEnd': '終點',
    'trimModal.toggleLoop': '切換循環播放',
    'trimModal.loop': '循環',
    'trimModal.clearTrim': '清除剪輯',
    'trimModal.cancel': '取消',
    'trimModal.save': '儲存',

    'cropModal.title': '裁切圖片',
    'cropModal.resetZoomHint': '雙擊預覽以重設縮放',
    'cropModal.controlsHint': '滾動以縮放・按住中鍵拖曳以平移・雙擊以重設',
    'cropModal.ratio.free': '自由',
    'cropModal.ratio.original': '原始比例',
    'cropModal.width': '寬',
    'cropModal.height': '高',
    'cropModal.clearCrop': '清除裁切',
    'cropModal.cancel': '取消',
    'cropModal.save': '儲存',

    'status.ready': '就緒',
    'status.cancelling': '正在取消…',
    'status.skippedUnsupported': ({ name }) => `已略過不支援的檔案：${name}`,
    'status.copyingDropped': ({ index, total, percent }) => `正在複製拖放的檔案 ${index}/${total} — ${percent}%`,
    'status.failedImport': ({ name }) => `匯入失敗：${name}`,
    'status.dropFailed': '拖放失敗 — 無法辨識的內容',
    'status.processing': '處理中…',
    'status.errorToolNotFound': ({ tool }) => `錯誤：找不到 ${tool}`,
    'status.errorFile': ({ name }) => `錯誤：${name}`,
    'status.fatalError': '發生嚴重錯誤',
    'status.cancelledCount': ({ completed, total }) => `已取消 — 已轉換 ${completed}／${total} 個`,
    'status.doneCount': ({ completed, total }) => `完成 — 已轉換 ${completed}／${total} 個`,
    'progress.processingFile': ({ name, index, total }) => `處理中：${name}（${index}/${total}）`,
    'progress.processingFilePercent': ({ name, index, total, percent }) => `處理中：${name}（${index}/${total}）- ${percent}%`,
    'progress.processingFileDone': ({ name, index, total }) => `處理中：${name}（${index}/${total}）- 100%`,
    'progress.cancelledCount': ({ completed, total }) => `已取消 ${completed}／${total}`,
    'progress.completedCount': ({ completed, total }) => `已完成 ${completed}／${total}！`,
    'progress.idle': '處理中…',
  },
}

// Non-hook, point-in-time translation for text that gets STORED in state at
// the moment it's produced (useExecute's progressText) rather than rendered
// live from a key -- reads the current language at call time. Stored
// snapshots won't retroactively re-translate on a later language switch,
// which is fine for transient progress text (it refreshes constantly while
// visible and auto-hides after completion); anything long-lived (the status
// bar) stores {key, params} instead and translates at render -- see
// useFileManager's setStatus + App.jsx.
export function tNow(key, params) {
  const i18n = window.EstellaLib.i18n
  return i18n.translate(dict, i18n.getLang(), key, params)
}
