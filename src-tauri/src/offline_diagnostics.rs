use super::{FailureReason, Job, TransferFailure};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 128 * 1024;
static WRITER: Mutex<()> = Mutex::new(());
static NEXT_WORKER: AtomicU64 = AtomicU64::new(1);

pub(super) fn worker_id() -> u64 {
    NEXT_WORKER.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize)]
pub(super) struct Failure {
    reason: FailureReason,
    stage: &'static str,
    retryable: bool,
}

impl From<&TransferFailure> for Failure {
    fn from(error: &TransferFailure) -> Self {
        Self {
            reason: error.reason,
            stage: error.stage,
            retryable: error.retry_after.is_some(),
        }
    }
}

pub(super) fn worker(
    root: &Path,
    event: &'static str,
    job: &Job,
    elapsed_ms: u128,
    failure: Option<Failure>,
) {
    record(
        root,
        event,
        json!({
            "worker": job.worker_id,
            "source": if job.watch_key.is_some() { "recent_playback" } else { "offline_queue" },
            "episode": job.ep,
            "completed": job.done,
            "total": job.total,
            "resource_retries": job.resource_retries,
            "reused_bytes": job.reused_bytes,
            "network_bytes": job.network_bytes,
            "last_resource_retry_reason": job.resource_retry_reason,
            "elapsed_ms": elapsed_ms,
            "failure": failure,
        }),
    );
}

pub(super) fn record(root: &Path, event: &'static str, data: Value) {
    let row = json!({
        "timestamp_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "pid": std::process::id(),
        "event": event,
        "data": data,
    });
    let _ = append(root, row, MAX_LOG_BYTES);
}

fn append(root: &Path, row: Value, limit: u64) -> io::Result<()> {
    let mut line = serde_json::to_vec(&row)?;
    line.push(b'\n');
    let _guard = WRITER
        .lock()
        .map_err(|_| io::Error::other("download log lock"))?;
    let current = root.join("download-diagnostics.jsonl");
    let previous = root.join("download-diagnostics.previous.jsonl");
    if fs::metadata(&current).is_ok_and(|meta| meta.len() + line.len() as u64 > limit) {
        fs::rename(&current, previous)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)?
        .write_all(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_rotate_and_omit_untrusted_details() {
        let root = std::env::temp_dir().join(format!("hg-download-log-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let old = json!({"fixture":"old"});
        append(&root, old.clone(), 30).unwrap();
        append(&root, json!({"fixture":"new"}), 30).unwrap();
        let previous =
            fs::read_to_string(root.join("download-diagnostics.previous.jsonl")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&previous).unwrap(), old);

        let secret = "example.invalid/?credential=fixture";
        let error = TransferFailure::from(secret);
        let mut job = Job::default();
        job.worker_id = 1;
        worker(
            &root,
            "worker_failed",
            &job,
            12,
            Some(Failure::from(&error)),
        );
        let current = fs::read_to_string(root.join("download-diagnostics.jsonl")).unwrap();
        assert!(!current.contains(secret));
        let last = serde_json::from_str::<Value>(current.lines().last().unwrap()).unwrap();
        assert_eq!(last["data"]["worker"], 1);
        assert_eq!(last["data"]["failure"]["reason"], "other");
        fs::remove_dir_all(root).unwrap();
    }
}
