use super::transfer::{FailureReason, TransferFailure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(super) const MAX_DOWNLOADS: usize = 4;
pub(super) const MAX_SEGMENTS: usize = 4;
const BACKGROUND_INTERRUPTED: &str = "后台下载已停止，点继续可接着下载";

pub(super) const fn default_segment_limit() -> usize {
    3
}

#[derive(Clone, Copy)]
pub(super) struct Capture {
    pub key: u64,
    pub fill: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Entry {
    pub id: i64,
    pub title: String,
    // None means every episode. A set combines repeated selections for one show.
    pub episodes: Option<BTreeSet<u32>>,
    pub paused: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub resume_in_foreground: bool,
    #[serde(skip)]
    pub capture: Option<Capture>,
    // Only cache-layer status text; transport URLs and raw errors are never stored here.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(skip)]
    previous: Option<Job>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone)]
struct ProgressBucket {
    started: Instant,
    cached_bytes: u64,
    network_bytes: u64,
    downloaded_units: u64,
}

#[derive(Clone)]
struct TransferWindow {
    started: Instant,
    minimum_units: u64,
    buckets: VecDeque<ProgressBucket>,
}

#[derive(Debug, PartialEq, Eq)]
struct TransferEstimate {
    cache_speed: Option<u64>,
    network_speed: Option<u64>,
    eta: Option<u64>,
}

impl TransferWindow {
    const DURATION: Duration = Duration::from_secs(30);

    fn new(now: Instant, minimum_units: u64) -> Self {
        Self {
            started: now,
            minimum_units,
            buckets: VecDeque::new(),
        }
    }

    fn record(
        &mut self,
        now: Instant,
        cached_bytes: u64,
        network_bytes: u64,
        downloaded_units: u64,
    ) {
        while self
            .buckets
            .front()
            .is_some_and(|bucket| now.duration_since(bucket.started) >= Self::DURATION)
        {
            self.buckets.pop_front();
        }
        if let Some(bucket) = self
            .buckets
            .back_mut()
            .filter(|bucket| now.duration_since(bucket.started) < Duration::from_secs(1))
        {
            bucket.cached_bytes += cached_bytes;
            bucket.network_bytes += network_bytes;
            bucket.downloaded_units += downloaded_units;
        } else {
            self.buckets.push_back(ProgressBucket {
                started: now,
                cached_bytes,
                network_bytes,
                downloaded_units,
            });
        }
    }

    fn estimate(&self, now: Instant, remaining: u64) -> TransferEstimate {
        let elapsed = now.duration_since(self.started).min(Self::DURATION);
        let (cached, network, older_units, recent_units) = self
            .buckets
            .iter()
            .filter(|bucket| now.duration_since(bucket.started) < Self::DURATION)
            .fold((0, 0, 0, 0), |(cached, network, older, recent), bucket| {
                let (older, recent) = if now.duration_since(bucket.started) >= Self::DURATION / 2 {
                    (older + bucket.downloaded_units, recent)
                } else {
                    (older, recent + bucket.downloaded_units)
                };
                (
                    cached + bucket.cached_bytes,
                    network + bucket.network_bytes,
                    older,
                    recent,
                )
            });
        // Use the elapsed portion of the window while the download is starting.
        let seconds = elapsed.as_secs_f64().max(1.0);
        let rate = |bytes: u64| (bytes as f64 / seconds) as u64;
        let full_window = elapsed == Self::DURATION;
        let units = older_units + recent_units;
        let steady = older_units.min(recent_units) * 2 >= older_units.max(recent_units);
        let eta = (full_window && remaining > 0 && units >= self.minimum_units && steady)
            .then(|| (seconds * remaining as f64 / units as f64).ceil() as u64);
        TransferEstimate {
            cache_speed: (full_window || cached > 0).then(|| rate(cached)),
            network_speed: (full_window || cached > 0 || network > 0).then(|| rate(network)),
            eta,
        }
    }
}

#[derive(Clone, Default, Serialize)]
pub(super) struct Job {
    pub running: bool,
    pub queued: bool,
    pub paused: bool,
    pub stopping: bool,
    pub id: i64,
    pub title: String,
    pub cover: Option<String>,
    pub ep: u32,
    pub done: usize,
    pub total: usize,
    pub transfer_done: u64,
    pub transfer_total: u64,
    bytes_per_second: Option<u64>,
    network_bytes_per_second: Option<u64>,
    episode_eta_seconds: Option<u64>,
    #[serde(skip)]
    transfer_window: Option<TransferWindow>,
    pub message: String,
    pub watch_key: Option<u64>,
    pub needs_fill: bool,
    #[serde(skip)]
    pub resource_retries: u64,
    #[serde(skip)]
    pub resource_retry_reason: Option<FailureReason>,
    #[serde(skip)]
    pub worker_id: u64,
    #[serde(skip)]
    pub reused_bytes: u64,
    #[serde(skip)]
    pub network_bytes: u64,
    #[serde(skip)]
    pub checkpoint_matches: u64,
    #[serde(skip)]
    pub checkpoint_changes: u64,
    #[serde(skip)]
    pub resume_capture_after_stop: bool,
}

impl Job {
    pub fn record_network_bytes(&mut self, bytes: usize) {
        self.network_bytes += bytes as u64;
        if let Some(window) = &mut self.transfer_window {
            window.record(Instant::now(), 0, bytes as u64, 0);
        }
    }

    pub fn begin_transfer(&mut self, total: u64, minimum_sample: u64) {
        self.transfer_done = 0;
        self.transfer_total = total;
        self.transfer_window = Some(TransferWindow::new(Instant::now(), minimum_sample));
    }

    pub fn advance_transfer(&mut self, units: u64, bytes: u64, reused: bool) {
        self.transfer_done += units;
        if reused {
            self.reused_bytes += bytes;
        }
        if let Some(window) = &mut self.transfer_window {
            window.record(Instant::now(), bytes, 0, if reused { 0 } else { units });
        }
    }

    fn snapshot(&self) -> Self {
        let mut snapshot = self.clone();
        if self.running && !self.stopping {
            if let Some(window) = &self.transfer_window {
                let estimate = window.estimate(
                    Instant::now(),
                    self.transfer_total.saturating_sub(self.transfer_done),
                );
                snapshot.bytes_per_second = estimate.cache_speed;
                snapshot.network_bytes_per_second = estimate.network_speed;
                snapshot.episode_eta_seconds = estimate.eta;
            }
        }
        snapshot
    }

    pub fn reset_transfer(&mut self) {
        self.transfer_done = 0;
        self.transfer_total = 0;
        self.transfer_window = None;
    }
}

impl Entry {
    pub fn new(
        id: i64,
        title: String,
        episodes: Option<BTreeSet<u32>>,
        capture: Option<Capture>,
    ) -> Self {
        Self {
            id,
            title,
            episodes,
            paused: false,
            resume_in_foreground: false,
            capture,
            message: String::new(),
            previous: None,
        }
    }

    pub fn resume(&mut self) {
        self.paused = false;
        self.resume_in_foreground = false;
        self.message.clear();
    }

    pub fn job(&self) -> Job {
        Job {
            id: self.id,
            title: self.title.clone(),
            paused: self.paused,
            queued: !self.paused,
            message: self.message.clone(),
            watch_key: self.capture.map(|capture| capture.key),
            ..self.previous.clone().unwrap_or_default()
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Pending {
    pub limit: usize,
    #[serde(default = "default_segment_limit")]
    pub segments: usize,
    #[serde(default = "default_allow_background")]
    pub allow_background: bool,
    pub entries: Vec<Entry>,
}

fn default_allow_background() -> bool {
    true
}

impl Default for Pending {
    fn default() -> Self {
        Self {
            limit: 2,
            segments: default_segment_limit(),
            allow_background: default_allow_background(),
            entries: Vec::new(),
        }
    }
}

impl Pending {
    pub fn read(root: &Path) -> Self {
        let Some(mut data) = std::fs::read(root.join("download-queue.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Self>(&raw).ok())
        else {
            return Self::default();
        };
        data.limit = data.limit.clamp(1, MAX_DOWNLOADS);
        data.segments = data.segments.clamp(1, MAX_SEGMENTS);
        let mut seen = BTreeSet::new();
        data.entries
            .retain(|entry| entry.id > 0 && seen.insert(entry.id));
        // 1.1.33 persisted only this fixed message for a system interruption.
        for entry in &mut data.entries {
            if entry.paused && entry.message == BACKGROUND_INTERRUPTED {
                entry.resume_in_foreground = true;
            }
        }
        data
    }

    pub fn persist(&self, root: &Path) -> Result<(), String> {
        let entries = self
            .entries
            .iter()
            .filter(|entry| entry.capture.is_none())
            .collect::<Vec<_>>();
        let path = root.join("download-queue.json");
        let temp = root.join("download-queue.tmp");
        let result =
            serde_json::to_vec(&serde_json::json!({ "limit": self.limit, "segments": self.segments, "allow_background": self.allow_background, "entries": entries }))
                .map_err(std::io::Error::other)
                .and_then(|raw| std::fs::write(&temp, raw))
                .and_then(|_| std::fs::rename(&temp, path));
        result.map_err(|_| "无法保存下载队列".into())
    }

    pub fn add(&mut self, incoming: Entry) -> Result<(), String> {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == incoming.id)
        {
            if entry.capture.is_some() || incoming.capture.is_some() {
                return Err("这部剧已有缓存任务".into());
            }
            match (&mut entry.episodes, incoming.episodes) {
                (Some(current), Some(extra)) => current.extend(extra),
                (_, None) => entry.episodes = None,
                (None, Some(_)) => {}
            }
            entry.resume();
        } else {
            self.entries.push(incoming);
        }
        Ok(())
    }
}

pub(super) type RunningJob = Arc<Mutex<Job>>;

#[derive(Default)]
pub(super) struct Queue {
    pub pending: Pending,
    pub active: BTreeMap<i64, RunningJob>,
    pub last: Option<Job>,
    pub backgrounded: bool,
    completed: u64,
    pub interrupted: u64,
    failed: u64,
}

#[repr(C)]
#[derive(Default)]
pub(crate) struct BackgroundSnapshot {
    pub completed: u64,
    pub interrupted: u64,
    pub failed: u64,
    pub remaining: u64,
    pub progress: u64,
}

impl Queue {
    #[cfg(any(target_os = "ios", test))]
    pub fn interrupt_background(&mut self, root: &Path) -> Result<(), String> {
        self.pending.entries.retain(|entry| entry.capture.is_none());
        self.pause_for_foreground(root)
    }

    #[cfg(any(target_os = "ios", test))]
    pub fn enter_background(&mut self, root: &Path) -> Result<bool, String> {
        self.backgrounded = true;
        if self.pending.allow_background || self.pending.entries.iter().all(|entry| entry.paused) {
            return Ok(false);
        }
        self.pause_for_foreground(root)?;
        Ok(true)
    }

    #[cfg(any(target_os = "ios", test))]
    fn pause_for_foreground(&mut self, root: &Path) -> Result<(), String> {
        for entry in &mut self.pending.entries {
            if !entry.paused {
                entry.paused = true;
                entry.resume_in_foreground = true;
                entry.message = BACKGROUND_INTERRUPTED.into();
                if entry.capture.is_some() {
                    if let Some(job) = self.active.get(&entry.id) {
                        let mut job = job.lock().unwrap();
                        job.resume_capture_after_stop = !job.stopping;
                    }
                }
            }
        }
        for job in self.active.values() {
            job.lock().unwrap().stopping = true;
        }
        self.pending.persist(root)
    }

    #[cfg(any(target_os = "ios", test))]
    pub fn resume_foreground(&mut self, root: &Path) -> Result<bool, String> {
        self.backgrounded = false;
        self.resume_interrupted(root, false)
    }

    #[cfg(any(target_os = "ios", test))]
    pub fn has_background_work(&self) -> bool {
        self.pending.allow_background
            && self.pending.entries.iter().any(|entry| {
                entry.capture.is_none() && (!entry.paused || entry.resume_in_foreground)
            })
    }

    #[cfg(any(target_os = "ios", test))]
    pub fn resume_background(&mut self, root: &Path) -> Result<bool, String> {
        if !self.has_background_work() {
            return Ok(false);
        }
        self.backgrounded = true;
        self.resume_interrupted(root, true)?;
        Ok(true)
    }

    #[cfg(any(target_os = "ios", test))]
    fn resume_interrupted(&mut self, root: &Path, background: bool) -> Result<bool, String> {
        let should_resume =
            |entry: &Entry| entry.resume_in_foreground && (!background || entry.capture.is_none());
        if !self.pending.entries.iter().any(should_resume) {
            return Ok(false);
        }
        self.change(root, |pending| {
            for entry in &mut pending.entries {
                if should_resume(entry) {
                    entry.resume();
                }
            }
            Ok(())
        })?;
        Ok(true)
    }

    pub fn background_snapshot(&self) -> BackgroundSnapshot {
        let mut snapshot = BackgroundSnapshot {
            completed: self.completed,
            interrupted: self.interrupted,
            failed: self.failed,
            ..BackgroundSnapshot::default()
        };
        for entry in &self.pending.entries {
            let active = self.active.get(&entry.id);
            if entry.paused && active.is_none() {
                continue;
            }
            snapshot.remaining += 1;
            let Some(job) = active else { continue };
            let job = job.lock().unwrap();
            if job.total == 0 {
                continue;
            }
            let transfer = if job.transfer_total == 0 || job.done >= job.total {
                0
            } else {
                job.transfer_done
                    .min(job.transfer_total)
                    .saturating_mul(1000)
                    / job.transfer_total
            };
            snapshot.progress += ((job.done as u64 * 1000 + transfer) / job.total as u64).min(1000);
        }
        // A canceled download can still be unwinding and removing its staging directory.
        snapshot.remaining += self
            .active
            .keys()
            .filter(|id| !self.pending.entries.iter().any(|entry| entry.id == **id))
            .count() as u64;
        snapshot
    }
    pub fn change(
        &mut self,
        root: &Path,
        change: impl FnOnce(&mut Pending) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.pending.clone();
        change(&mut next)?;
        next.persist(root)?;
        self.pending = next;
        Ok(())
    }

    pub fn reserve(&mut self) -> Vec<(Entry, RunningJob)> {
        if self.backgrounded && !self.pending.allow_background {
            return Vec::new();
        }
        let available = self.pending.limit.saturating_sub(self.active.len());
        let mut reserved = Vec::new();
        for entry in self.pending.entries.iter().filter(|entry| !entry.paused) {
            if reserved.len() == available {
                break;
            }
            if self.active.contains_key(&entry.id) {
                continue;
            }
            let mut job = entry.job();
            job.running = true;
            job.resume_capture_after_stop = false;
            job.reused_bytes = 0;
            job.network_bytes = 0;
            job.checkpoint_matches = 0;
            job.checkpoint_changes = 0;
            job.resource_retries = 0;
            job.resource_retry_reason = None;
            job.worker_id = super::diagnostics::worker_id();
            job.queued = false;
            let job = Arc::new(Mutex::new(job));
            self.active.insert(entry.id, job.clone());
            reserved.push((entry.clone(), job));
        }
        reserved
    }

    pub fn jobs(&self) -> Vec<Job> {
        self.pending
            .entries
            .iter()
            .map(|entry| {
                self.active
                    .get(&entry.id)
                    .map_or_else(|| entry.job(), |job| job.lock().unwrap().snapshot())
            })
            .collect()
    }

    pub fn finish(
        &mut self,
        root: &Path,
        entry: Entry,
        mut job: Job,
        result: Result<(), TransferFailure>,
    ) {
        self.active.remove(&entry.id);
        job.running = false;
        let stopped = job.stopping;
        job.stopping = false;
        let complete = result.is_ok();
        if !complete && !stopped && !job.needs_fill {
            self.failed += 1;
        }
        let can_retry = cfg!(any(target_os = "ios", test))
            && result
                .as_ref()
                .is_err_and(|error| error.retry_after.is_some());
        job.reset_transfer();
        job.message = match result {
            Ok(()) => "缓存完成".into(),
            Err(error) => error.message,
        };
        if let Some(current) = self
            .pending
            .entries
            .iter_mut()
            .find(|current| current.id == entry.id)
        {
            if !complete && (current.capture.is_none() || stopped && job.resume_capture_after_stop)
            {
                self.interrupted += 1;
                if !stopped {
                    current.paused = true;
                    current.resume_in_foreground = can_retry;
                    current.message = job.message.clone();
                }
                current.previous = Some(job.clone());
            } else if current.capture.is_some() || current.episodes == entry.episodes {
                if complete {
                    self.completed += 1;
                } else {
                    self.interrupted += 1;
                }
                self.pending
                    .entries
                    .retain(|current| current.id != entry.id);
            }
        }
        if let Err(error) = self.pending.persist(root) {
            self.failed += 1;
            super::diagnostics::record(
                root,
                "queue_persist_failed",
                serde_json::json!({"operation": "finish"}),
            );
            job.message = error;
        } else if stopped && !complete && (entry.capture.is_none() || job.resume_capture_after_stop)
        {
            job.message.clear();
        }
        self.last = Some(job);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i64, episodes: &[u32]) -> Entry {
        Entry::new(
            id,
            format!("剧集 {id}"),
            Some(episodes.iter().copied().collect()),
            None,
        )
    }

    fn temp_root() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT_ROOT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "hg-queue-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn legacy_queue_keeps_its_jobs_and_gets_the_default_segment_limit() {
        let root = temp_root();
        std::fs::write(
            root.join("download-queue.json"),
            r#"{"limit":1,"entries":[{"id":12,"title":"Fixture","episodes":[2],"paused":false}]}"#,
        )
        .unwrap();
        let mut pending = Pending::read(&root);
        assert_eq!((pending.limit, pending.segments), (1, 3));
        assert!(pending.allow_background);
        assert_eq!(pending.entries[0].episodes, Some(BTreeSet::from([2])));
        pending.segments = 4;
        pending.persist(&root).unwrap();
        let restored = Pending::read(&root);
        assert_eq!(
            (restored.limit, restored.segments, restored.entries[0].id),
            (1, 4, 12)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_expiration_stops_active_work_and_preserves_paused_queue_on_disk() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                pending.limit = 1;
                pending.add(entry(1, &[1, 2, 3, 4]))?;
                pending.add(entry(2, &[1]))?;
                let mut capture = entry(3, &[1]);
                capture.capture = Some(Capture {
                    key: 99,
                    fill: false,
                });
                pending.add(capture)
            })
            .unwrap();
        let (first, job) = queue.reserve().pop().unwrap();
        {
            let mut progress = job.lock().unwrap();
            progress.total = 4;
            progress.done = 1;
            progress.transfer_total = 8;
            progress.transfer_done = 4;
        }
        let snapshot = queue.background_snapshot();
        assert_eq!((snapshot.remaining, snapshot.progress), (3, 375));
        queue.interrupt_background(&root).unwrap();
        assert!(job.lock().unwrap().stopping);
        assert!(queue.reserve().is_empty());
        queue.finish(
            &root,
            first,
            job.lock().unwrap().clone(),
            Err("已停止缓存".into()),
        );
        let restored = Pending::read(&root);
        assert_eq!(restored.entries.len(), 2);
        assert!(restored.entries.iter().all(|entry| entry.paused));
        assert_eq!(
            restored.entries[0].episodes,
            Some(BTreeSet::from([1, 2, 3, 4]))
        );
        assert_eq!(queue.background_snapshot().remaining, 0);
        assert_eq!(queue.background_snapshot().failed, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returning_to_foreground_requeues_only_system_interruptions() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                pending.limit = 1;
                pending.add(entry(1, &[1, 2]))?;
                let mut manual = entry(2, &[1]);
                manual.paused = true;
                pending.add(manual)?;
                let mut failed = entry(3, &[1]);
                failed.paused = true;
                failed.message = "设备存储空间不足".into();
                pending.add(failed)
            })
            .unwrap();
        let (running, job) = queue.reserve().pop().unwrap();
        queue.interrupt_background(&root).unwrap();
        assert!(queue.resume_foreground(&root).unwrap());
        assert!(
            queue.reserve().is_empty(),
            "the old worker still owns its staging directory"
        );
        queue.finish(
            &root,
            running,
            job.lock().unwrap().clone(),
            Err("已停止缓存".into()),
        );
        assert_eq!(queue.reserve()[0].0.id, 1);
        assert!(!queue.resume_foreground(&root).unwrap());
        let stored = Pending::read(&root);
        assert!(!stored.entries[0].paused);
        assert!(stored.entries[1].paused);
        assert!(stored.entries[2].paused);
        assert_eq!(stored.entries[2].message, "设备存储空间不足");
        assert_eq!(queue.background_snapshot().failed, 0);

        // Older versions stored the message without the resume flag.
        std::fs::write(
            root.join("download-queue.json"),
            format!(r#"{{"limit":1,"entries":[{{"id":4,"title":"Fixture","episodes":[1],"paused":true,"message":"{BACKGROUND_INTERRUPTED}"}}]}}"#),
        ).unwrap();
        let mut restored = Queue {
            pending: Pending::read(&root),
            ..Queue::default()
        };
        assert!(restored.resume_foreground(&root).unwrap());
        assert_eq!(restored.reserve()[0].0.id, 4);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scheduled_background_recovery_preserves_user_pauses_and_respects_preference() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                pending.add(entry(1, &[2, 3]))?;
                let mut manual = entry(2, &[1]);
                manual.paused = true;
                pending.add(manual)
            })
            .unwrap();
        queue.interrupt_background(&root).unwrap();

        let mut restarted = Queue {
            pending: Pending::read(&root),
            ..Queue::default()
        };
        restarted.pending.allow_background = false;
        assert!(!restarted.resume_background(&root).unwrap());
        assert!(restarted.pending.entries.iter().all(|entry| entry.paused));
        restarted.pending.allow_background = true;
        assert!(restarted.resume_background(&root).unwrap());
        assert!(restarted.backgrounded);
        let reserved = restarted.reserve();
        assert_eq!(reserved.len(), 1);
        assert_eq!(reserved[0].0.id, 1);
        assert_eq!(reserved[0].0.episodes, Some(BTreeSet::from([2, 3])));
        assert!(Pending::read(&root).entries[1].paused);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exhausted_transient_failure_is_retried_on_foreground() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| pending.add(entry(1, &[1, 2])))
            .unwrap();
        let (work, job) = queue.reserve().pop().unwrap();
        let mut progress = job.lock().unwrap().clone();
        progress.done = 1;
        progress.transfer_done = 8;
        progress.transfer_total = 10;
        queue.finish(
            &root,
            work,
            progress,
            Err(TransferFailure::transient("网络中断", Duration::ZERO)),
        );
        assert!(queue.reserve().is_empty());
        assert_eq!(queue.jobs()[0].transfer_done, 0);
        assert!(Pending::read(&root).entries[0].resume_in_foreground);

        queue.pending = Pending::read(&root);
        assert!(queue.resume_foreground(&root).unwrap());
        assert_eq!(queue.reserve()[0].0.id, 1);
        assert!(!queue.resume_foreground(&root).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_speed_network_speed_and_eta_share_the_same_window() {
        let start = Instant::now();
        let mut window = TransferWindow::new(start, 3);
        let estimate = |cache_speed, network_speed, eta| TransferEstimate {
            cache_speed,
            network_speed,
            eta,
        };
        assert_eq!(window.estimate(start, 9), estimate(None, None, None));
        window.record(start + Duration::from_secs(1), 12_000, 15_000, 2);
        assert_eq!(
            window.estimate(start + Duration::from_secs(2), 9),
            estimate(Some(6_000), Some(7_500), None)
        );
        window.record(start + Duration::from_secs(28), 18_000, 21_000, 3);
        assert_eq!(
            window.estimate(start + Duration::from_secs(30), 10),
            estimate(Some(1_000), Some(1_200), Some(60))
        );
        assert_eq!(
            window.estimate(start + Duration::from_secs(40), 10),
            estimate(Some(600), Some(700), None)
        );
        assert_eq!(
            window.estimate(start + Duration::from_secs(58), 10),
            estimate(Some(0), Some(0), None)
        );
    }

    #[test]
    fn reused_segments_count_only_toward_cache_speed() {
        let mut job = Job {
            running: true,
            ..Job::default()
        };
        job.begin_transfer(20, 3);
        job.advance_transfer(10, 10_000, true);
        assert_eq!(job.transfer_done, 10);
        assert_eq!(job.reused_bytes, 10_000);
        let snapshot = job.snapshot();
        assert_eq!(snapshot.bytes_per_second, Some(10_000));
        assert_eq!(snapshot.network_bytes_per_second, Some(0));
        assert_eq!(snapshot.episode_eta_seconds, None);
        let window = job.transfer_window.as_ref().unwrap();
        assert_eq!(window.buckets[0].downloaded_units, 0);
        job.reset_transfer();
        assert!(job.transfer_window.is_none());
    }

    #[test]
    fn network_bytes_are_visible_before_the_first_cache_write() {
        let mut job = Job {
            running: true,
            ..Job::default()
        };
        job.begin_transfer(20, 3);
        job.record_network_bytes(2_000);
        let snapshot = job.snapshot();
        assert_eq!(snapshot.bytes_per_second, None);
        assert_eq!(snapshot.network_bytes_per_second, Some(2_000));
        assert_eq!(snapshot.transfer_done, 0);
    }

    #[test]
    fn foreground_only_downloads_pause_and_reopen_without_resuming_manual_pauses() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                pending.add(entry(1, &[1]))?;
                let mut manual = entry(2, &[1]);
                manual.paused = true;
                pending.add(manual)?;
                let mut capture = entry(3, &[1]);
                capture.capture = Some(Capture {
                    key: 1,
                    fill: false,
                });
                pending.add(capture)
            })
            .unwrap();
        let mut workers = queue.reserve().into_iter();
        let (regular, first) = workers.next().unwrap();
        let (capture, second) = workers.next().unwrap();
        assert!(!queue.enter_background(&root).unwrap());
        assert!(!first.lock().unwrap().stopping);

        queue
            .change(&root, |pending| {
                pending.allow_background = false;
                Ok(())
            })
            .unwrap();
        assert!(queue.enter_background(&root).unwrap());
        assert!(first.lock().unwrap().stopping);
        assert!(second.lock().unwrap().stopping);
        assert!(!Pending::read(&root).allow_background);
        assert!(queue.reserve().is_empty());
        queue.finish(
            &root,
            regular,
            first.lock().unwrap().clone(),
            Err("已停止缓存".into()),
        );
        queue
            .change(&root, |pending| pending.add(entry(4, &[1])))
            .unwrap();
        assert!(
            queue.reserve().is_empty(),
            "new workers must wait in the background"
        );

        // Foreground may resume the queue before the interrupted capture has finished unwinding.
        assert!(queue.resume_foreground(&root).unwrap());
        queue.finish(
            &root,
            capture,
            second.lock().unwrap().clone(),
            Err("已停止缓存".into()),
        );
        assert_eq!(
            queue
                .reserve()
                .iter()
                .map(|(entry, _)| entry.id)
                .collect::<Vec<_>>(),
            [1, 3]
        );
        assert!(queue.jobs().iter().find(|job| job.id == 2).unwrap().paused);
        assert_eq!(queue.background_snapshot().failed, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scheduler_caps_parallel_work_and_merges_selections_without_losing_them() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                for id in 1..=3 {
                    pending.add(entry(id, &[1]))?;
                }
                Ok(())
            })
            .unwrap();
        let mut reserved = queue.reserve().into_iter();
        let (first, first_job) = reserved.next().unwrap();
        let (second, second_job) = reserved.next().unwrap();
        assert_eq!((first.id, second.id), (1, 2));
        assert!(reserved.next().is_none());
        assert!(queue.reserve().is_empty());
        queue
            .change(&root, |pending| {
                pending.limit = 1;
                pending.add(entry(1, &[2]))
            })
            .unwrap();
        queue.finish(&root, first, first_job.lock().unwrap().clone(), Ok(()));
        assert!(queue.reserve().is_empty());
        queue.finish(&root, second, second_job.lock().unwrap().clone(), Ok(()));
        let (next, job) = queue.reserve().pop().unwrap();
        assert_eq!(next.id, 1);
        assert_eq!(next.episodes, Some(BTreeSet::from([1, 2])));
        queue.finish(&root, next, job.lock().unwrap().clone(), Ok(()));
        assert_eq!(queue.reserve().pop().unwrap().0.id, 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_restores_active_and_waiting_work_but_honors_pause() {
        let root = temp_root();
        let mut queue = Queue::default();
        queue
            .change(&root, |pending| {
                pending.limit = 1;
                pending.add(entry(1, &[2]))?;
                let mut paused = entry(2, &[3]);
                paused.paused = true;
                pending.add(paused)?;
                pending.add(entry(3, &[1]))?;
                let mut capture = entry(4, &[1]);
                capture.capture = Some(Capture {
                    key: 99,
                    fill: true,
                });
                pending.add(capture)
            })
            .unwrap();
        assert_eq!(queue.reserve()[0].0.id, 1);
        let mut reopened = Queue {
            pending: Pending::read(&root),
            ..Queue::default()
        };
        assert_eq!(reopened.pending.limit, 1);
        assert_eq!(
            reopened
                .jobs()
                .iter()
                .map(|job| (job.id, job.paused))
                .collect::<Vec<_>>(),
            [(1, false), (2, true), (3, false)]
        );
        let (work, job) = reopened.reserve().pop().unwrap();
        assert_eq!(work.episodes, Some(BTreeSet::from([2])));
        reopened.finish(
            &root,
            work,
            job.lock().unwrap().clone(),
            Err("线路异常".into()),
        );
        let failed = Pending::read(&root);
        assert!(failed.entries[0].paused);
        assert_eq!(failed.entries[0].message, "线路异常");
        assert_eq!(reopened.background_snapshot().failed, 1);
        assert_eq!(reopened.reserve().pop().unwrap().0.id, 3);
        std::fs::remove_dir_all(root).unwrap();
    }
}
