// Writes the semantic-release-computed version into src/version.json so
// Vite bundles it into the frontend build (useUpdateChecker.js reads it via
// a plain JSON import -- no runtime fetch needed, works identically in dev
// and in an --embed-resources packaged build). Run before `npm run build`:
//   node scripts/write-version.mjs <version>
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/write-version.mjs <version>');
  process.exit(1);
}

const dest = path.resolve('src/version.json');
writeFileSync(dest, JSON.stringify({ version }, null, 2) + '\n');
console.log(`Wrote ${dest}: version ${version}`);
