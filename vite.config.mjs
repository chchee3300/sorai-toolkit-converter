import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Phase 1 scaffold (see design-system/MASTER.md). Builds to web-dist/, kept
// deliberately distinct from dist/ — that directory already belongs to
// Neutralino's own `neu build` packaging output. neutralino.config.json
// keeps serving resources/ until Phase 2/3 component parity is reached.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'web-dist',
    emptyOutDir: true,
  },
})
