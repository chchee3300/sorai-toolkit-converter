import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Library-mode build, separate from vite.config.mjs (the standalone dev-
// harness app build to web-dist/). Run via `npm run build:lib` locally, or
// automatically by npm's "prepare" lifecycle script when this package is
// installed as a git dependency (see package.json) -- the hub repo never
// needs a manual build step for this package.
//
// Ships pre-transpiled plain ESM, not raw .jsx: Vite's default node_modules
// handling doesn't run @vitejs/plugin-react's JSX transform on a
// dependency's source unless the consumer explicitly widens the plugin's
// `include` into node_modules/sorai-toolkit-converter, which is fragile and
// risks a duplicate React copy if dedupe isn't also handled. Shipping
// already-built JS means the hub treats this exactly like any other
// prebuilt npm package, no special config needed on that side.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.js',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    rollupOptions: {
      // Peer, not bundled -- the hub provides its own React instance.
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
  },
})
