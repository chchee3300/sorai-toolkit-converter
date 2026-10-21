// JS guest bindings for this repo's Tauri plugin (plugin/). One wrapper per
// Rust command; argument keys are the Rust parameter names in camelCase.
import { invoke } from '@tauri-apps/api/core'

export const ping = (value) => invoke('plugin:sorai-converter|ping', { value })

// -> { size, duration, fps, width, height, codec, thumbnail: absPath|null };
// rejects for a directory / missing file. fileType: video|image|audio|pdf.
export const probeSource = (path, fileType) => invoke('plugin:sorai-converter|probe_source', { path, fileType })
