// `neu update` writes the Neutralino client lib straight to
// web-dist/js/neutralino.js (per neutralino.config.json's clientLibrary
// setting) -- but vite's build wipes web-dist/ (emptyOutDir) before
// copying it back in from resources/js/neutralino.js (vite.config.mjs's
// declared "single source of truth", gitignored, otherwise never populated
// on a fresh checkout). Run this once after `neu update`, before the first
// `npm run build`. Used by both `npm run setup` (see package.json) and
// .github/workflows/release.yml's build-* jobs.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve('web-dist/js/neutralino.js');
const dest = path.resolve('resources/js/neutralino.js');

if (!existsSync(src)) {
  console.error(`Missing ${src} -- run "neu update" first`);
  process.exit(1);
}

mkdirSync(path.dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
