import GlassSelect from './GlassSelect.jsx'
import { useTranslation } from '../hooks/useTranslation.js'
import { TARGET_SIZE_PRESETS_MB } from '../hooks/useSettings.js'

// rangeFillStyle used to be this repo's own src/lib/rangeFill.js -- moved
// into the hub's window.EstellaLib runtime globals (resources/js/lib/
// range-fill.js) since it was byte-identical to Downloader's own copy with
// zero per-repo divergence, unlike e.g. useTranslation.js which needs
// `react` and can't live in a vanilla global the same way. Accessed inline
// at each call site below (not destructured at module scope) -- every
// other window.EstellaLib.* consumer in this codebase does the same,
// since this module's own import graph resolves before main.jsx's later
// side-effect imports attach these runtime globals to window.
const rangeFillStyle = (value, min, max) => window.EstellaLib.rangeFill.rangeFillStyle(value, min, max)

// Ported unchanged from resources/index.html:88-241 + main.js's settings
// event-listener wiring (main.js:896-1019 pre-extraction: value-chip
// syncing, video-codec-group hide-on-gif, audio-bitrate disable-on-
// flac/wav, video-quality max 100<->200 on upscale). React renders these
// as plain derived values instead of imperative innerText/style writes —
// same visible result, no separate "update" step needed.

function OutputPathRow({ outputPath, onBrowse }) {
  const { t } = useTranslation()
  return (
    <div className="settings-block">
      <label className="field-label" htmlFor="output-path">{t('settings.outputFolder')}</label>
      <div className="path-row">
        <input
          type="text"
          className="input"
          id="output-path"
          readOnly
          placeholder={t('settings.outputPlaceholder')}
          value={outputPath}
        />
        <button className="btn btn-outline btn-sm" id="btn-select-output" onClick={onBrowse}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 4.5c0-.55.45-1 1-1h3.2l1 1.3H13c.55 0 1 .45 1 1v6.2c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4.5z" />
          </svg>
          {t('settings.browse')}
        </button>
      </div>
    </div>
  )
}

