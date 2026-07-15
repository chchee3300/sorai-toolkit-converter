import { useCallback, useEffect, useState } from 'react'
import versionInfo from '../version.json'

// GitHub owner/repo this app is published from -- see .github/workflows/release.yml.
const REPO = 'chchee3300/FileConverterApp'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`

function parseSemver(v) {
  const m = String(v ?? '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

// True only if `latest` is strictly greater than `current` -- equal or
// unparseable versions never report an update, so a malformed tag can't
// spuriously nag the user.
function isNewer(latest, current) {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

// Maps the current OS/arch to the release asset filename pattern produced
// by packaging/{linux,windows,macos}/build.* (see .releaserc.json's asset
// list, which is the source of truth for these suffixes).
function currentAssetPattern() {
  const os = window.EstellaLib.platform.getOS()
  if (os === 'Darwin') {
    return window.NL_ARCH === 'arm64' ? /mac_arm64\.dmg$/i : /mac_x64\.dmg$/i
  }
  if (os === 'Linux') return null // no single package format to auto-pick -- see installUpdate
  return /setup.*win_x64\.exe$/i // Windows, or NL_OS missing (pre-load default)
}

function pickAsset(assets) {
  const pattern = currentAssetPattern()
  if (!pattern) return null
  return (assets || []).find((a) => pattern.test(a.name)) || null
}

// GitHub's release-asset CDN (the redirect target of browser_download_url)
// doesn't send Access-Control-Allow-Origin, so a browser-side fetch() from
// this app's own http://localhost origin is blocked by CORS before a byte
// of the body is ever readable -- confirmed via a real download attempt
// (TypeError: Failed to fetch). curl runs outside the webview entirely, so
// it isn't subject to that restriction. This is why checkForUpdate's fetch
// to api.github.com still works fine (that endpoint *does* send permissive
// CORS headers) while downloading the actual asset never could.
async function downloadFile(url, destPath) {
  const res = await window.Neutralino.os.execCommand(`curl -sL -o "${destPath}" "${url}"`)
  if (res.exitCode !== 0) {
    throw new Error(`Download failed (curl exit ${res.exitCode}): ${(res.stdErr || res.stdOut || '').slice(0, 300)}`)
  }
}

// Checks GitHub Releases for a newer version on mount and exposes an
// install flow: Windows downloads the installer and runs it silently with
// /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS (matching installer.iss's
// CloseApplications=yes), then quits itself so the installer can replace
// the running exe. macOS/Linux can't self-replace this cleanly (unsigned
// .dmg hits Gatekeeper's quarantine flag; .deb/.rpm need a privilege
// prompt to install) -- those just download the asset and reveal it in
// the OS file manager for the user to finish.
export function useUpdateChecker() {
  const [status, setStatus] = useState('idle') // idle | checking | available | none | error | downloading | downloaded | installing
  const [latestRelease, setLatestRelease] = useState(null)
  const [updateError, setUpdateError] = useState(null)

  const checkForUpdate = useCallback(async () => {
    setStatus('checking')
    setUpdateError(null)
    try {
      const res = await fetch(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
      const data = await res.json()
      if (isNewer(data.tag_name, versionInfo.version)) {
        setLatestRelease(data)
        setStatus('available')
      } else {
        setStatus('none')
      }
    } catch (e) {
      console.error('Update check failed', e)
      setUpdateError(e.message || String(e))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

  const installUpdate = useCallback(async () => {
    if (!latestRelease) return
    setUpdateError(null)
    setStatus('downloading')
    try {
      const asset = pickAsset(latestRelease.assets)
      if (!asset) throw new Error('No matching download found for this platform in the latest release')

      const downloadsDir = await window.Neutralino.os.getPath('downloads')
      const destPath = window.EstellaLib.platform.joinPath(downloadsDir, asset.name)
      await downloadFile(asset.browser_download_url, destPath)

      if (window.EstellaLib.platform.isWindows()) {
        setStatus('installing')
        await window.Neutralino.os.spawnProcess(
          `"${destPath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS`,
        )
        await window.Neutralino.app.exit()
      } else {
        await window.Neutralino.os.open(downloadsDir)
        setStatus('downloaded')
      }
    } catch (e) {
      console.error('Update install failed', e)
      setUpdateError(e.message || String(e))
      setStatus('available')
    }
  }, [latestRelease])

  const dismiss = useCallback(() => setStatus('none'), [])

  return {
    currentVersion: versionInfo.version,
    status,
    latestRelease,
    updateError,
    installUpdate,
    dismiss,
  }
}
