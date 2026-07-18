import { computeEstimate } from '../lib/estimateDisplay.js'
import { useTranslation } from '../hooks/useTranslation.js'

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Downloader-style "second line" under the filename -- source dimensions
// for anything with a decoded frame, duration for anything with a
// timeline. Only called for the three types that get a thumbnail at all
// (see showThumb below); documents don't have a meaningful equivalent.
function buildSubtitle(fileObj, fileType) {
  const parts = []
  if ((fileType === 'video' || fileType === 'image') && fileObj.width && fileObj.height) {
    parts.push(`${fileObj.width}x${fileObj.height}`)
  }
  if (fileType === 'video' || fileType === 'audio') {
    const d = formatDuration(fileObj.duration)
    if (d) parts.push(d)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

// Ported unchanged from resources/index.html:69-85 (container markup) and
// main.js's renderFileList per-item template (main.js:195-231
// pre-extraction). Colors below intentionally use `var(--muted)` /
// `var(--accent)` verbatim, matching the original inline styles — note
// `--muted` isn't actually a defined CSS variable in styles.css (only
// `--text-muted` is), so those spans silently inherit color today. That's
// a pre-existing vanilla-app quirk, not introduced by this port; logged in
// design-system/MASTER.md rather than "fixed" here, since a faithful
// structural port must reproduce it, not correct it.
function formatFpsTrim(fileObj, fileType, t) {
  if (fileType !== 'video' && fileType !== 'audio') return { trimText: null, fpsText: null, codecText: null }
  let trimText = null
  if (fileObj.trimStart !== undefined && fileObj.trimEnd !== undefined) {
    trimText = t('fileList.trimBadge', { seconds: (fileObj.trimEnd - fileObj.trimStart).toFixed(2) })
  }
  let fpsText = null
  if (fileType === 'video' && fileObj.fps) {
    fpsText = t('fileList.fpsBadge', { fps: Math.round(fileObj.fps) })
  }
  let codecText = null
  if (fileType === 'video' && fileObj.videoCodec) {
    codecText = t('fileList.codecBadge', { codec: fileObj.videoCodec.toUpperCase() })
  }
  return { trimText, fpsText, codecText }
}

// Per-file resolution preview, fixing the settings-panel chip's "only
// reflects the last file in the batch" quirk (SettingsPanel.jsx's
// ImageSettings) by computing it independently for every row. Crop (if set
// on this file) shrinks the base dimensions before the Scale % is applied,
// matching buildImageCommand's crop-then-scale filter order.
function formatImageResolution(fileObj, fileType, settings) {
  if (fileType !== 'image' || settings.image.format === '.pdf') return null
  const baseW = fileObj.crop ? fileObj.crop.width : fileObj.width
  const baseH = fileObj.crop ? fileObj.crop.height : fileObj.height
  if (!baseW || !baseH) return null
  const w = Math.round(baseW * (settings.image.scale / 100))
  const h = Math.round(baseH * (settings.image.scale / 100))
  return `${w} x ${h}`
}

export default function FileList({ files, fileType, settings, onRemove, onOpenTrim, onOpenCrop }) {
  const { t } = useTranslation()
  return (
    <div className="file-list" id="file-list">
      {files.map((fileObj, index) => {
        const filename = fileObj.path.split(/[\\/]/).pop()
        const sizeMB = (fileObj.size / (1024 * 1024)).toFixed(1)
        const { trimText, fpsText, codecText } = formatFpsTrim(fileObj, fileType, t)
        const estimate = computeEstimate(fileObj, fileType, settings)
        const showTrimBtn = fileType === 'video' || fileType === 'audio'
        const resolutionText = formatImageResolution(fileObj, fileType, settings)
        const cropText = fileObj.crop ? t('fileList.cropBadge', { width: fileObj.crop.width, height: fileObj.crop.height }) : null
        const showCropBtn = fileType === 'image' && settings.image.format !== '.pdf'
        // Thumbnail + subtitle line only for the three types that actually
        // decode a frame (see useFileManager's getThumbnail) -- documents
        // keep the older compact row untouched.
        const showThumb = fileType === 'video' || fileType === 'image' || fileType === 'audio'
        const subtitle = showThumb ? buildSubtitle(fileObj, fileType) : null

        return (
          <div className="file-item queue-item" id={`file-item-${index}`} key={fileObj.path}>
            {showThumb && (
              fileObj.thumbnail ? (
                <img
                  src={fileObj.thumbnail}
                  alt=""
                  className="queue-item-thumb"
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
                />
              ) : (
                <div className="queue-item-thumb" />
              )
            )}
            <div className="queue-item-body">
              <span className="queue-item-title" title={fileObj.path}>{filename}</span>
              {subtitle && <p className="queue-item-channel">{subtitle}</p>}
              <div className="queue-item-meta">
                <span id={`file-size-${index}`} className="tabular-nums">
                  {fileObj.converted ? (
                    <>
                      ({(fileObj.size / (1024 * 1024)).toFixed(2)} MB){' '}
                      <span style={{ color: 'var(--accent)' }}>&rarr; {fileObj.convertedSizeMB} MB</span>
                    </>
                  ) : (
                    `${sizeMB} MB`
                  )}
                </span>
                {trimText && (
                  <span className="tabular-nums" style={{ color: 'var(--accent)' }}>{trimText}</span>
                )}
                {fpsText && (
                  <span className="tabular-nums">{fpsText}</span>
                )}
                {codecText && (
                  <span className="tabular-nums">{codecText}</span>
                )}
                {cropText && (
                  <span className="tabular-nums" style={{ color: 'var(--accent)' }}>{cropText}</span>
                )}
                {resolutionText && (
                  <span id={`file-resolution-${index}`} className="tabular-nums">
                    [{resolutionText}]
                  </span>
                )}
                <span id={`file-est-${index}`} className="tabular-nums">
                  {estimate && (
                    <>
                      {' '}
                      <span style={{ color: estimate.warn ? 'var(--danger)' : 'var(--accent)' }}>
                        &rarr; ~{estimate.estMB.toFixed(1)} MB{estimate.warn ? t('fileList.estimateInflates') : ''}
                      </span>
                      {estimate.targetFpsLabel && (
                        <span style={{ marginLeft: 5 }}>
                          [{estimate.targetFpsLabel} fps]
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {showTrimBtn && (
                <button className="btn-trim" title={t('fileList.trimMedia')} aria-label={t('fileList.trimMedia')} onClick={() => onOpenTrim && onOpenTrim(index)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="6" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
                    <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
                    <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                  </svg>
                </button>
              )}
              {showCropBtn && (
                <button id={`btn-crop-${index}`} className="btn-trim" title={t('fileList.cropImage')} aria-label={t('fileList.cropImage')} onClick={() => onOpenCrop && onOpenCrop(index)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 2v14a2 2 0 0 0 2 2h14"></path>
                    <path d="M18 22V8a2 2 0 0 0-2-2H2"></path>
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="remove"
                aria-label={t('fileList.removeFile')}
                onClick={() => onRemove(index)}
                style={{ background: 'none', border: 'none', font: 'inherit', cursor: 'pointer' }}
              >
                X
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
