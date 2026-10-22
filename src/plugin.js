// JS guest bindings for this repo's Tauri plugin (plugin/). One wrapper per
// Rust command; argument keys are the Rust parameter names in camelCase.
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core'

export const ping = (value) => invoke('plugin:sorai-converter|ping', { value })

// -> { size, duration, fps, width, height, codec, thumbnail: absPath|null };
// rejects for a directory / missing file. fileType: video|image|audio|pdf.
export const probeSource = (path, fileType) => invoke('plugin:sorai-converter|probe_source', { path, fileType })

// --- Convert jobs (plugin/src/runner.rs) ---
// job: { source: <file-list record>, fileType, settings: settings[fileType] }.
// Resolves { jobId, outPath, done } once the job is running; `done` resolves
// with the finished payload { status: success|error|cancelled, message, outSize }.
// Events come on the job's own Channel, so none can be missed or misrouted.
export async function startConvert(job, outDir, { onLog, onProgress } = {}) {
  let finish
  const done = new Promise((resolve) => (finish = resolve))
  const onEvent = new Channel()
  onEvent.onmessage = (m) => {
    if (m.event === 'log') onLog?.(m.line)
    else if (m.event === 'progress') onProgress?.(m.percent)
    else if (m.event === 'finished') finish(m)
  }
  const { jobId, outPath } = await invoke('plugin:sorai-converter|start_convert', { job, outDir, onEvent })
  return { jobId, outPath, done }
}

// Kills the job's process tree; its `done` then resolves 'cancelled' (within ~3 s, guaranteed).
export const cancelJob = (jobId) => invoke('plugin:sorai-converter|cancel_job', { jobId })

// jobs: same shape as startConvert's job -> [{ estMB, warn, targetFpsLabel }] in order.
export const estimateSizes = (jobs) => invoke('plugin:sorai-converter|estimate_sizes', { jobs })

// The queued files Trim/Crop may load (plugin/src/preview.rs). Call with the
// whole current queue; anything not in it is refused from then on.
export const setPreviewFiles = (paths) => invoke('plugin:sorai-converter|set_preview_files', { paths })
export const previewSrc = (path) => convertFileSrc(path, 'sorai-media')
