// Shared neu-CLI launch/teardown helpers for tests/test_conversion.js,
// tests/test_drop.js, tests/test_crop_ui.js. See [[neu-playwright-test-pattern]]
// for the underlying auth-token/PATH gotchas this codifies.
//
// NOTE: the Windows branch here is exercised regularly (this repo's dev
// machine is Windows); the macOS/Linux branch is reasoned through
// statically only -- it has not been run on real macOS/Linux hardware.
const cp = require('child_process');
const path = require('path');

// `neu` is not on PATH in a plain shell -- append the global npm bin dir to
// the child's PATH rather than invoking the neu.cmd/shim path directly
// (quoting through cmd.exe breaks on Windows; the same "append dir, don't
// invoke the shim path" strategy is used on macOS/Linux for consistency).
function neuEnv() {
  if (process.platform === 'win32') {
    const extraBinDir = path.join(process.env.APPDATA || '', 'npm');
    return { ...process.env, PATH: process.env.PATH + ';' + extraBinDir };
  }
  let extraBinDir;
  try {
    const prefix = cp.execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    extraBinDir = path.join(prefix, 'bin');
  } catch (e) {
    extraBinDir = '';
  }
  return { ...process.env, PATH: process.env.PATH + ':' + extraBinDir };
}

// Spawns `neu run -- --export-auth-info` from cwd. Returns the child
// process; caller is responsible for stdout/stderr piping and teardown via
// killNeuTree.
function spawnNeu(cwd) {
  const env = neuEnv();
  if (process.platform === 'win32') {
    return cp.spawn('cmd.exe', ['/c', 'neu run -- --export-auth-info'], { stdio: 'pipe', cwd, env });
  }
  // detached: true makes `neu` the leader of its own process group, so
  // killNeuTree can kill the whole group (neu run forks the actual
  // Neutralino binary as a child) the same way `taskkill /T` kills the tree
  // on Windows.
  return cp.spawn('sh', ['-c', 'neu run -- --export-auth-info'], { stdio: 'pipe', cwd, env, detached: true });
}

// Kills the neu process and any children it spawned (mirrors `taskkill
// /pid <pid> /T /F` on Windows -- a plain kill(pid) leaves the actual
// Neutralino binary running as an orphaned child).
function killNeuTree(pid) {
  if (process.platform === 'win32') {
    try {
      cp.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch (e) {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    try {
      cp.execSync(`pkill -P ${pid}`, { stdio: 'ignore' });
    } catch (e2) {
      /* already gone */
    }
  }
}

module.exports = { neuEnv, spawnNeu, killNeuTree };
