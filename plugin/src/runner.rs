//! Sidecar job runner: spawn, stream stderr/stdout lines as events, cancel
//! by job id (whole process tree), guaranteed single `finished` event.
//!
//! ponytail: duplicated (~100 lines) in the downloader plugin on purpose --
//! extract a shared crate when a third tool needs one (spec decision).
//!
//! Events go to the job's own `tauri::ipc::Channel` (like the downloader's):
//! - `{ event: 'log', line }`
//! - `{ event: 'progress', percent }`
//! - `{ event: 'finished', status: success|error|cancelled, message?, outSize?, notSmaller? }`
//!
//! `start_task` runs in-process Rust work (the PDF compressor) the same way.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// After a cancel, report `cancelled` this long later even if the process
/// never signals exit -- the UI can't get stuck in "Cancelling...".
const CANCEL_BACKSTOP: Duration = Duration::from_secs(3);

struct Running {
  child: Option<CommandChild>,
  /// Shared with an in-process task, which polls it (kill can't stop it).
  cancelled: Arc<AtomicBool>,
  out: PathBuf,
  channel: Channel<JobEvent>,
}

/// Plugin state (managed in `init`). An entry exists until `finished` is
/// emitted; whoever removes it emits, so that happens exactly once.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<u64, Running>>);

impl Jobs {
  /// App exit: kill every running job's process tree (waits for it), then
  /// remove its partial output -- in that order, Windows won't delete a file
  /// ffmpeg still has open. No `finished` is sent (nobody listens any more).
  pub fn kill_all(&self) {
    let jobs: Vec<Running> = self.0.lock().unwrap().drain().map(|(_, j)| j).collect();
    for job in jobs {
      job.cancelled.store(true, Ordering::Relaxed);
      if let Some(child) = job.child {
        let _ = child.kill();
      }
      let _ = std::fs::remove_file(&job.out);
    }
  }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobEvent {
  Log { line: String },
  Progress { percent: f64 },
  /// Sent exactly once per job.
  /// `not_smaller`: success, but the output is a copy of the source.
  Finished {
    status: &'static str,
    message: Option<String>,
    out_size: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    not_smaller: bool,
  },
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

fn finish(job: Running, status: &'static str, message: Option<String>, not_smaller: bool) {
  let out = &job.out;
  // A killed / failed encoder leaves a truncated file at the final name:
  // always remove it. The name was free before we started (unique_out_path).
  let out_size = if status == "success" {
    std::fs::metadata(out).ok().map(|m| m.len())
  } else {
    let _ = std::fs::remove_file(out);
    None
  };
  let _ = job.channel.send(JobEvent::Finished { status, message, out_size, not_smaller });
}

/// Same wording as the old JS pre-flight check.
fn install_hint(program: &str) -> &'static str {
  match program {
    "qpdf" => ". qpdf not found: install it via 'brew install qpdf' (macOS) or 'sudo apt install qpdf' (Linux), then restart the app.",
    "img2pdf" => ". img2pdf not found: install it via 'pip install img2pdf' (macOS/Linux), then restart the app.",
    _ => "",
  }
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
  channel: Channel<JobEvent>,
) -> Result<u64, String> {
  let job_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let header = format!("> Executing: {}", crate::convert::display_command(program, &args));
  // Bundled copy (see sidecar.rs), else PATH: the hub bundles qpdf / img2pdf
  // on Windows only -- on macOS / Linux they're system installs.
  let (mut rx, child) = crate::sidecar::command(app, program)
    .args(args)
    .set_raw_out(true)
    // Job object (Windows) / process group (POSIX): kill takes the whole tree.
    .set_process_group(true)
    .spawn()
    .map_err(|e| format!("{program}: {e}{}", install_hint(program)))?;
  let _ = channel.send(JobEvent::Log { line: header });
  app.state::<Jobs>().0.lock().unwrap().insert(job_id, Running { child: Some(child), cancelled: Default::default(), out, channel: channel.clone() });

  let app = app.clone();
  let program = program.to_string();
  tauri::async_runtime::spawn(async move {
    let (mut out_lines, mut err_lines) = (LineSplitter::default(), LineSplitter::default());
    let mut last_line = String::new();
    let mut code = None;
    let handle = |line: String, last: &mut String| {
      if let Some(percent) = progress(&line) {
        let _ = channel.send(JobEvent::Progress { percent });
      }
      *last = line.clone();
      let _ = channel.send(JobEvent::Log { line });
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
      return; // the cancel backstop (or app exit) already took it
    };
    match (job.cancelled.load(Ordering::Relaxed), code) {
      (true, _) => finish(job, "cancelled", None, false),
      (false, Some(0)) => finish(job, "success", None, false),
      (false, c) => {
        let code = c.map_or("unknown".into(), |c| c.to_string());
        finish(job, "error", Some(format!("{program} exited with code {code}: {last_line}")), false)
      }
    }
  });
  Ok(job_id)
}

/// Runs `work(cancelled, progress)` on a thread, as a job like `start`'s:
/// same `Jobs` entry, cancel, single `finished`. `header` is logged as
/// `> Executing: <header>` (hub E2E counts those lines). `work` builds the
/// output (bytes + not-smaller flag) in memory; it's written to `out` only after the job is taken out
/// of `Jobs`, so a cancel backstop / app exit can't delete it mid-write or
/// race a late write after cleaning up.
pub fn start_task<R: Runtime>(
  app: &AppHandle<R>,
  header: &str,
  out: PathBuf,
  channel: Channel<JobEvent>,
  work: impl FnOnce(&AtomicBool, &dyn Fn(f64)) -> Result<crate::pdf_compress::Outcome, String> + Send + 'static,
) -> u64 {
  let job_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let cancelled = Arc::new(AtomicBool::new(false));
  let _ = channel.send(JobEvent::Log { line: format!("> Executing: {header}") });
  let running = Running { child: None, cancelled: cancelled.clone(), out, channel: channel.clone() };
  app.state::<Jobs>().0.lock().unwrap().insert(job_id, running);

  let app = app.clone();
  std::thread::spawn(move || {
    let result = work(&cancelled, &|percent| _ = channel.send(JobEvent::Progress { percent }));
    let Some(job) = app.state::<Jobs>().0.lock().unwrap().remove(&job_id) else {
      return; // the cancel backstop (or app exit) already took it
    };
    match result {
      _ if job.cancelled.load(Ordering::Relaxed) => finish(job, "cancelled", None, false),
      Err(e) => finish(job, "error", Some(e), false),
      Ok(o) => match std::fs::write(&job.out, &o.bytes) {
        Ok(()) => finish(job, "success", None, o.not_smaller),
        Err(e) => {
          let message = format!("{}: {e}", job.out.display());
          finish(job, "error", Some(message), false)
        }
      },
    }
  });
  job_id
}

/// Kills the job's process tree (sidecar) or flags it (task). Unknown / finished ids are a no-op.
pub fn cancel<R: Runtime>(app: &AppHandle<R>, job_id: u64) {
  let child = {
    let jobs = app.state::<Jobs>();
    let mut jobs = jobs.0.lock().unwrap();
    let Some(job) = jobs.get_mut(&job_id) else { return };
    job.cancelled.store(true, Ordering::Relaxed);
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
      finish(job, "cancelled", Some("timed out waiting for process exit".into()), false);
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
