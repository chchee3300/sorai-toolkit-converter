import { useCallback, useState } from 'react'

// Matches resources/index.html's <option> lists exactly (index.html:108-219).
export const VIDEO_FORMATS = ['.mp4', '.mkv', '.webm', '.avi', '.gif']
export const IMAGE_FORMATS = ['.jpg', '.png', '.webp', '.avif', '.ico', '.pdf']
export const AUDIO_FORMATS = ['.mp3', '.wav', '.aac', '.flac', '.ogg']

// Preset "compress to under N MB" targets -- decimal MB (1,000,000 bytes),
// not MiB, deliberately stricter for extra safety margin against
// overshoot. See ffmpeg-commands.js's computeTargetSizeBitrates for the
// actual bitrate math this feeds.
export const TARGET_SIZE_PRESETS_MB = [5, 25, 50]

const DEFAULT_VIDEO = {
  format: '.mp4',
  codec: 'libx264',
  quality: 100,
  upscale: false,
  fps: null, // null = use the source's original fps (no explicit -vf fps= filter)
  fpsUpscale: false, // extends the FPS slider's max to 4x the source's original fps
  speed: 1.0,
  targetSizeMode: false, // true = drive bitrate from targetSizeMB instead of quality
  targetSizeMB: null,
}
const DEFAULT_IMAGE = { format: '.jpg', quality: 85, scale: 100 }
const DEFAULT_AUDIO = { format: '.mp3', bitrate: '320k', speed: 1.0 }
const DEFAULT_PDF = { optimize: 'linearize' }

// Owns the 4 per-category settings blocks. setFormatForType is the
// DropZone -> SettingsPanel coupling point (see useFileManager's
// onFirstFileType) — ported from handleFiles' isFirstValidFile block
// (main.js:266-283 pre-extraction), same validity check (only set if the
// extension is actually one of that category's dropdown options).
export function useSettings() {
  const [video, setVideo] = useState(DEFAULT_VIDEO)
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [audio, setAudio] = useState(DEFAULT_AUDIO)
  const [pdf, setPdf] = useState(DEFAULT_PDF)

  const setFormatForType = useCallback((type, ext) => {
    if (type === 'video' && VIDEO_FORMATS.includes(ext)) {
      setVideo((v) => ({ ...v, format: ext }))
    } else if (type === 'image' && IMAGE_FORMATS.includes(ext)) {
      setImage((v) => ({ ...v, format: ext }))
    } else if (type === 'audio' && AUDIO_FORMATS.includes(ext)) {
      setAudio((v) => ({ ...v, format: ext }))
    }
  }, [])

  return { video, setVideo, image, setImage, audio, setAudio, pdf, setPdf, setFormatForType }
}
