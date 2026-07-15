// Computes the next semantic-release version without publishing anything,
// so CI can build+package platform assets *before* the real release step
// (which needs those assets to already exist to attach them). Writes to
// GITHUB_OUTPUT: will-release=true/false and, when true, version=X.Y.Z.
//
// Run with: node scripts/get-next-version.mjs (from the repo root, with
// GITHUB_TOKEN set -- @semantic-release/github's verifyConditions needs it
// even in dry-run mode).
import semanticRelease from 'semantic-release';
import { appendFileSync } from 'node:fs';

const result = await semanticRelease({ dryRun: true, ci: true });

const output = process.env.GITHUB_OUTPUT;
function writeOutput(line) {
  console.log(line);
  if (output) appendFileSync(output, line + '\n');
}

if (result && result.nextRelease) {
  writeOutput('will-release=true');
  writeOutput(`version=${result.nextRelease.version}`);
} else {
  writeOutput('will-release=false');
}
