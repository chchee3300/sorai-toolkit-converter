import { useEffect, useRef } from 'react'
import GlassSelect from './GlassSelect.jsx'

// Ported unchanged from resources/index.html:88-241 + main.js's settings
// event-listener wiring (main.js:896-1019 pre-extraction: value-chip
// syncing, video-codec-group hide-on-gif, audio-bitrate disable-on-
// flac/wav, video-quality max 100<->200 on upscale). React renders these
// as plain derived values instead of imperative innerText/style writes —
// same visible result, no separate "update" step needed.

function OutputPathRow({ outputPath, onBrowse }) {
  return (
    <div className="settings-block">
      <label className="field-label" htmlFor="output-path">Output folder</label>
      <div className="path-row">
        <input
          type="text"
          className="input"
          id="output-path"
          readOnly
          placeholder="Same as source directory"
          value={outputPath}
        />
        <button className="btn btn-outline btn-sm" id="btn-select-output" onClick={onBrowse}>
          Browse
        </button>
      </div>
    </div>
  )
}

function VideoSettings({ visible, video, setVideo }) {
  const set = (patch) => setVideo((v) => ({ ...v, ...patch }))
  const qualityMax = video.upscale ? 200 : 100

  return (
    <div id="video-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle" id="settings-subtitle">Video conversion</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="video-format">Format</label>
          <GlassSelect id="video-format" value={video.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".mp4">MP4</option>
            <option value=".mkv">MKV</option>
            <option value=".webm">WEBM</option>
            <option value=".avi">AVI</option>
            <option value=".gif">GIF (Animated)</option>
          </GlassSelect>
        </div>
        <div className="field" id="video-codec-group" style={{ display: video.format === '.gif' ? 'none' : 'block' }}>
          <label className="field-label" htmlFor="video-codec">Codec</label>
          <GlassSelect id="video-codec" value={video.codec} onChange={(e) => set({ codec: e.target.value })}>
            <option value="libx264">H.264 (avc1)</option>
            <option value="libx265">H.265 (hevc)</option>
            <option value="libvpx-vp9">VP9 (vp09)</option>
            <option value="libsvtav1">AV1 (av01)</option>
          </GlassSelect>
        </div>
        <div className="field span-2">
          <div className="field-label-row">
            <label className="field-label" htmlFor="video-quality">
              Quality — <span className="val-chip tabular-nums" id="video-quality-val">{video.quality}</span>%
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
              Upscale
            </label>
          </div>
          <input
            type="range"
            className="range-input"
            id="video-quality"
            value={video.quality}
            min="1"
            max={qualityMax}
            onChange={(e) => set({ quality: parseFloat(e.target.value) })}
          />
        </div>
        <div className="field">
          <div className="field-label-row">
            <label className="field-label" htmlFor="video-fps">
              FPS — <span className="val-chip tabular-nums" id="video-fps-val">{video.fpsCustom ? video.fps : 'Original'}</span>
            </label>
            <label className="toggle-check">
              <input
                type="checkbox"
                id="video-fps-custom"
                checked={video.fpsCustom}
                onChange={(e) => set({ fpsCustom: e.target.checked })}
              />
              Custom
            </label>
          </div>
          <GlassSelect id="video-fps" value={video.fps} disabled={!video.fpsCustom} onChange={(e) => set({ fps: e.target.value })}>
            <option value="24">24</option>
            <option value="30">30</option>
            <option value="60">60</option>
            <option value="120">120</option>
            <option value="144">144</option>
            <option value="240">240</option>
          </GlassSelect>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="video-speed">
            Speed — <span className="val-chip tabular-nums" id="video-speed-val">{Number(video.speed).toFixed(2)}</span>×
          </label>
          <input
            type="range"
            className="range-input"
            id="video-speed"
            value={video.speed}
            min="0.1"
            max="4.0"
            step="0.1"
            onChange={(e) => set({ speed: parseFloat(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}

function ImageSettings({ visible, image, setImage, lastFile }) {
  const set = (patch) => setImage((v) => ({ ...v, ...patch }))

  // Matches the vanilla quirk exactly: updateEstimations() looped over
  // every file and overwrote the single #image-resolution-preview element
  // each time, so it only ever reflected the *last* file in the list
  // (main.js:107-114 pre-extraction). Not "fixed" here — see FileList.jsx.
  let resolutionPreview = ''
  if (lastFile && lastFile.width && lastFile.height) {
    const w = Math.round(lastFile.width * (image.scale / 100))
    const h = Math.round(lastFile.height * (image.scale / 100))
    resolutionPreview = `${w} x ${h}`
  }

  return (
    <div id="image-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle" id="settings-subtitle">Image conversion</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="image-format">Format</label>
          <GlassSelect id="image-format" value={image.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".jpg">JPG</option>
            <option value=".png">PNG</option>
            <option value=".webp">WebP</option>
            <option value=".avif">AVIF</option>
          </GlassSelect>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="image-quality">
            Quality — <span className="val-chip tabular-nums" id="image-quality-val">{image.quality}</span>%
          </label>
          <input
            type="range"
            className="range-input"
            id="image-quality"
            value={image.quality}
            min="1"
            max="100"
            onChange={(e) => set({ quality: parseFloat(e.target.value) })}
          />
        </div>
        <div className="field span-2">
          <div className="field-label-row">
            <label className="field-label" htmlFor="image-scale">
              Scale — <span className="val-chip tabular-nums" id="image-scale-val">{image.scale}</span>%
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
            onChange={(e) => set({ scale: parseFloat(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}

function AudioSettings({ visible, audio, setAudio }) {
  const set = (patch) => setAudio((v) => ({ ...v, ...patch }))
  const bitrateDisabled = audio.format === '.flac' || audio.format === '.wav'

  return (
    <div id="audio-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle">Audio conversion</p>
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="audio-format">Format</label>
          <GlassSelect id="audio-format" value={audio.format} onChange={(e) => set({ format: e.target.value })}>
            <option value=".mp3">MP3</option>
            <option value=".wav">WAV</option>
            <option value=".aac">AAC</option>
            <option value=".flac">FLAC</option>
          </GlassSelect>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="audio-bitrate">Bitrate</label>
          <GlassSelect id="audio-bitrate" value={audio.bitrate} disabled={bitrateDisabled} onChange={(e) => set({ bitrate: e.target.value })}>
            <option value="320k">320 kbps — Studio Quality</option>
            <option value="256k">256 kbps — High Quality</option>
            <option value="192k">192 kbps — Standard</option>
            <option value="128k">128 kbps — Compact</option>
            <option value="64k">64 kbps — Voice / Podcast</option>
          </GlassSelect>
        </div>
        <div className="field span-2">
          <label className="field-label" htmlFor="audio-speed">
            Speed — <span className="val-chip tabular-nums" id="audio-speed-val">{Number(audio.speed).toFixed(2)}</span>×
          </label>
          <input
            type="range"
            className="range-input"
            id="audio-speed"
            value={audio.speed}
            min="0.1"
            max="4.0"
            step="0.1"
            onChange={(e) => set({ speed: parseFloat(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}

function PdfSettings({ visible, pdf, setPdf }) {
  return (
    <div id="pdf-settings" className={visible ? 'settings-block' : 'settings-block hidden'}>
      <p className="settings-subtitle">PDF optimization</p>
      <div className="settings-grid">
        <div className="field span-2">
          <label className="field-label" htmlFor="pdf-optimize">Optimization mode</label>
          <GlassSelect id="pdf-optimize" value={pdf.optimize} onChange={(e) => setPdf({ optimize: e.target.value })}>
            <option value="linearize">Linearize — Fast Web View</option>
            <option value="compress">Maximum Compression</option>
          </GlassSelect>
        </div>
      </div>
    </div>
  )
}

function TerminalLog({ text }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <div id="terminal-log" className="terminal" ref={ref}>
      {text}
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
  progressVisible,
  progressPercent,
  progressText,
  terminalLog,
  onExecute,
}) {
  const visible = files.length > 0
  const { video, setVideo, image, setImage, audio, setAudio, pdf, setPdf } = settings

  return (
    <section className={visible ? 'panel' : 'panel hidden'} id="settings-section">
      <OutputPathRow outputPath={outputPath} onBrowse={onBrowseOutput} />
      <div className="panel-divider"></div>

      <VideoSettings visible={fileType === 'video'} video={video} setVideo={setVideo} />
      <ImageSettings visible={fileType === 'image'} image={image} setImage={setImage} lastFile={files[files.length - 1]} />
      <AudioSettings visible={fileType === 'audio'} audio={audio} setAudio={setAudio} />
      <PdfSettings visible={fileType === 'pdf'} pdf={pdf} setPdf={setPdf} />

      <div className="panel-divider"></div>

      <div className="execute-row">
        <button className="btn btn-primary btn-execute" id="btn-execute" disabled={executing} onClick={onExecute}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 2.5l10 5.5-10 5.5V2.5z" /></svg>
          Start Processing
        </button>
      </div>

      <div id="progress-wrapper" className={progressVisible ? 'progress-block' : 'progress-block hidden'}>
        <div className="progress-track" role="progressbar" aria-valuenow={Math.round(progressPercent)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar" id="progress-bar" style={{ width: `${progressPercent}%` }}></div>
        </div>
        <p className="progress-label tabular-nums" id="progress-text" role="status" aria-live="polite">{progressText}</p>
        <TerminalLog text={terminalLog} />
      </div>
    </section>
  )
}
