// JS guest bindings for this repo's Tauri plugin (plugin/). One wrapper per
// Rust command; argument keys are the Rust parameter names in camelCase.
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core'

export const ping = (value) => invoke('plugin:sorai-converter|ping', { value })

// -> { size, duration, fps, width, height, codec, audioCodec, thumbnail: absPath|null };
// rejects for a directory / missing file. fileType: video|image|audio|pdf.
export const probeSource = (path, fileType) => invoke('plugin:sorai-converter|probe_source', { path, fileType })

// --- Convert jobs (plugin/src/runner.rs) ---
// job: { source: <file-list record>, fileType, settings: settings[fileType] }.
// Resolves { jobId, outPath, done } once the job is running; `done` resolves
// with the finished payload { status: success|error|cancelled, message, outSize }.
// Events come on the job's own Channel, so none can be missed or misrouted.
export const startConvert = (job, outDir, handlers) => startJob('start_convert', job, outDir, handlers)

// "Merge into one file": job = { sources: <file-list records, in order>,
// fileType, settings } -> one job writing <first name>_merged<ext>, same
// { jobId, outPath, done } and events as startConvert.
export const startMerge = (job, outDir, handlers) => startJob('start_merge', job, outDir, handlers)

async function startJob(cmd, job, outDir, { onLog, onProgress } = {}) {
  let finish
  const done = new Promise((resolve) => (finish = resolve))
  const onEvent = new Channel()
  onEvent.onmessage = (m) => {
    if (m.event === 'log') onLog?.(m.line)
    else if (m.event === 'progress') onProgress?.(m.percent)
    else if (m.event === 'finished') finish(m)
  }
  const { jobId, outPath } = await invoke(`plugin:sorai-converter|${cmd}`, { job, outDir, onEvent })
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

// --- Optional engines (plugin/src/engines.rs) ---
// -> [{ id, name, state: user|installed|system|missing, path, userPath,
// license, homepage, installCommand, installable, installed, downloadSize }]. Looked up
// fresh on every call.
export const engineStatus = () => invoke('plugin:sorai-converter|engine_status')

// "Use my own program..." (path) or back to auto-detect (null). Resolves the
// new status list; fires `sorai:engines-changed` on window so open views
// (the converter's PDF status line) re-check.
export async function engineSetPath(engine, path) {
  const list = await invoke('plugin:sorai-converter|engine_set_path', { engine, path })
  window.dispatchEvent(new Event('sorai:engines-changed'))
  return list
}

// Download + install (Windows; status rows have `installable`). onProgress
// gets 0-100. Resolves the new status list, rejects "cancelled" after
// engineCancel(). Both install and remove fire `sorai:engines-changed`.
export async function engineInstall(engine, onProgress) {
  const channel = new Channel()
  channel.onmessage = (p) => onProgress?.(p)
  const list = await invoke('plugin:sorai-converter|engine_install', { engine, onProgress: channel })
  window.dispatchEvent(new Event('sorai:engines-changed'))
  return list
}

export const engineCancel = () => invoke('plugin:sorai-converter|engine_cancel')

export async function engineRemove(engine) {
  const list = await invoke('plugin:sorai-converter|engine_remove', { engine })
  window.dispatchEvent(new Event('sorai:engines-changed'))
  return list
}

// The first-run prompt (EnginePrompt.jsx): due when never shown and no
// Ghostscript is found. engineSetPrompted(true) records it was shown.
export const enginePrompt = () => invoke('plugin:sorai-converter|engine_prompt')
export const engineSetPrompted = (prompted) => invoke('plugin:sorai-converter|engine_set_prompted', { prompted })

// The running install's progress, kept here rather than in a component so
// the hub's Settings and the first-run prompt show the same one and it
// outlives either closing. { engine, percent (null = idle), error } --
// subscribe with useSyncExternalStore(onInstallChange, installState).
// Rust allows one install at a time, so one slot is enough.
let install = { engine: null, percent: null, error: '' }
const listeners = new Set()
const setInstall = (patch) => {
  install = { ...install, ...patch }
  listeners.forEach((f) => f())
}
export const installState = () => install
export const onInstallChange = (f) => (listeners.add(f), () => listeners.delete(f))

// Resolves { list, error } (error '' on success and on Cancel); never rejects.
export function startInstall(engine) {
  setInstall({ engine, percent: 0, error: '' })
  return engineInstall(engine, (p) => setInstall({ percent: p })).then(
    (list) => (setInstall({ engine: null, percent: null }), { list, error: '' }),
    async (e) => {
      const error = String(e) === 'cancelled' ? '' : String(e)
      setInstall({ engine: null, percent: null, error })
      return { list: await engineStatus().catch(() => []), error }
    },
  )
}
