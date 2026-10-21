// JS guest bindings for this repo's Tauri plugin (plugin/). One wrapper per
// Rust command; argument keys are the Rust parameter names in camelCase.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const ping = (value) => invoke('plugin:sorai-converter|ping', { value })

// -> { size, duration, fps, width, height, codec, thumbnail: absPath|null };
// rejects for a directory / missing file. fileType: video|image|audio|pdf.
export const probeSource = (path, fileType) => invoke('plugin:sorai-converter|probe_source', { path, fileType })

// --- Convert jobs (plugin/src/runner.rs) ---
// job: { source: <file-list record>, fileType, settings: settings[fileType] }.
// Resolves { jobId, outPath, done } once ffmpeg is running; `done` resolves
// with the finished payload { status: success|error|cancelled, message, outSize }.
// Events can beat the invoke reply, so ones for a not-yet-known job id are
// buffered and replayed.

const handlers = new Map()
const early = new Map()
let listening = null
const dispatch = (kind, p) => {
  const h = handlers.get(p.jobId)
  if (h) h[kind](p)
  else early.set(p.jobId, [...(early.get(p.jobId) ?? []), [kind, p]])
}
const ensureListening = () =>
  (listening ??= Promise.all(['log', 'progress', 'finished'].map((k) => listen(`sorai-converter://${k}`, (e) => dispatch(k, e.payload)))))

export async function startConvert(job, outDir, { onLog, onProgress } = {}) {
  await ensureListening()
  const { jobId, outPath } = await invoke('plugin:sorai-converter|start_convert', { job, outDir })
  const done = new Promise((resolve) => {
    const h = {
      log: (p) => onLog?.(p.line),
      progress: (p) => onProgress?.(p.percent),
      finished: (p) => {
        handlers.delete(jobId)
        resolve(p)
      },
    }
    handlers.set(jobId, h)
    for (const [k, p] of early.get(jobId) ?? []) h[k](p)
    early.delete(jobId)
  })
  return { jobId, outPath, done }
}

// Kills the job's process tree; its `done` then resolves 'cancelled' (within ~3 s, guaranteed).
export const cancelJob = (jobId) => invoke('plugin:sorai-converter|cancel_job', { jobId })

// jobs: same shape as startConvert's job -> [{ estMB, warn, targetFpsLabel }] in order.
export const estimateSizes = (jobs) => invoke('plugin:sorai-converter|estimate_sizes', { jobs })
