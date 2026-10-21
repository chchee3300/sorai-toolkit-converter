import { useEffect, useState } from 'react'
import { estimateSizes } from '../plugin.js'

// Output-size preview per queued file, computed in Rust (plugin
// convert::estimate). Index-aligned with `files`; null for a converted file
// (FileList shows the real result instead) or until the first reply lands.
// Depends on settings[fileType], not `settings` (a new object every render).
export function useEstimates(files, fileType, settings) {
  const typeSettings = settings[fileType]
  const [estimates, setEstimates] = useState([])
  useEffect(() => {
    if (!typeSettings || files.length === 0) return
    let stale = false
    const jobs = files.map((source) => ({ source, fileType, settings: typeSettings }))
    estimateSizes(jobs)
      .then((r) => !stale && setEstimates(r.map((e, i) => (files[i].converted ? null : e))))
      .catch((e) => console.error('estimate_sizes failed', e))
    return () => { stale = true }
  }, [files, fileType, typeSettings])
  return estimates
}
