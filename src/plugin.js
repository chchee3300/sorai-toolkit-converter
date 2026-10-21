// JS guest bindings for this repo's Tauri plugin (plugin/). One wrapper per
// Rust command; argument keys are the Rust parameter names in camelCase.
import { invoke } from '@tauri-apps/api/core'

export const ping = (value) => invoke('plugin:sorai-converter|ping', { value })