function VideoSettings({ visible, video, setVideo, lastFile }) {
  const { t } = useTranslation()
  const set = (patch) => setVideo((v) => ({ ...v, ...patch }))
  const qualityMax = video.upscale ? 200 : 100

  // Same "last file in the batch" reference convention ImageSettings uses
  // for its resolution preview — the fps slider's bounds are derived from
  // whichever file is currently last in the list. 30 is a sane fallback
  // before a file's probed fps is known.
  const referenceFps = (lastFile && lastFile.fps) || 30
  const fpsMax = video.fpsUpscale ? referenceFps * 4 : referenceFps
  // video.fps stays null until the user actually drags the slider — that's
  // what lets the command builder skip the -vf fps= filter entirely for
  // "untouched" (see ffmpeg-commands.js's 'original' sentinel), rather than
  // emitting a same-value filter that would force CFR on a VFR source.
  const fpsValue = video.fps != null ? Math.min(video.fps, fpsMax) : referenceFps

  return (
    <div id="video-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle" id="settings-subtitle">{t('settings.video.subtitle')}</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="video-format">{t('settings.format')}</label>
          <GlassSelect id="video-format" value={video.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".mp4">MP4</option>
            <option value=".mkv">MKV</option>
            <option value=".webm">WEBM</option>
            <option value=".avi">AVI</option>
            {/* GIF has no bitrate concept the target-size math can drive --
                excluded from the picker entirely while targetSizeMode is
                on, same idiom as forcing codec below. */}
            {!video.targetSizeMode && <option value=".gif">{t('settings.video.formatGif')}</option>}
          </GlassSelect>
        </div>
        <div className="field" id="video-codec-group" style={{ display: video.format === '.gif' ? 'none' : 'block' }}>
          <label className="field-label" htmlFor="video-codec">{t('settings.codec')}</label>
          <GlassSelect id="video-codec" value={video.targetSizeMode ? 'libx264' : video.codec} disabled={video.targetSizeMode} onChange={(e) => set({ codec: e.target.value })}>
            <option value="libx264">H.264 (avc1)</option>
            <option value="libx265">H.265 (hevc)</option>
            <option value="libvpx-vp9">VP9 (vp09)</option>
            <option value="libsvtav1">AV1 (av01)</option>
          </GlassSelect>
          {video.targetSizeMode && <p className="settings-hint">{t('settings.video.targetSizeCodecLocked')}</p>}
        </div>
        {/* Quick compress -- switches bitrate off the relative Quality
            slider entirely and derives it from a target output size
            instead (see ffmpeg-commands.js's computeTargetSizeBitrates).
            "Under 50MB" only needs to stay under the cap, not hit it
            exactly, so this is presented as discrete presets rather than
            a slider. */}
        <div className="field span-2">
          <label className="field-label">{t('settings.video.targetSize')}</label>
          <div className="target-size-chips">
            {TARGET_SIZE_PRESETS_MB.map((mb) => (
              <button
                key={mb}
                type="button"
                className={`chip ${video.targetSizeMode && video.targetSizeMB === mb ? 'chip--active' : ''}`}
                onClick={() => set({
                  targetSizeMode: true,
                  targetSizeMB: mb,
                  format: video.format === '.gif' ? '.mp4' : video.format,
                })}
              >
                {mb} MB
              </button>
            ))}
            {video.targetSizeMode && (
              <button type="button" className="chip chip--ghost" onClick={() => set({ targetSizeMode: false, targetSizeMB: null })}>
                {t('settings.video.targetSizeOff')}
              </button>
            )}
          </div>
        </div>
        {!video.targetSizeMode && (
        <div className="field span-2">
          <div className="field-label-row">
            <label className="field-label" htmlFor="video-quality">
              {t('settings.quality')} — <span className="val-chip tabular-nums" id="video-quality-val">{video.quality}</span>%
            </label>
            <label className="toggle-check">
              <input
                type="checkbox"
                id="video-upscale"
                checked={video.upscale}
                onChange={(e) => {
                  const upscale = e.target.checked
                  set({ upscale, quality: !upscale && video.quality > 100 ? 100 : video.quality })
                }}
              />
              {t('settings.upscale')}
            </label>
          </div>
          <input
            type="range"
            className="range-input"
            id="video-quality"
            value={video.quality}
            min="1"
            max={qualityMax}
            style={rangeFillStyle(video.quality, 1, qualityMax)}
            onChange={(e) => set({ quality: parseFloat(e.target.value) })}
          />
        </div>
        )}
        <div className="field">
          <div className="field-label-row">
            <label className="field-label" htmlFor="video-fps">
              {t('settings.fps')} — <span className="val-chip tabular-nums" id="video-fps-val">{Math.round(fpsValue)}</span>
            </label>
            <label className="toggle-check">
              <input
                type="checkbox"
                id="video-fps-upscale"
                checked={video.fpsUpscale}
                onChange={(e) => {
                  const fpsUpscale = e.target.checked
                  set({ fpsUpscale, fps: !fpsUpscale && video.fps > referenceFps ? referenceFps : video.fps })
                }}
              />
              {t('settings.upscale')}
            </label>
          </div>
          <input
            type="range"
            className="range-input"
            id="video-fps"
            value={fpsValue}
            min="1"
            max={fpsMax}
            step="1"
            style={rangeFillStyle(fpsValue, 1, fpsMax)}
            onChange={(e) => set({ fps: parseFloat(e.target.value) })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="video-speed">
            {t('settings.speed')} — <span className="val-chip tabular-nums" id="video-speed-val">{Number(video.speed).toFixed(2)}</span>×
          </label>
          <input
            type="range"
            className="range-input"
            id="video-speed"
            value={video.speed}
            min="0.1"
            max="4.0"
            step="0.1"
            style={rangeFillStyle(video.speed, 0.1, 4.0)}
            onChange={(e) => set({ speed: parseFloat(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}

// Pure CSS boxes (no thumbnail/image asset) showing the last file's
// original vs. scaled dimensions proportionally. Two SEPARATE same-aspect
// boxes side by side (not one nested inside the other) — Scale is a
// uniform proportional resize of the *whole* image, not a sub-region
// selection, so a smaller box inset inside a corner of a bigger one would
// misread as a crop preview instead. "Effective source" honors
// lastFile.crop when set, matching resolutionPreview's own crop-then-scale
// math below and buildImageCommand's filter order.
function ScaleSizeDiagram({ lastFile, scale }) {
  if (!lastFile || !lastFile.width || !lastFile.height) return null
  const baseW = lastFile.crop ? lastFile.crop.width : lastFile.width
  const baseH = lastFile.crop ? lastFile.crop.height : lastFile.height
  if (!baseW || !baseH) return null

  const MAX_PX = 56
  const fit = MAX_PX / Math.max(baseW, baseH)
  const outerW = Math.max(6, Math.round(baseW * fit))
  const outerH = Math.max(6, Math.round(baseH * fit))
  const scaledW = Math.round(baseW * (scale / 100))
  const scaledH = Math.round(baseH * (scale / 100))
  const resultW = Math.max(3, Math.round(outerW * (scale / 100)))
  const resultH = Math.max(3, Math.round(outerH * (scale / 100)))

  const boxStyle = {
    background: 'var(--surface-3)',
    border: '1px solid var(--glass-border-hi)',
    borderRadius: 2,
    flexShrink: 0,
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 8 }}>
      <div style={{ ...boxStyle, width: outerW, height: outerH }} title={`${baseW} x ${baseH}`} />
      <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: '0.8em', marginBottom: (outerH - 12) / 2 }}>
        →
      </span>
      <div
        style={{ ...boxStyle, width: resultW, height: resultH, borderColor: 'var(--accent)', background: 'var(--accent-dim)' }}
        title={`${scaledW} x ${scaledH}`}
      />
      <span className="tabular-nums" style={{ fontSize: '0.75em', color: 'var(--text-muted)', lineHeight: 1.4, marginLeft: 2 }}>
        {baseW} x {baseH}
        <br />→ {scaledW} x {scaledH}
      </span>
    </div>
  )
}

function ImageSettings({ visible, image, setImage, lastFile }) {
  const { t } = useTranslation()
  const set = (patch) => setImage((v) => ({ ...v, ...patch }))

  // Matches the vanilla quirk exactly: updateEstimations() looped over
  // every file and overwrote the single #image-resolution-preview element
  // each time, so it only ever reflected the *last* file in the list
  // (main.js:107-114 pre-extraction). Not "fixed" here (kept for
  // tests/test_conversion.js's `I1` assertion on this exact id) — the
  // per-file fix lives in FileList.jsx instead. Now crop-aware, same as
  // that per-file version and ScaleSizeDiagram above.
  let resolutionPreview = ''
  if (lastFile && lastFile.width && lastFile.height) {
    const baseW = lastFile.crop ? lastFile.crop.width : lastFile.width
    const baseH = lastFile.crop ? lastFile.crop.height : lastFile.height
    const w = Math.round(baseW * (image.scale / 100))
    const h = Math.round(baseH * (image.scale / 100))
    resolutionPreview = `${w} x ${h}`
  }

  // img2pdf embeds losslessly and has no resize/quality knobs — hide both
  // fields rather than disable them, same idiom VideoSettings uses to hide
  // the whole codec selector when format is .gif.
  const isPdfOutput = image.format === '.pdf'

  return (
    <div id="image-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle" id="settings-subtitle">{t('settings.image.subtitle')}</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="image-format">{t('settings.format')}</label>
          <GlassSelect id="image-format" value={image.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".jpg">JPG</option>
            <option value=".png">PNG</option>
            <option value=".webp">WebP</option>
            <option value=".avif">AVIF</option>
            <option value=".ico">ICO</option>
            <option value=".pdf">PDF</option>
          </GlassSelect>
        </div>
        <div className="field" id="image-quality-group" style={{ display: isPdfOutput ? 'none' : 'block' }}>
          <label className="field-label" htmlFor="image-quality">
            {t('settings.quality')} — <span className="val-chip tabular-nums" id="image-quality-val">{image.quality}</span>%
          </label>
          <input
            type="range"
            className="range-input"
            id="image-quality"
            value={image.quality}
            min="1"
            max="100"
            style={rangeFillStyle(image.quality, 1, 100)}
            onChange={(e) => set({ quality: parseFloat(e.target.value) })}
          />
        </div>
        <div className="field span-2" id="image-scale-group" style={{ display: isPdfOutput ? 'none' : 'block' }}>
          <div className="field-label-row">
            <label className="field-label" htmlFor="image-scale">
              {t('settings.scale')} — <span className="val-chip tabular-nums" id="image-scale-val">{image.scale}</span>%
            </label>
            <span className="val-chip secondary tabular-nums" id="image-resolution-preview">{resolutionPreview}</span>
          </div>
          <input
            type="range"
            className="range-input"
            id="image-scale"
            value={image.scale}
            min="10"
            max="100"
            step="1"
            style={rangeFillStyle(image.scale, 10, 100)}
            onChange={(e) => set({ scale: parseFloat(e.target.value) })}
          />
          <ScaleSizeDiagram lastFile={lastFile} scale={image.scale} />
        </div>
      </div>
    </div>
  )
}

function AudioSettings({ visible, audio, setAudio }) {
  const { t } = useTranslation()
  const set = (patch) => setAudio((v) => ({ ...v, ...patch }))
  const bitrateDisabled = audio.format === '.flac' || audio.format === '.wav'

  return (
    <div id="audio-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle">{t('settings.audio.subtitle')}</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="audio-format">{t('settings.format')}</label>
          <GlassSelect id="audio-format" value={audio.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".mp3">MP3</option>
            <option value=".wav">WAV</option>
            <option value=".aac">AAC</option>
            <option value=".flac">FLAC</option>
            <option value=".ogg">OGG</option>
          </GlassSelect>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audio-bitrate">{t('settings.bitrate')}</label>
          <GlassSelect id="audio-bitrate" value={audio.bitrate} disabled={bitrateDisabled} onChange={(e) => set({ bitrate: e.target.value })}>
            <option value="320k">{t('settings.audio.bitrate320')}</option>
            <option value="256k">{t('settings.audio.bitrate256')}</option>
            <option value="192k">{t('settings.audio.bitrate192')}</option>
            <option value="128k">{t('settings.audio.bitrate128')}</option>
            <option value="64k">{t('settings.audio.bitrate64')}</option>
          </GlassSelect>
        </div>
        <div className="field span-2">
          <label className="field-label" htmlFor="audio-speed">
            {t('settings.speed')} — <span className="val-chip tabular-nums" id="audio-speed-val">{Number(audio.speed).toFixed(2)}</span>×
          </label>
          <input
            type="range"
            className="range-input"
            id="audio-speed"
            value={audio.speed}
            min="0.1"
            max="4.0"
            step="0.1"
            style={rangeFillStyle(audio.speed, 0.1, 4.0)}
            onChange={(e) => set({ speed: parseFloat(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}

function PdfSettings({ visible, pdf, setPdf }) {
  const { t } = useTranslation()
  // Was setPdf({ optimize: e.target.value }) — a raw replacement object,
  // not a merge patch. Harmless with a single field, but switched to the
  // same set()-merge helper every other settings component already uses,
  // so a future second field can't be silently dropped by this.
  const set = (patch) => setPdf((v) => ({ ...v, ...patch }))

  return (
    <div id="pdf-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle">{t('settings.pdf.subtitle')}</p>
      <div className="settings-grid">
        <div className="field span-2">
          <label className="field-label" htmlFor="pdf-optimize">{t('settings.pdf.optimizeLabel')}</label>
          <GlassSelect id="pdf-optimize" value={pdf.optimize} onChange={(e) => set({ optimize: e.target.value })}>
            <option value="linearize">{t('settings.pdf.linearize')}</option>
            <option value="compress">{t('settings.pdf.compress')}</option>
          </GlassSelect>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPanel({
  files,
  fileType,
  settings,
  outputPath,
  onBrowseOutput,
  executing,
  cancelling,
  onExecute,
  onCancel,
}) {
  const { t } = useTranslation()
  const { video, setVideo, image, setImage, audio, setAudio, pdf, setPdf } = settings

  return (
    <section className="panel" id="settings-section">
      <OutputPathRow outputPath={outputPath} onBrowse={onBrowseOutput} />
      <div className="panel-divider"></div>

      <VideoSettings visible={fileType === 'video'} video={video} setVideo={setVideo} lastFile={files[files.length - 1]} />
      <ImageSettings visible={fileType === 'image'} image={image} setImage={setImage} lastFile={files[files.length - 1]} />
      <AudioSettings visible={fileType === 'audio'} audio={audio} setAudio={setAudio} />
      <PdfSettings visible={fileType === 'pdf'} pdf={pdf} setPdf={setPdf} />

      <div className="panel-divider"></div>

      <div className="execute-row">
        {executing ? (
          <button
            type="button"
            className="btn btn-outline-danger btn-execute"
            id="btn-execute"
            disabled={cancelling}
            onClick={onCancel}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" /></svg>
            {cancelling ? t('settings.cancelling') : t('settings.cancel')}
          </button>
        ) : (
          <button className="btn btn-primary btn-execute" id="btn-execute" disabled={executing} onClick={onExecute}>
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.5l10 5.5-10 5.5V2.5z" /></svg>
            {t('settings.startProcessing')}
          </button>
        )}
      </div>
    </section>
  )
}
