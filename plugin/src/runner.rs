//! Sidecar job runner: spawn, stream stderr/stdout lines as events, cancel
//! by job id (whole process tree), guaranteed single `finished` event.
//!
//! ponytail: duplicated (~100 lines) in the downloader plugin on purpose --
//! extract a shared crate when a third tool needs one (spec decision).
//!
//! Events (payload keys camelCase):
//! - `sorai-converter://log`      { jobId, line }
//! - `sorai-converter://progress` { jobId, percent }
//! - `sorai-converter://finished` { jobId, status: success|error|cancelled, message?, outSize? }

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// After a cancel, report `cancelled` this long later even if the process
/// never signals exit -- the UI can't get stuck in "Cancelling...".
const CANCEL_BACKSTOP: Duration = Duration::from_secs(3);

struct Running {
  child: Option<CommandChild>,
  cancelled: bool,
  out: PathBuf,
}

/// Plugin state (managed in `init`). An entry exists until `finished` is
/// emitted; whoever removes it emits, so that happens exactly once.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<u64, Running>>);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Log<'a> {
  job_id: u64,
  line: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
  job_id: u64,
  percent: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Finished {
  job_id: u64,
  status: &'static str,
  message: Option<String>,
  out_size: Option<u64>,
}

/// Splits raw output chunks on `\r` / `\n` (ffmpeg rewrites its progress
/// line with bare `\r`), decoding only whole lines so multi-byte UTF-8 file
/// names never get cut in half.
#[derive(Default)]
pub struct LineSplitter(Vec<u8>);

impl LineSplitter {
  pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
    self.0.extend_from_slice(chunk);
    let mut lines = vec![];
    while let Some(i) = self.0.iter().position(|b| *b == b'\r' || *b == b'\n') {
      let rest = self.0.split_off(i + 1);
      let line = String::from_utf8_lossy(&self.0[..i]).trim_end().to_string();
      self.0 = rest;
      if !line.is_empty() {
        lines.push(line);
      }
    }
    lines
  }

  pub fn finish(&mut self) -> Option<String> {
    let line = String::from_utf8_lossy(&std::mem::take(&mut self.0)).trim_end().to_string();
    (!line.is_empty()).then_some(line)
  }
}

fn finish<R: Runtime>(app: &AppHandle<R>, job_id: u64, status: &'static str, message: Option<String>, out: &PathBuf) {
  // A killed / failed encoder leaves a truncated file at the final name:
  // always remove it. The name was free before we started (unique_out_path).
  let out_size = if status == "success" {
    std::fs::metadata(out).ok().map(|m| m.len())
  } else {
    let _ = std::fs::remove_file(out);
    None
  };
  let _ = app.emit("sorai-converter://finished", Finished { job_id, status, message, out_size });
}

/// Spawns sidecar `program` and returns its job id right away. `progress`
/// maps an output line to a 0..=100 percent. `out` is the file the job
/// writes (sized on success, removed on failure / cancel).
pub fn start<R: Runtime>(
  app: &AppHandle<R>,
  program: &str,
  args: Vec<String>,
  out: PathBuf,
  progress: impl Fn(&str) -> Option<f64> + Send + Sync + 'static,
) -> Result<u64, String> {
  let job_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let header = format!("> Executing: {}", crate::convert::display_command(program, &args));
  let (mut rx, child) = app
    .shell()
    .sidecar(program)
    .map_err(|e| e.to_string())?
    .args(args)
    .set_raw_out(true)
    // Job object (Windows) / process group (POSIX): kill takes the whole tree.
    .set_process_group(true)
    .spawn()
    .map_err(|e| e.to_string())?;
  app.state::<Jobs>().0.lock().unwrap().insert(job_id, Running { child: Some(child), cancelled: false, out });
  let _ = app.emit("sorai-converter://log", Log { job_id, line: &header });

  let app = app.clone();
  let program = program.to_string();
  tauri::async_runtime::spawn(async move {
    let (mut out_lines, mut err_lines) = (LineSplitter::default(), LineSplitter::default());
    let mut last_line = String::new();
    let mut code = None;
    let handle = |line: String, last: &mut String| {
      if let Some(percent) = progress(&line) {
        let _ = app.emit("sorai-converter://progress", Progress { job_id, percent });
      }
      let _ = app.emit("sorai-converter://log", Log { job_id, line: &line });
      *last = line;
    };
    while let Some(event) = rx.recv().await {
      match event {
        CommandEvent::Stdout(b) => out_lines.push(&b).into_iter().for_each(|l| handle(l, &mut last_line)),
        CommandEvent::Stderr(b) => err_lines.push(&b).into_iter().for_each(|l| handle(l, &mut last_line)),
        CommandEvent::Terminated(t) => code = t.code,
        CommandEvent::Error(e) => last_line = e,
        _ => {}
      }
    }
    for l in [out_lines.finish(), err_lines.finish()].into_iter().flatten() {
      handle(l, &mut last_line);
    }
    let Some(job) = app.state::<Jobs>().0.lock().unwrap().remove(&job_id) else {
      return; // the cancel backstop already reported it
    };
    match (job.cancelled, code) {
      (true, _) => finish(&app, job_id, "cancelled", None, &job.out),
      (false, Some(0)) => finish(&app, job_id, "success", None, &job.out),
      (false, c) => {
        let code = c.map_or("unknown".into(), |c| c.to_string());
        finish(&app, job_id, "error", Some(format!("{program} exited with code {code}: {last_line}")), &job.out)
      }
    }
  });
  Ok(job_id)
}

/// Kills the job's process tree. Unknown / finished ids are a no-op.
pub fn cancel<R: Runtime>(app: &AppHandle<R>, job_id: u64) {
  let child = {
    let jobs = app.state::<Jobs>();
    let mut jobs = jobs.0.lock().unwrap();
    let Some(job) = jobs.get_mut(&job_id) else { return };
    job.cancelled = true;
    job.child.take()
  };
  if let Some(child) = child {
    std::thread::spawn(move || child.kill()); // blocks until exit
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(CANCEL_BACKSTOP);
    let job = app.state::<Jobs>().0.lock().unwrap().remove(&job_id);
    if let Some(job) = job {
      finish(&app, job_id, "cancelled", Some("timed out waiting for process exit".into()), &job.out);
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn splits_on_cr_and_lf_across_chunks() {
    let mut s = LineSplitter::default();
    assert_eq!(s.push(b"frame=1 time=00:00:01.00\rframe=2 ti"), ["frame=1 time=00:00:01.00"]);
    assert_eq!(s.push(b"me=00:00:02.00\r\n\nDone"), ["frame=2 time=00:00:02.00"]);
    assert_eq!(s.finish().as_deref(), Some("Done"));
    assert_eq!(s.finish(), None);
  }

  #[test]
  fn never_splits_a_multibyte_char() {
    let bytes = "Input #0, from '影片.mp4':\n".as_bytes();
    let mut s = LineSplitter::default();
    let (a, b) = bytes.split_at(17); // inside 影
    assert!(s.push(a).is_empty());
    assert_eq!(s.push(b), ["Input #0, from '影片.mp4':"]);
  }
}
