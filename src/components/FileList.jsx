import { computeEstimate } from '../lib/estimateDisplay.js'

// Ported unchanged from resources/index.html:69-85 (container markup) and
// main.js's renderFileList per-item template (main.js:195-231
// pre-extraction). Colors below intentionally use `var(--muted)` /
// `var(--accent)` verbatim, matching the original inline styles — note
// `--muted` isn't actually a defined CSS variable in styles.css (only
// `--text-muted` is), so those spans silently inherit color today. That's
// a pre-existing vanilla-app quirk, not introduced by this port; logged in
// design-system/MASTER.md rather than "fixed" here, since a faithful
// structural port must reproduce it, not correct it.
function formatFpsTrim(fileObj, fileType) {
  if (fileType !== 'video' && fileType !== 'audio') return { trimText: null, fpsText: null }
  let trimText = null
  if (fileObj.trimStart !== undefined && fileObj.trimEnd !== undefined) {
    trimText = `[Trim: ${(fileObj.trimEnd - fileObj.trimStart).toFixed(2)}s]`
  }
  let fpsText = null
  if (fileType === 'video' && fileObj.fps) {
    fpsText = `[${Math.round(fileObj.fps)} fps]`
  }
  return { trimText, fpsText }
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
  return (
    <div className="file-list" id="file-list">
      {files.map((fileObj, index) => {
        const filename = fileObj.path.split(/[\\/]/).pop()
        const sizeMB = (fileObj.size / (1024 * 1024)).toFixed(1)
        const { trimText, fpsText } = formatFpsTrim(fileObj, fileType)
        const estimate = computeEstimate(fileObj, fileType, settings)
        const showTrimBtn = fileType === 'video' || fileType === 'audio'
        const resolutionText = formatImageResolution(fileObj, fileType, settings)
        const cropText = fileObj.crop ? `[Crop: ${fileObj.crop.width}x${fileObj.crop.height}]` : null
        const showCropBtn = fileType === 'image' && settings.image.format !== '.pdf'

        return (
          <div className="file-item" id={`file-item-${index}`} key={fileObj.path}>
            <div>
              <span title={fileObj.path}>{filename}</span>
              <span id={`file-size-${index}`} className="tabular-nums" style={{ color: 'var(--muted)', marginLeft: 10, fontSize: '0.8em' }}>
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
                <span className="tabular-nums" style={{ color: 'var(--accent)', marginLeft: 5, fontSize: '0.8em' }}>{trimText}</span>
              )}
              {fpsText && (
                <span className="tabular-nums" style={{ color: 'var(--muted)', marginLeft: 5, fontSize: '0.8em' }}>{fpsText}</span>
              )}
              {cropText && (
                <span className="tabular-nums" style={{ color: 'var(--accent)', marginLeft: 5, fontSize: '0.8em' }}>{cropText}</span>
              )}
              {resolutionText && (
                <span id={`file-resolution-${index}`} className="tabular-nums" style={{ color: 'var(--muted)', marginLeft: 5, fontSize: '0.8em' }}>
                  [{resolutionText}]
                </span>
              )}
              <span id={`file-est-${index}`} className="tabular-nums" style={{ fontSize: '0.8em', marginLeft: 5 }}>
                {estimate && (
                  <>
                    {' '}
                    <span style={{ color: estimate.warn ? 'var(--danger)' : 'var(--accent)' }}>
                      &rarr; ~{estimate.estMB.toFixed(1)} MB{estimate.warn ? ' ⚠ inflates' : ''}
                    </span>
                    {estimate.targetFpsLabel && (
                      <span style={{ color: 'var(--muted)', marginLeft: 5, fontSize: '0.8em' }}>
                        [{estimate.targetFpsLabel} fps]
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {showTrimBtn && (
                <button className="btn-trim" title="Trim Media" aria-label="Trim Media" onClick={() => onOpenTrim && onOpenTrim(index)}>
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
                <button id={`btn-crop-${index}`} className="btn-trim" title="Crop Image" aria-label="Crop Image" onClick={() => onOpenCrop && onOpenCrop(index)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 2v14a2 2 0 0 0 2 2h14"></path>
                    <path d="M18 22V8a2 2 0 0 0-2-2H2"></path>
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="remove"
                aria-label="Remove file"
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
