// Non-blocking update notification (fixed toast, bottom-right) -- unlike
// TrimModal/CropModal/MixedTypeModal this deliberately isn't a focus-trapped
// modal, since a new version is never urgent enough to interrupt an
// in-progress conversion or settings edit. See useUpdateChecker.js for the
// status machine (idle/checking/available/downloading/installing/
// downloaded/error/none) and the Windows-vs-macOS/Linux install split.
export default function UpdateBanner({ status, latestRelease, updateError, onInstall, onDismiss }) {
  if (status === 'idle' || status === 'checking' || status === 'none') return null

  const version = latestRelease?.tag_name?.replace(/^v/, '')

  return (
    <div className="update-toast" role="status" aria-live="polite">
      {status === 'available' && (
        <>
          <div className="update-toast-title">Update available — v{version}</div>
          {updateError ? (
            <div className="update-toast-body">Update failed: {updateError}</div>
          ) : (
            latestRelease?.name && <div className="update-toast-body">{latestRelease.name}</div>
          )}
          <div className="update-toast-actions">
            <button className="btn btn-ghost btn-xs" onClick={onDismiss}>Later</button>
            <button className="btn btn-primary btn-xs" onClick={onInstall}>{updateError ? 'Try again' : 'Update now'}</button>
          </div>
        </>
      )}

      {status === 'downloading' && (
        <>
          <div className="update-toast-title">Downloading v{version}…</div>
          <div className="progress-track">
            <div className="progress-bar progress-bar--indeterminate" />
          </div>
        </>
      )}

      {status === 'installing' && (
        <div className="update-toast-title">Installing update — the app will restart…</div>
      )}

      {status === 'downloaded' && (
        <>
          <div className="update-toast-title">Downloaded v{version}</div>
          <div className="update-toast-body">Opened your Downloads folder — finish the install from there.</div>
          <div className="update-toast-actions">
            <button className="btn btn-ghost btn-xs" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="update-toast-title">Update check failed</div>
          {updateError && <div className="update-toast-body">{updateError}</div>}
          <div className="update-toast-actions">
            <button className="btn btn-ghost btn-xs" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  )
}
