#[cfg(test)]
use crate::network_policy;
use crate::{media, net, watch};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::http::{header, Response};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
};

#[path = "offline_diagnostics.rs"]
mod diagnostics;

#[path = "offline_queue.rs"]
mod queue;
#[cfg(target_os = "ios")]
pub(crate) use queue::BackgroundSnapshot;
use queue::{Capture, Entry, Job, Pending, Queue, RunningJob, MAX_DOWNLOADS, MAX_SEGMENTS};

#[path = "offline_transfer.rs"]
mod transfer;
#[cfg(test)]
use transfer::{best_variant, save_mp4};
use transfer::{
    save_video, wait_to_retry, FailureReason, TransferFailure, TransferOptions, HLS_ASSETS,
    HLS_CHECKPOINT, HLS_PACKAGE,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Episode {
    id: i64,
    ep: u32,
    title: String,
    bytes: u64,
    mp4: bool,
}

#[derive(Serialize, Deserialize)]
struct Show {
    episodes: Vec<u32>,
    #[serde(default)]
    cover: bool,
}

fn show_dir(root: &Path, id: i64) -> PathBuf {
    root.join("shows").join(id.to_string())
}

fn read_show(root: &Path, id: i64) -> Option<Show> {
    let dir = show_dir(root, id);
    let mut show: Show =
        serde_json::from_slice(&std::fs::read(dir.join("info.json")).ok()?).ok()?;
    show.cover = dir.join("cover").is_file();
    Some(show)
}

fn episode_numbers(detail: &serde_json::Value) -> Vec<u32> {
    let mut episodes = detail
        .get("episodes")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("ep_num")?.as_u64()?.try_into().ok())
        .filter(|&number| number > 0)
        .collect::<Vec<u32>>();
    episodes.sort_unstable();
    episodes.dedup();
    episodes
}

fn save_show(
    root: &Path,
    id: i64,
    episodes: Vec<u32>,
    cover: Option<&[u8]>,
) -> std::io::Result<()> {
    let dir = show_dir(root, id);
    std::fs::create_dir_all(&dir)?;
    if let Some(cover) = cover {
        let temp = dir.join("cover.tmp");
        if std::fs::write(&temp, cover)
            .and_then(|_| std::fs::rename(&temp, dir.join("cover")))
            .is_err()
        {
            let _ = std::fs::remove_file(temp);
        }
    }
    let show = Show {
        episodes,
        cover: dir.join("cover").is_file(),
    };
    let temp = dir.join("info.tmp");
    std::fs::write(&temp, serde_json::to_vec(&show)?)?;
    std::fs::rename(temp, dir.join("info.json"))
}

async fn load_show_cover(detail: &serde_json::Value) -> Option<std::sync::Arc<Vec<u8>>> {
    let url = detail.get("cover")?.as_str()?;
    let (_, bytes) = tokio::time::timeout(Duration::from_secs(4), media::load_image(url))
        .await
        .ok()?
        .ok()?;
    (bytes.len() <= 2 * 1024 * 1024 && media::image_kind(&bytes).is_some()).then_some(bytes)
}

#[derive(Default)]
pub struct Cache {
    root: Mutex<Option<PathBuf>>,
    queue: Mutex<Queue>,
}

impl Cache {
    #[cfg(target_os = "ios")]
    pub fn mp4_path(&self, id: i64, ep: u32) -> Result<PathBuf, String> {
        let file = path(&self.root()?, id, ep).join("video.mp4");
        if id > 0 && ep > 0 && file.is_file() {
            Ok(file)
        } else {
            Err("找不到本地视频".into())
        }
    }

    pub fn bind(&self, root: PathBuf) {
        if std::fs::create_dir_all(&root).is_err() {
            return;
        }
        let _ = std::fs::remove_dir_all(root.join(".partial"));
        cleanup_detached(&root, root.join(".trash"));
        let pending = Pending::read(&root);
        prune_staging(&root, &pending);
        self.queue.lock().unwrap().pending = pending;
        *self.root.lock().unwrap() = Some(root);
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "本地缓存目录不可用".into())
    }
}

fn check_job(job: &Mutex<Job>) -> Result<(), String> {
    if job.lock().unwrap().stopping {
        Err("已停止缓存".into())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "ios")]
pub fn saved_root(legacy: PathBuf, data: &Path) -> PathBuf {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};

    let parent = data.join("saved-media");
    if std::fs::create_dir_all(&parent).is_err() {
        return legacy;
    }
    let Some(parent_path) = parent.to_str() else {
        return legacy;
    };
    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(parent_path), true);
    let excluded = NSNumber::numberWithBool(true);
    let value: &objc2::runtime::AnyObject = &excluded;
    // The backup resource key accepts a boolean NSNumber.
    if unsafe { url.setResourceValue_forKey_error(Some(value), NSURLIsExcludedFromBackupKey) }
        .is_err()
    {
        return legacy;
    }
    let saved = parent.join("offline-videos");
    if legacy.exists() && !saved.exists() && std::fs::rename(&legacy, &saved).is_err() {
        return legacy;
    }
    saved
}

fn path(root: &Path, id: i64, ep: u32) -> PathBuf {
    root.join(format!("{id}-{ep}"))
}

fn read_episode(root: &Path, directory: &Path) -> Option<Episode> {
    let raw = std::fs::read(directory.join("info.json")).ok()?;
    let item: Episode = serde_json::from_slice(&raw).ok()?;
    let media = if item.mp4 { "video.mp4" } else { "index.m3u8" };
    (directory == path(root, item.id, item.ep) && directory.join(media).is_file()).then_some(item)
}

fn list(root: &Path) -> Result<Vec<Episode>, String> {
    let mut items = std::fs::read_dir(root)
        .map_err(|_| "无法读取缓存目录")?
        .flatten()
        .filter_map(|entry| read_episode(root, &entry.path()))
        .collect::<Vec<_>>();
    items.sort_by_key(|item| (item.id, item.ep));
    Ok(items)
}

#[tauri::command]
pub fn offline_episode(cache: tauri::State<'_, Cache>, id: i64, ep: u32) -> Option<Episode> {
    if id <= 0 || ep == 0 {
        return None;
    }
    let root = cache.root().ok()?;
    read_episode(&root, &path(&root, id, ep))
}

#[tauri::command]
pub fn offline_status(cache: tauri::State<'_, Cache>) -> Result<serde_json::Value, String> {
    let root = cache.root()?;
    let items = list(&root)?;
    let bytes = items.iter().map(|item| item.bytes).sum::<u64>();
    let cached_episodes: BTreeSet<_> = items.iter().map(|item| (item.id, item.ep)).collect();
    let mut shows = BTreeMap::new();
    for id in items
        .iter()
        .map(|item| item.id)
        .collect::<std::collections::BTreeSet<_>>()
    {
        if let Some(show) = read_show(&root, id) {
            shows.insert(id, show);
        }
    }
    let recent = watch::recent()
        .into_iter()
        .filter(|recent| !cached_episodes.contains(&(recent.id, recent.ep)))
        .collect::<Vec<_>>();
    let (jobs, last) = {
        let queue = cache.queue.lock().unwrap();
        (queue.jobs(), queue.last.clone())
    };
    #[cfg(target_os = "ios")]
    let background = if background_allowed(&cache) {
        crate::ios_download_background::status()
    } else {
        "disabled"
    };
    #[cfg(not(target_os = "ios"))]
    let background = "unsupported";
    Ok(serde_json::json!({
        "items": items, "bytes": bytes, "shows": shows, "recent": recent,
        "jobs": jobs, "last": last, "background": background,
    }))
}

#[cfg(target_os = "ios")]
pub fn background_snapshot(cache: &Cache) -> BackgroundSnapshot {
    cache.queue.lock().unwrap().background_snapshot()
}

#[cfg(target_os = "ios")]
pub fn log_background(cache: &Cache, event: &'static str, code: Option<i64>) {
    if let Ok(root) = cache.root() {
        let snapshot = background_snapshot(cache);
        diagnostics::record(
            &root,
            event,
            serde_json::json!({
                "scheduler_code": code,
                "remaining": snapshot.remaining,
                "completed": snapshot.completed,
                "interrupted": snapshot.interrupted,
                "failed": snapshot.failed,
            }),
        );
    }
}

#[cfg(target_os = "ios")]
pub fn background_allowed(cache: &Cache) -> bool {
    cache.queue.lock().unwrap().pending.allow_background
}

#[cfg(target_os = "ios")]
pub fn has_background_work(cache: &Cache) -> bool {
    cache.queue.lock().unwrap().has_background_work()
}

#[cfg(target_os = "ios")]
pub fn resume_background(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let cache = app.state::<Cache>();
    let Ok(root) = cache.root() else { return false };
    let resumed = cache.queue.lock().unwrap().resume_background(&root);
    match resumed {
        Ok(true) => {
            log_background(&cache, "background_recovery_running", None);
            fill_slots(app);
            true
        }
        Ok(false) => false,
        Err(_) => {
            diagnostics::record(
                &root,
                "queue_persist_failed",
                serde_json::json!({"operation": "background_recovery_resume"}),
            );
            false
        }
    }
}

#[cfg(target_os = "ios")]
pub fn enter_background(cache: &Cache) {
    if let Ok(root) = cache.root() {
        let suspended = cache.queue.lock().unwrap().enter_background(&root);
        match suspended {
            Ok(true) => log_background(cache, "background_paused_by_preference", None),
            Ok(false) => {}
            Err(_) => diagnostics::record(
                &root,
                "queue_persist_failed",
                serde_json::json!({"operation": "background_preference_pause"}),
            ),
        }
    }
}

#[cfg(target_os = "ios")]
pub fn pause_background(cache: &Cache, recover: bool) {
    if let Ok(root) = cache.root() {
        let result = cache
            .queue
            .lock()
            .unwrap()
            .interrupt_background(&root, recover);
        if result.is_err() {
            diagnostics::record(
                &root,
                "queue_persist_failed",
                serde_json::json!({"operation": "background_pause"}),
            );
        }
    }
}

#[cfg(target_os = "ios")]
pub fn resume_foreground(app: &tauri::AppHandle) {
    use tauri::Manager;
    let cache = app.state::<Cache>();
    let Ok(root) = cache.root() else { return };
    let resumed = cache.queue.lock().unwrap().resume_foreground(&root);
    match resumed {
        Ok(resumed) => {
            if resumed {
                log_background(&cache, "foreground_resumed", None);
            }
            fill_slots(app);
        }
        Err(_) => diagnostics::record(
            &root,
            "queue_persist_failed",
            serde_json::json!({"operation": "foreground_resume"}),
        ),
    }
}

#[tauri::command]
pub fn offline_background_start(cache: tauri::State<'_, Cache>) -> Result<(), String> {
    let queue = cache.queue.lock().unwrap();
    #[cfg(target_os = "ios")]
    if !queue.pending.allow_background {
        return Err("请在设置中开启允许后台下载".into());
    }
    if queue.background_snapshot().remaining == 0 {
        return Err("没有待后台下载的任务".into());
    }
    drop(queue);
    #[cfg(target_os = "ios")]
    {
        if crate::ios_download_background::status() == "unsupported" {
            return Err("需要 iOS 26 或更新版本".into());
        }
        crate::ios_download_background::request();
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    Err("这台设备不支持此后台下载方式".into())
}

#[tauri::command]
pub fn offline_stop(cache: tauri::State<'_, Cache>, id: i64) -> Result<(), String> {
    let root = cache.root()?;
    let mut queue = cache.queue.lock().unwrap();
    if let Some(job) = queue.active.get(&id) {
        let mut job = job.lock().unwrap();
        if job.watch_key.is_some() {
            job.stopping = true;
            job.resume_capture_after_stop = false;
        }
    } else {
        let queued = queue
            .pending
            .entries
            .iter()
            .any(|entry| entry.id == id && entry.capture.is_some());
        queue.change(&root, |pending| {
            pending
                .entries
                .retain(|entry| entry.id != id || entry.capture.is_none());
            Ok(())
        })?;
        if queued {
            queue.interrupted += 1;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn offline_pause(cache: tauri::State<'_, Cache>, id: i64) -> Result<(), String> {
    let root = cache.root()?;
    let mut queue = cache.queue.lock().unwrap();
    let queued = !queue.active.contains_key(&id)
        && queue
            .pending
            .entries
            .iter()
            .any(|entry| entry.id == id && !entry.paused);
    queue.change(&root, |pending| {
        let entry = pending
            .entries
            .iter_mut()
            .find(|entry| entry.id == id && entry.capture.is_none())
            .ok_or("这部剧没有待下载任务")?;
        entry.paused = true;
        entry.resume_in_foreground = false;
        entry.resume_in_background = false;
        entry.message.clear();
        Ok(())
    })?;
    if let Some(job) = queue.active.get(&id) {
        job.lock().unwrap().stopping = true;
    }
    if queued {
        queue.interrupted += 1;
    }
    let worker = queue
        .active
        .get(&id)
        .map(|job| job.lock().unwrap().worker_id);
    drop(queue);
    diagnostics::record(&root, "user_paused", serde_json::json!({"worker": worker}));
    Ok(())
}

#[tauri::command]
pub fn offline_cancel(cache: tauri::State<'_, Cache>, id: i64) -> Result<(), String> {
    let root = cache.root()?;
    let mut queue = cache.queue.lock().unwrap();
    let canceled = queue
        .pending
        .entries
        .iter()
        .any(|entry| entry.id == id && entry.capture.is_none() && !entry.paused);
    queue.change(&root, |pending| {
        pending
            .entries
            .retain(|entry| entry.id != id || entry.capture.is_some());
        Ok(())
    })?;
    if let Some(job) = queue.active.get(&id) {
        let mut job = job.lock().unwrap();
        if job.watch_key.is_none() {
            job.stopping = true;
        }
    }
    let detached = if !queue.active.contains_key(&id)
        && !queue.pending.entries.iter().any(|entry| entry.id == id)
    {
        discard_staging(&root, id)
    } else {
        None
    };
    if canceled {
        queue.interrupted += 1;
    }
    let worker = queue
        .active
        .get(&id)
        .map(|job| job.lock().unwrap().worker_id);
    drop(queue);
    if let Some(detached) = detached {
        cleanup_detached(&root, detached);
    }
    diagnostics::record(
        &root,
        "user_canceled",
        serde_json::json!({"worker": worker}),
    );
    Ok(())
}

#[tauri::command]
pub fn offline_delete(
    cache: tauri::State<'_, Cache>,
    id: i64,
    ep: Option<u32>,
) -> Result<(), String> {
    delete_cached(&cache, id, ep)
}

fn delete_cached(cache: &Cache, id: i64, ep: Option<u32>) -> Result<(), String> {
    let root = cache.root()?;
    let mut detached = Vec::new();
    // Only rename while holding the queue lock. Recursive deletion happens after
    // release, and therefore cannot erase a new worker's directory for this id.
    let result: Result<(), String> = (|| {
        let mut queue = cache.queue.lock().unwrap();
        if queue.active.contains_key(&id)
            || queue
                .pending
                .entries
                .iter()
                .any(|entry| entry.id == id && !entry.paused)
        {
            return Err("请先暂停这部剧的下载".into());
        }
        let episodes = cached_episode_paths(&root, id)?;
        for (number, directory) in &episodes {
            if ep.is_none_or(|ep| *number == ep) {
                if let Some(directory) =
                    detach_for_cleanup(&root, directory).map_err(|_| "删除缓存失败")?
                {
                    detached.push(directory);
                }
            }
        }
        let remaining = ep.is_some_and(|ep| episodes.iter().any(|(number, _)| *number != ep));
        if !remaining {
            if let Some(directory) = detach_for_cleanup(&root, &show_dir(&root, id))
                .map_err(|_| "删除剧集封面和信息失败")?
            {
                detached.push(directory);
            }
        }
        if ep.is_none() {
            queue.change(&root, |pending| {
                pending.entries.retain(|entry| entry.id != id);
                Ok(())
            })?;
            if let Some(directory) =
                detach_for_cleanup(&root, &stage_path(&root, id)).map_err(|_| "清理下载暂存失败")?
            {
                detached.push(directory);
            }
        }
        Ok(())
    })();
    let mut cleanup_failed = false;
    for directory in detached {
        cleanup_failed |= !cleanup_detached(&root, directory);
    }
    result?;
    if cleanup_failed {
        return Err("缓存已移除，部分文件将在下次启动时继续清理".into());
    }
    Ok(())
}

// Directory names identify committed episode packages; do not read every
// episode's metadata while blocking pause/cancel requests for unrelated shows.
fn cached_episode_paths(root: &Path, id: i64) -> Result<Vec<(u32, PathBuf)>, String> {
    let prefix = format!("{id}-");
    Ok(std::fs::read_dir(root)
        .map_err(|_| "无法读取缓存目录")?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let number = name.to_str()?.strip_prefix(&prefix)?.parse::<u32>().ok()?;
            Some((number, entry.path()))
        })
        .collect())
}

#[tauri::command]
pub async fn offline_refresh_show(
    cache: tauri::State<'_, Cache>,
    api: tauri::State<'_, crate::api::Api>,
    id: i64,
) -> Result<(), String> {
    let root = cache.root()?;
    if !list(&root)?.iter().any(|item| item.id == id) {
        return Err("这部剧还没有本地缓存".into());
    }
    let origin = net::base();
    let token = api.session.token(&origin);
    let detail = net::edge(
        &origin,
        "GET",
        &format!("/api/videos/{id}"),
        None,
        token.as_deref(),
    )
    .await
    .map_err(|_| "暂时无法获取剧集信息，请检查线路后重试")?;
    let episodes = episode_numbers(&detail);
    if episodes.is_empty() {
        return Err("暂时无法获取完整集数，请稍后重试".into());
    }
    let cover = if read_show(&root, id).is_some_and(|show| show.cover) {
        None
    } else {
        load_show_cover(&detail).await
    };
    // Serialize metadata writes and deletion, and check again after the network request.
    let _queue = cache.queue.lock().unwrap();
    if !list(&root)?.iter().any(|item| item.id == id) {
        return Err("这部剧的本地缓存已删除".into());
    }
    save_show(&root, id, episodes, cover.as_deref().map(Vec::as_slice)).map_err(storage_error)
}

#[tauri::command]
pub fn offline_start(
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    id: i64,
    ep: Option<u32>,
    title: Option<String>,
) -> Result<(), String> {
    if id <= 0 || ep == Some(0) {
        return Err("请选择有效剧集".into());
    }
    enqueue(
        &app,
        &cache,
        Entry::new(
            id,
            title.unwrap_or_default().chars().take(160).collect(),
            ep.map(|ep| BTreeSet::from([ep])),
            None,
        ),
    )
}

#[tauri::command]
pub fn offline_resume(
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    id: i64,
) -> Result<(), String> {
    let root = cache.root()?;
    {
        let mut queue = cache.queue.lock().unwrap();
        if queue.active.contains_key(&id) {
            return Err("请等这部剧暂停后再继续".into());
        }
        queue.change(&root, |pending| {
            let entry = pending
                .entries
                .iter_mut()
                .find(|entry| entry.id == id && entry.paused)
                .ok_or("没有可继续的下载")?;
            entry.resume();
            Ok(())
        })?;
    }
    #[cfg(target_os = "ios")]
    crate::ios_download_background::request();
    fill_slots(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct DownloadSettings {
    limit: usize,
    segments: usize,
    allow_background: bool,
    background_supported: bool,
}

#[tauri::command]
pub fn offline_download_settings(
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    limit: Option<usize>,
    segments: Option<usize>,
    allow_background: Option<bool>,
) -> Result<DownloadSettings, String> {
    if limit.is_some_and(|value| !(1..=MAX_DOWNLOADS).contains(&value)) {
        return Err("同时下载数必须在 1 到 4 之间".into());
    }
    if segments.is_some_and(|value| !(1..=MAX_SEGMENTS).contains(&value)) {
        return Err("分片并发数必须在 1 到 4 之间".into());
    }
    let settings = {
        let mut queue = cache.queue.lock().unwrap();
        if limit.is_some() || segments.is_some() || allow_background.is_some() {
            let root = cache.root()?;
            queue.change(&root, |pending| {
                if let Some(limit) = limit {
                    pending.limit = limit;
                }
                if let Some(segments) = segments {
                    pending.segments = segments;
                }
                if let Some(allow_background) = allow_background {
                    pending.allow_background = allow_background;
                }
                Ok(())
            })?;
        }
        DownloadSettings {
            limit: queue.pending.limit,
            segments: queue.pending.segments,
            allow_background: queue.pending.allow_background,
            #[cfg(target_os = "ios")]
            background_supported: crate::ios_download_background::status() != "unsupported",
            #[cfg(not(target_os = "ios"))]
            background_supported: false,
        }
    };
    #[cfg(target_os = "ios")]
    if allow_background.is_some() {
        crate::ios_download_background::refresh_policy();
    }
    if limit.is_some() {
        fill_slots(&app);
    }
    Ok(settings)
}

fn enqueue(app: &tauri::AppHandle, cache: &Cache, entry: Entry) -> Result<(), String> {
    let root = cache.root()?;
    {
        let mut queue = cache.queue.lock().unwrap();
        if entry
            .capture
            .is_some_and(|capture| watch::source(capture.key).is_none())
        {
            return Err("这集的临时缓存已清理，请从选集重新缓存".into());
        }
        if queue
            .active
            .get(&entry.id)
            .is_some_and(|job| job.lock().unwrap().stopping)
        {
            return Err("请等这部剧暂停后再试".into());
        }
        queue.change(&root, |pending| pending.add(entry))?;
    }
    #[cfg(target_os = "ios")]
    crate::ios_download_background::request();
    fill_slots(app);
    Ok(())
}

#[tauri::command]
pub fn watch_discard(cache: tauri::State<'_, Cache>, key: u64) -> Result<(), String> {
    let queue = cache.queue.lock().unwrap();
    let Some(source) = watch::source(key) else {
        return Ok(());
    };
    if queue.pending.entries.iter().any(|entry| {
        entry.id == source.id
            && entry.capture.is_some()
            && entry
                .episodes
                .as_ref()
                .is_some_and(|episodes| episodes.contains(&source.ep))
    }) {
        return Err("这集正在排队或保留，请先停止保留".into());
    }
    watch::discard_recent(key);
    Ok(())
}

pub fn fill_slots(app: &tauri::AppHandle) {
    use tauri::Manager;
    let cache = app.state::<Cache>();
    let Ok(root) = cache.root() else { return };
    let reserved = cache.queue.lock().unwrap().reserve();
    for (entry, job) in reserved {
        let app = app.clone();
        let root = root.clone();
        tauri::async_runtime::spawn(async move {
            let cache = app.state::<Cache>();
            let initial = job.lock().unwrap().clone();
            let started = Instant::now();
            let record = |event, progress: &Job, failure: Option<&TransferFailure>| {
                diagnostics::worker(
                    &root,
                    event,
                    progress,
                    started.elapsed().as_millis(),
                    failure.map(diagnostics::Failure::from),
                );
            };
            record("worker_started", &initial, None);
            let attempt = || async {
                let result = download_entry(&app, &cache, &job, &root, &entry).await;
                let stage = stage_path(&root, entry.id);
                if entry.capture.is_some() || !has_staging_checkpoint(&stage) {
                    if let Err(error) = fs::remove_dir_all(&stage).await {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            let progress = job.lock().unwrap().clone();
                            record(
                                "staging_cleanup_failed",
                                &progress,
                                Some(&TransferFailure::storage(error)),
                            );
                        }
                    }
                }
                result
            };
            let result = if entry.capture.is_none() {
                retry_download(&job, attempt, |error| {
                    let progress = job.lock().unwrap().clone();
                    if !progress.stopping {
                        record("worker_retry", &progress, Some(error));
                    }
                })
                .await
            } else {
                attempt().await
            };
            let (event, outcome, failure, detached) = {
                let mut queue = cache.queue.lock().unwrap();
                let mut outcome = job.lock().unwrap().clone();
                if let Some(key) = outcome.watch_key {
                    outcome.needs_fill = result
                        .as_ref()
                        .is_err_and(|error| error.message == watch::MISSING);
                    if outcome.needs_fill {
                        watch::needs_fill(key);
                    }
                }
                let event = if result.is_ok() {
                    "worker_completed"
                } else if outcome.stopping {
                    "worker_stopped"
                } else if outcome.needs_fill {
                    "worker_needs_fill"
                } else {
                    "worker_failed"
                };
                let failure = result
                    .as_ref()
                    .err()
                    .filter(|_| !outcome.stopping)
                    .map(diagnostics::Failure::from);
                let id = entry.id;
                queue.finish(&root, entry, outcome.clone(), result);
                let detached = if !queue.pending.entries.iter().any(|entry| entry.id == id) {
                    discard_staging(&root, id)
                } else {
                    None
                };
                (event, outcome, failure, detached)
            };
            if let Some(detached) = detached {
                let cleanup_root = root.clone();
                let _ =
                    tokio::task::spawn_blocking(move || cleanup_detached(&cleanup_root, detached))
                        .await;
            }
            diagnostics::worker(
                &root,
                event,
                &outcome,
                started.elapsed().as_millis(),
                failure,
            );
            fill_slots(&app);
        });
    }
}

#[tauri::command]
pub fn watch_save(
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    key: u64,
    fill: bool,
) -> Result<(), String> {
    let source = watch::source(key).ok_or("这集的临时缓存已清理，请从选集重新缓存")?;
    enqueue(
        &app,
        &cache,
        Entry::new(
            source.id,
            source.title,
            Some(BTreeSet::from([source.ep])),
            Some(Capture { key, fill }),
        ),
    )
}

async fn retry_download<F, Fut>(
    job: &Mutex<Job>,
    attempt: F,
    on_retry: impl FnOnce(&TransferFailure),
) -> Result<(), TransferFailure>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), TransferFailure>>,
{
    match attempt().await {
        Err(error)
            if error.retry_after.is_some()
                || matches!(error.stage, "media" | "mp4" | "hls_playlist" | "hls_asset")
                    && matches!(error.reason, FailureReason::Http(401 | 403)) =>
        {
            on_retry(&error);
            {
                let mut job = job.lock().unwrap();
                job.reset_transfer();
                job.message = "网络暂时中断，正在准备重试".into();
            }
            wait_to_retry(
                job,
                Duration::from_secs(3).max(error.retry_after.unwrap_or_default()),
            )
            .await?;
            job.lock().unwrap().message.clear();
            attempt().await
        }
        result => result,
    }
}

fn download_api_failure(reason: String, message: String, stage: &'static str) -> TransferFailure {
    let code = reason
        .strip_prefix("HTTP ")
        .and_then(|value| value.parse::<u16>().ok())
        .map_or_else(
            || match reason.as_str() {
                "请求超时" => FailureReason::Timeout,
                reason if reason.starts_with("error sending request") => FailureReason::Connection,
                reason if reason.starts_with("error decoding response body") => {
                    FailureReason::BodyInterrupted
                }
                _ => FailureReason::Other,
            },
            FailureReason::Http,
        );
    let failure = if net::retryable_edge_error(&reason) {
        TransferFailure::transient(&message, Duration::ZERO)
    } else {
        message.into()
    };
    failure.with_reason(code).at(stage)
}

async fn download_entry(
    app: &tauri::AppHandle,
    cache: &Cache,
    job: &RunningJob,
    root: &Path,
    entry: &Entry,
) -> Result<(), TransferFailure> {
    use tauri::Manager;
    if let Some(capture) = entry.capture {
        let source = watch::source(capture.key).ok_or_else(|| {
            TransferFailure::from("这集的临时缓存已清理，请从选集重新缓存")
                .with_reason(FailureReason::CaptureUnavailable)
                .at("recent_playback")
        })?;
        {
            let mut progress = job.lock().unwrap();
            progress.ep = source.ep;
            progress.cover = source.cover.clone();
            progress.total = 1;
        }
        let segments = cache.queue.lock().unwrap().pending.segments;
        commit_episode(
            job,
            root,
            source.id,
            source.ep,
            &source.title,
            &source.url,
            &source.origin,
            TransferOptions {
                capture: Some(capture),
                segments,
                ..TransferOptions::default()
            },
        )
        .await?;
        if !source.episodes.is_empty() {
            let cover = source.cover.as_deref().and_then(media::cached_cover);
            // This active worker owns the show's files until Queue::finish.
            let _ = save_show(
                root,
                source.id,
                source.episodes,
                cover.as_deref().map(Vec::as_slice),
            );
        }
        watch::discard(capture.key);
        job.lock().unwrap().done = 1;
        return Ok(());
    }
    let origin = net::base();
    let token = app.state::<crate::api::Api>().session.token(&origin);
    run(cache, job, root, entry, &origin, token.as_deref()).await
}

fn stage_path(root: &Path, id: i64) -> PathBuf {
    root.join(".partials").join(id.to_string())
}

const STAGED_EPISODE: &str = ".episode";

fn staged_episode(stage: &Path) -> Option<u32> {
    std::fs::read_to_string(stage.join(STAGED_EPISODE))
        .ok()?
        .parse()
        .ok()
}

// Callers must establish that no active worker owns this path. Renaming to a
// unique tombstone transfers cleanup ownership away from a reusable cache path.
fn detach_for_cleanup(root: &Path, directory: &Path) -> std::io::Result<Option<PathBuf>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let trash = root.join(".trash");
    std::fs::create_dir_all(&trash)?;
    loop {
        let target = trash.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if target.exists() {
            continue;
        }
        return match std::fs::rename(directory, &target) {
            Ok(()) => Ok(Some(target)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        };
    }
}

fn cleanup_detached(root: &Path, directory: PathBuf) -> bool {
    match std::fs::remove_dir_all(directory) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => {
            // The .trash path remains owned and is retried on the next bind.
            diagnostics::record(
                root,
                "staging_cleanup_failed",
                serde_json::json!({"operation": "detached"}),
            );
            false
        }
    }
}

fn discard_staging(root: &Path, id: i64) -> Option<PathBuf> {
    match detach_for_cleanup(root, &stage_path(root, id)) {
        Ok(detached) => detached,
        Err(_) => {
            diagnostics::record(
                root,
                "staging_cleanup_failed",
                serde_json::json!({"operation": "detach"}),
            );
            None
        }
    }
}

fn has_staging_checkpoint(stage: &Path) -> bool {
    stage.join(HLS_CHECKPOINT).is_file() || stage.join(HLS_ASSETS).is_dir()
}

fn prune_staging(root: &Path, pending: &Pending) {
    let Ok(stages) = std::fs::read_dir(root.join(".partials")) else {
        return;
    };
    for stage in stages.flatten() {
        let staging = stage.path();
        let id = stage
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i64>().ok());
        let queued = id.is_some_and(|id| pending.entries.iter().any(|entry| entry.id == id));
        let committed = id
            .zip(staged_episode(&staging))
            .is_some_and(|(id, ep)| path(root, id, ep).join("info.json").is_file());
        if !queued || committed || !has_staging_checkpoint(&staging) {
            let _ = std::fs::remove_dir_all(&staging);
        } else {
            let _ = std::fs::remove_dir_all(staging.join(HLS_PACKAGE));
        }
    }
}

async fn commit_episode(
    job: &Mutex<Job>,
    root: &Path,
    id: i64,
    ep: u32,
    title: &str,
    url: &str,
    origin: &str,
    options: TransferOptions,
) -> Result<(), TransferFailure> {
    let dest = path(root, id, ep);
    if dest.exists() {
        return Ok(());
    }
    let stage = stage_path(root, id);
    let options = TransferOptions {
        resume_episode: options.capture.is_none().then_some(ep),
        ..options
    };
    if options.resume_episode.is_some() {
        if staged_episode(&stage).is_some_and(|previous| previous != ep) {
            if let Err(error) = fs::remove_dir_all(&stage).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(TransferFailure::storage(error));
                }
            }
        }
        fs::create_dir_all(&stage)
            .await
            .map_err(TransferFailure::storage)?;
        fs::write(stage.join(STAGED_EPISODE), ep.to_string())
            .await
            .map_err(TransferFailure::storage)?;
    } else {
        fs::create_dir_all(root.join(".partials"))
            .await
            .map_err(TransferFailure::storage)?;
        fs::create_dir(&stage)
            .await
            .map_err(TransferFailure::storage)?;
    }
    let (bytes, mp4) = save_video(job, &stage, url, origin, options).await?;
    check_job(job)?;
    let package = if options.resume_episode.is_some() {
        stage.join(HLS_PACKAGE)
    } else {
        stage.clone()
    };
    let info = Episode {
        id,
        ep,
        title: title.to_owned(),
        bytes,
        mp4,
    };
    let json = serde_json::to_vec(&info)
        .map_err(|_| TransferFailure::from("无法保存缓存信息").at("storage"))?;
    fs::write(package.join("info.json"), json)
        .await
        .map_err(TransferFailure::storage)?;
    fs::rename(&package, &dest).await.map_err(|error| {
        let mut failure = TransferFailure::storage(error);
        failure.message = "无法完成缓存".into();
        failure
    })?;
    if options.resume_episode.is_some() {
        if fs::remove_dir_all(&stage).await.is_err() {
            diagnostics::record(
                root,
                "staging_cleanup_failed",
                serde_json::json!({"operation": "commit"}),
            );
        }
    }
    Ok(())
}

async fn run(
    cache: &Cache,
    job: &Mutex<Job>,
    root: &Path,
    entry: &Entry,
    origin: &str,
    token: Option<&str>,
) -> Result<(), TransferFailure> {
    let id = entry.id;
    check_job(job)?;
    let detail = net::edge(origin, "GET", &format!("/api/videos/{id}"), None, token)
        .await
        .map_err(|reason| {
            download_api_failure(reason, "无法读取选集，请检查线路".into(), "episode_list")
        })?;
    let title = detail
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未命名剧集")
        .chars()
        .take(160)
        .collect::<String>();
    let all_episodes = episode_numbers(&detail);
    let episodes = all_episodes
        .iter()
        .copied()
        .filter(|&number| {
            entry
                .episodes
                .as_ref()
                .is_none_or(|episodes| episodes.contains(&number))
        })
        .collect::<Vec<_>>();
    if episodes.is_empty() {
        return Err(TransferFailure::from("没有可缓存的集数").at("episode_list"));
    }
    let remaining: Vec<_> = episodes
        .iter()
        .copied()
        .filter(|&ep| !path(root, id, ep).exists())
        .collect();
    {
        let mut job = job.lock().unwrap();
        job.total = episodes.len();
        job.done = episodes.len() - remaining.len();
        job.ep = 0;
        job.reset_transfer();
        job.title = title.clone();
        job.cover = detail
            .get("cover")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
    }
    let mut stored_show = false;
    for ep in remaining {
        check_job(job)?;
        job.lock().unwrap().ep = ep;
        let data = net::episode_playback(origin, id, ep, token)
            .await
            .map_err(|reason| {
                download_api_failure(
                    reason,
                    format!("第 {ep} 集取不到播放地址，请检查线路"),
                    "episode_source",
                )
            })?;
        let url = ["video_url", "video_url_hevc"]
            .into_iter()
            .filter_map(|field| data.get(field).and_then(|v| v.as_str()))
            .map(str::trim)
            .find(|url| !url.is_empty())
            .ok_or_else(|| {
                TransferFailure::from(format!("第 {ep} 集没有可缓存的播放地址"))
                    .at("episode_source")
            })?;
        let segments = cache.queue.lock().unwrap().pending.segments;
        let options = TransferOptions {
            segments,
            ..TransferOptions::default()
        };
        commit_episode(job, root, id, ep, &title, url, origin, options)
            .await
            .map_err(|error| error.with_context(&format!("第 {ep} 集：")))?;
        if !stored_show {
            let cover = if read_show(root, id).is_some_and(|show| show.cover) {
                None
            } else {
                load_show_cover(&detail).await
            };
            // The active worker prevents deletion; no queue lock is needed for disk I/O.
            // A cover failure should not invalidate a playable episode.
            let _ = save_show(
                root,
                id,
                all_episodes.clone(),
                cover.as_deref().map(Vec::as_slice),
            );
            stored_show = true;
        }
        let mut progress = job.lock().unwrap();
        progress.done += 1;
        progress.reset_transfer();
    }
    Ok(())
}

fn storage_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::StorageFull {
        "设备存储空间不足".into()
    } else {
        "无法写入本地缓存".into()
    }
}

const MP4_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

pub async fn serve(cache: &Cache, path_value: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let error = |status| Response::builder().status(status).body(Vec::new()).unwrap();
    let parts: Vec<_> = path_value.trim_start_matches('/').split('/').collect();
    if let ["offline", id, "cover"] = parts.as_slice() {
        let (Ok(id), Ok(root)) = (id.parse::<i64>(), cache.root()) else {
            return error(404);
        };
        let Ok(bytes) = fs::read(show_dir(&root, id).join("cover")).await else {
            return error(404);
        };
        let Some(kind) = media::image_kind(&bytes) else {
            return error(404);
        };
        return Response::builder()
            .header(header::CONTENT_TYPE, kind)
            .header(header::CACHE_CONTROL, "no-store")
            .body(bytes)
            .unwrap();
    }
    let [_, id, ep, name] = parts.as_slice() else {
        return error(404);
    };
    let (Ok(id), Ok(ep), Ok(root)) = (id.parse::<i64>(), ep.parse::<u32>(), cache.root()) else {
        return error(404);
    };
    let content_type = match *name {
        "index.m3u8" => "application/vnd.apple.mpegurl",
        "video.mp4" => "video/mp4",
        asset => match asset.split_once('.') {
            Some((n, "mp4")) if n.parse::<u32>().is_ok() => "video/mp4",
            Some((n, "ts")) if n.parse::<u32>().is_ok() => "video/mp2t",
            _ => return error(404),
        },
    };
    let Ok(mut file) = fs::File::open(path(&root, id, ep).join(name)).await else {
        return error(404);
    };
    let Ok(meta) = file.metadata().await else {
        return error(404);
    };
    let len = meta.len();
    if len == 0 {
        return error(404);
    }
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes");
    let (start, end) = if let Some(range) = range {
        let Some((start, end)) = byte_range(range, len) else {
            return builder
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap();
        };
        let end = if *name == "video.mp4" {
            end.min(start.saturating_add(MP4_RESPONSE_BYTES - 1))
        } else {
            end
        };
        builder = builder
            .status(206)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
        (start, end)
    } else if *name == "video.mp4" && len > MP4_RESPONSE_BYTES {
        // A 206 without a Range request can look like a truncated complete
        // file to clients. Require range-based playback instead of allocating
        // the whole MP4 or claiming a partial response satisfies a full GET.
        return builder
            .status(400)
            .body(b"Range required for large video".to_vec())
            .unwrap();
    } else {
        (0, len - 1)
    };
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return error(500);
    }
    let size = end - start + 1;
    let mut data = Vec::with_capacity(size as usize);
    if file.take(size).read_to_end(&mut data).await.is_err() || data.len() as u64 != size {
        return error(500);
    }
    builder
        .header(header::CONTENT_LENGTH, size)
        .body(data)
        .unwrap()
}

fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let size = end.parse::<u64>().ok()?.min(len);
        return (size > 0).then(|| (len - size, len - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().ok()?.min(len - 1)
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{BlockEncrypt, KeyInit};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::{io::AsyncWriteExt, net::TcpListener};

    #[tokio::test]
    async fn retries_transient_download_failure_only_once() {
        let job = Mutex::new(Job::default());
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let result = retry_download(
            &job,
            || async {
                let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let message = if attempt == 0 {
                    "网络中断"
                } else {
                    "网络仍未恢复"
                };
                Err(TransferFailure::transient(message, Duration::ZERO))
            },
            |_| {},
        )
        .await;
        assert_eq!(result.unwrap_err().message, "网络仍未恢复");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn expired_media_address_refreshes_once_but_api_denial_does_not() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (stage, succeeds, expected) in [
            ("hls_asset", true, 2),
            ("hls_asset", false, 2),
            ("episode_source", false, 1),
            ("episode_list", false, 1),
        ] {
            let attempts = AtomicUsize::new(0);
            let result = retry_download(
                &Mutex::new(Job::default()),
                || async {
                    let n = attempts.fetch_add(1, Ordering::SeqCst);
                    if succeeds && n > 0 {
                        Ok(())
                    } else {
                        Err(TransferFailure::from("HTTP 403")
                            .with_reason(FailureReason::Http(403))
                            .at(stage))
                    }
                },
                |_| {},
            )
            .await;
            assert_eq!(attempts.load(Ordering::SeqCst), expected);
            assert_eq!(result.is_ok(), succeeds);
        }
    }

    #[tokio::test]
    async fn retry_respects_manual_stop_and_permanent_errors() {
        let job = Mutex::new(Job::default());
        let result = retry_download(
            &job,
            || async {
                assert!(!job.lock().unwrap().stopping);
                job.lock().unwrap().stopping = true;
                Err(TransferFailure::transient("网络中断", Duration::ZERO))
            },
            |_| {},
        )
        .await;
        assert_eq!(result.unwrap_err().message, "已停止缓存");

        let job = Mutex::new(Job::default());
        let result = retry_download(
            &job,
            || async {
                assert!(job.lock().unwrap().message.is_empty());
                Err("设备存储空间不足".into())
            },
            |_| {},
        )
        .await;
        assert_eq!(result.unwrap_err().message, "设备存储空间不足");
    }

    #[test]
    fn offline_master_prefers_highest_resolution_then_bitrate() {
        let base = url::Url::parse("https://example.com/path/master.m3u8").unwrap();
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\nmedium.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080\nbest.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,AUDIO=\"separate\"\nunsupported.m3u8\n";
        assert_eq!(
            best_variant(master, &base, None).unwrap().path(),
            "/path/best.m3u8"
        );
    }

    #[tokio::test]
    #[ignore = "uses an isolated local HTTP fixture"]
    async fn watched_episode_rejects_partial_and_saves_complete_without_network() {
        for fill in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "hg-watch-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).await.unwrap();
            network_policy::bind_security(&root);
            network_policy::set_strict_security(false).unwrap();
            watch::bind(root.join("watch"));
            let saved = root.join("saved");
            let cache = Cache::default();
            cache.bind(saved.clone());
            let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", server.local_addr().unwrap());
            let manifest = format!("{origin}/index.m3u8");
            let first = format!("{origin}/first.ts");
            let task = tokio::spawn(async move {
                for expected in ["/index.m3u8", "/first.ts", "/second.ts"] {
                    let (mut socket, _) = server.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        request.push(socket.read_u8().await.unwrap());
                    }
                    let request = String::from_utf8(request).unwrap();
                    assert_eq!(request.split_whitespace().nth(1), Some(expected));
                    let body: &[u8] = match expected {
                    "/index.m3u8" => b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nsecond.ts\n#EXT-X-ENDLIST\n",
                    _ => &[0x47; 188],
                };
                    socket
                        .write_all(
                            format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    socket.write_all(body).await.unwrap();
                }
            });
            let key = watch::watch_begin(123, 2, manifest.clone()).unwrap();
            let query = |url: &str| {
                format!(
                    "u={}",
                    percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC)
                )
            };
            for (route, url) in [("hls", manifest.as_str()), ("seg", first.as_str())] {
                let response = watch::serve(
                    &format!("/watch/{key}/{route}"),
                    &query(url),
                    media::LOCAL_ORIGIN,
                )
                .await;
                assert_eq!(response.status(), 200);
            }
            let local = Some(Capture { key, fill: false });
            let source = watch::source(key).unwrap();
            let err = commit_episode(
                &Mutex::new(Job::default()),
                &saved,
                123,
                2,
                "Fixture",
                &manifest,
                &source.origin,
                TransferOptions {
                    capture: local,
                    ..TransferOptions::default()
                },
            )
            .await
            .unwrap_err();
            assert_eq!(err.message, watch::MISSING);
            assert!(!path(&saved, 123, 2).exists());
            fs::remove_dir_all(stage_path(&saved, 123)).await.unwrap();

            if fill {
                commit_episode(
                    &Mutex::new(Job::default()),
                    &saved,
                    123,
                    2,
                    "Fixture",
                    &manifest,
                    &source.origin,
                    TransferOptions {
                        capture: Some(Capture { key, fill: true }),
                        ..TransferOptions::default()
                    },
                )
                .await
                .unwrap();
                task.await.unwrap();
            } else {
                let second = format!("{origin}/second.ts");
                let response = watch::serve(
                    &format!("/watch/{key}/seg"),
                    &query(&second),
                    media::LOCAL_ORIGIN,
                )
                .await;
                assert_eq!(response.status(), 200);
                task.await.unwrap();
                commit_episode(
                    &Mutex::new(Job::default()),
                    &saved,
                    123,
                    2,
                    "Fixture",
                    &manifest,
                    &source.origin,
                    TransferOptions {
                        capture: local,
                        ..TransferOptions::default()
                    },
                )
                .await
                .unwrap();
            }
            let response = serve(&cache, "/offline/123/2/1.ts", None).await;
            assert_eq!(response.status(), 200);
            assert_eq!(response.into_body(), vec![0x47; 188]);
            let duplicate = watch::watch_begin(123, 2, format!("{manifest}?copy=1")).unwrap();
            let other_episode = watch::watch_begin(123, 3, manifest).unwrap();
            watch::discard_recent(key);
            assert!(watch::source(key).is_none());
            assert!(watch::source(duplicate).is_none());
            assert!(watch::source(other_episode).is_some());
            assert_eq!(
                serve(&cache, "/offline/123/2/1.ts", None).await.status(),
                200
            );
            watch::discard(other_episode);
            fs::remove_dir_all(root).await.unwrap();
        }
    }

    #[tokio::test]
    async fn legacy_show_metadata_and_cover_can_be_added_without_rewriting_episode() {
        let root = std::env::temp_dir().join(format!(
            "hg-offline-show-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = Cache::default();
        cache.bind(root.clone());
        let episode = path(&root, 17, 3);
        fs::create_dir(&episode).await.unwrap();
        fs::write(
            episode.join("info.json"),
            br#"{"id":17,"ep":3,"title":"Fixture","bytes":12,"mp4":false}"#,
        )
        .await
        .unwrap();
        fs::write(episode.join("index.m3u8"), b"#EXTM3U")
            .await
            .unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        assert!(read_show(&root, 17).is_none());

        let cover = b"\x89PNG\r\n\x1a\nfixture";
        let episodes = episode_numbers(&serde_json::json!({ "episodes": [
            {"ep_num": 3}, {"ep_num": 9}, {"ep_num": 1}, {"ep_num": 3}
        ] }));
        save_show(&root, 17, episodes, Some(cover)).unwrap();
        save_show(&root, 17, vec![1, 3, 9, 12], None).unwrap();
        let show = read_show(&root, 17).unwrap();
        assert_eq!(show.episodes, vec![1, 3, 9, 12]);
        assert!(show.cover);
        let response = serve(&cache, "/offline/17/cover", None).await;
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.into_body(), cover);
        assert_eq!(
            fs::read(episode.join("index.m3u8")).await.unwrap(),
            b"#EXTM3U"
        );
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "uses a local HTTP fixture and temporarily disables the global network guard; run alone"]
    async fn hls_checkpoint_replays_only_missing_segments_after_rebind() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        for scenario in [
            "same",
            "revision",
            "signed",
            "parallel-failure",
            "slow-sibling",
        ] {
            let root = std::env::temp_dir()
                .join(format!("hg-hls-resume-{}-{scenario}", std::process::id()));
            let cache = Cache::default();
            cache.bind(root.clone());
            network_policy::bind_security(&root);
            network_policy::set_strict_security(false).unwrap();
            cache
                .queue
                .lock()
                .unwrap()
                .change(&root, |pending| {
                    pending.add(Entry::new(
                        12,
                        "Fixture".into(),
                        Some(BTreeSet::from([1])),
                        None,
                    ))
                })
                .unwrap();
            let stage = stage_path(&root, 12);
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let manifests = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let server = {
                let stage = stage.clone();
                let requests = requests.clone();
                tokio::spawn(async move {
                    loop {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let stage = stage.clone();
                        let manifests = manifests.clone();
                        let requests = requests.clone();
                        tokio::spawn(async move {
                            let mut request = Vec::new();
                            while !request.ends_with(b"\r\n\r\n") {
                                request.push(socket.read_u8().await.unwrap());
                            }
                            let request = String::from_utf8(request).unwrap();
                            let target = request.split_whitespace().nth(1).unwrap().to_owned();
                            let attempt = if target == "/index.m3u8" {
                                manifests.fetch_add(1, Ordering::SeqCst)
                            } else {
                                manifests.load(Ordering::SeqCst) - 1
                            };
                            requests.lock().unwrap().push((attempt, target.clone()));
                            let (status, body) = match target.as_str() {
                                "/index.m3u8" => {
                                    let query = match (scenario, attempt) {
                                        ("revision", 1) => "?revision=2",
                                        ("signed", 0) => "?auth_key=1900000000-0-0-00000000000000000000000000000000",
                                        ("signed", _) => "?auth_key=1900000100-0-0-11111111111111111111111111111111",
                                        _ => "",
                                    };
                                    ("200 OK", format!("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts{query}\n#EXTINF:1,\nc.ts\n#EXT-X-ENDLIST\n").into_bytes())
                                }
                                "/a.ts"
                                    if attempt == 0
                                        && matches!(
                                            scenario,
                                            "parallel-failure" | "slow-sibling"
                                        ) =>
                                {
                                    ("404 Not Found", Vec::new())
                                }
                                "/a.ts" if attempt == 0 => {
                                    // A slow first segment must not block the second from reaching disk.
                                    tokio::time::timeout(Duration::from_secs(8), async {
                                        while !stage.join(HLS_ASSETS).join("1.digest").is_file()
                                            || !stage.join(HLS_ASSETS).join("2.digest").is_file()
                                        {
                                            tokio::time::sleep(Duration::from_millis(10)).await;
                                        }
                                    })
                                    .await
                                    .unwrap();
                                    ("404 Not Found", Vec::new())
                                }
                                "/a.ts" => ("200 OK", vec![0x47; 188]),
                                "/b.ts" => {
                                    if attempt == 0 {
                                        let delay = match scenario {
                                            "parallel-failure" => 200,
                                            "slow-sibling" => 4000,
                                            _ => 0,
                                        };
                                        tokio::time::sleep(Duration::from_millis(delay)).await;
                                    }
                                    ("200 OK", vec![0x47; 376])
                                }
                                "/c.ts" => ("200 OK", vec![0x47; 188]),
                                target if target.starts_with("/b.ts?auth_key=") => {
                                    ("200 OK", vec![0x47; 376])
                                }
                                "/b.ts?revision=2" => ("200 OK", vec![0x47; 564]),
                                _ => panic!("unexpected fixture request"),
                            };
                            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                            socket.write_all(&body).await.unwrap();
                        });
                    }
                })
            };
            let options = TransferOptions {
                segments: 2,
                ..TransferOptions::default()
            };
            let url = format!("{origin}/index.m3u8");
            let job = Mutex::new(Job::default());
            let failed = tokio::time::timeout(
                Duration::from_secs(12),
                commit_episode(&job, &root, 12, 1, "Fixture", &url, &origin, options),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(matches!(failed.reason, FailureReason::Http(404)));
            assert!(!path(&root, 12, 1).exists());
            assert_eq!(
                fs::metadata(stage.join(HLS_ASSETS).join("1.ts"))
                    .await
                    .unwrap()
                    .len(),
                376
            );
            fs::write(stage.join(HLS_ASSETS).join("0.ts"), [0x47])
                .await
                .unwrap();
            let orphan = stage_path(&root, 13);
            fs::create_dir_all(&orphan).await.unwrap();
            fs::write(orphan.join(HLS_CHECKPOINT), [0; 32])
                .await
                .unwrap();
            // An interruption immediately after the package rename can leave
            // the same episode marked as queued along with its staging files.
            cache
                .queue
                .lock()
                .unwrap()
                .change(&root, |pending| {
                    pending.add(Entry::new(
                        14,
                        "Committed".into(),
                        Some(BTreeSet::from([1, 2])),
                        None,
                    ))
                })
                .unwrap();
            let committed_stage = stage_path(&root, 14);
            fs::create_dir_all(committed_stage.join(HLS_ASSETS))
                .await
                .unwrap();
            fs::write(committed_stage.join(STAGED_EPISODE), "1")
                .await
                .unwrap();
            let committed = path(&root, 14, 1);
            fs::create_dir_all(&committed).await.unwrap();
            fs::write(committed.join("info.json"), b"{}").await.unwrap();

            let reopened = Cache::default();
            reopened.bind(root.clone());
            assert!(stage.join(HLS_ASSETS).join("1.ts").is_file());
            assert!(!orphan.exists());
            assert!(!committed_stage.exists());
            assert!(committed.join("info.json").is_file());
            let resumed = Mutex::new(Job::default());
            tokio::time::timeout(
                Duration::from_secs(12),
                commit_episode(&resumed, &root, 12, 1, "Fixture", &url, &origin, options),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                resumed.lock().unwrap().reused_bytes,
                match scenario {
                    "revision" => 188,
                    "parallel-failure" | "slow-sibling" => 376,
                    _ => 564,
                }
            );
            assert!(!stage.exists());
            let mut second_attempt: Vec<_> = requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(attempt, _)| *attempt == 1)
                .map(|(_, target)| target.clone())
                .collect();
            second_attempt.sort();
            if scenario == "revision" {
                assert_eq!(second_attempt, ["/a.ts", "/b.ts?revision=2", "/index.m3u8"]);
            } else if matches!(scenario, "parallel-failure" | "slow-sibling") {
                assert_eq!(second_attempt, ["/a.ts", "/c.ts", "/index.m3u8"]);
            } else {
                assert_eq!(second_attempt, ["/a.ts", "/index.m3u8"]);
            }
            server.abort();
            let playlist = serve(&reopened, "/offline/12/1/index.m3u8", None).await;
            let body = String::from_utf8(playlist.into_body()).unwrap();
            assert!(body.find("0.ts").unwrap() < body.find("1.ts").unwrap());
            let second = serve(&reopened, "/offline/12/1/1.ts", None).await;
            assert_eq!(
                second.into_body().len(),
                if scenario == "revision" { 564 } else { 376 }
            );
            assert!(!stage.exists());
            assert!(!path(&root, 12, 1).join(HLS_CHECKPOINT).exists());
            fs::remove_dir_all(root).await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "uses a local HTTP fixture and temporarily disables the global network guard; run alone"]
    async fn cache_package_replays_without_upstream_and_survives_rebind() {
        let root = std::env::temp_dir().join(format!(
            "hg-offline-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = Cache::default();
        cache.bind(root.clone());
        network_policy::bind_security(&root);
        network_policy::set_strict_security(false).unwrap();
        let stage = root.join(".partial");
        fs::create_dir(&stage).await.unwrap();

        let fixture = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", fixture.local_addr().unwrap());
        let mut plain = vec![0x47; 188];
        let key = [42u8; 16];
        let iv = 9u128.to_be_bytes();
        let mut padded = plain.clone();
        padded.extend_from_slice(&[4; 4]);
        let cipher = aes::Aes128::new_from_slice(&key).unwrap();
        let mut previous = iv;
        for chunk in padded.chunks_exact_mut(16) {
            let mut block = aes::cipher::Block::<aes::Aes128>::default();
            for ((out, value), prev) in block.iter_mut().zip(chunk.iter()).zip(previous) {
                *out = *value ^ prev;
            }
            cipher.encrypt_block(&mut block);
            chunk.copy_from_slice(&block);
            previous.copy_from_slice(chunk);
        }
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = fixture.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(request).unwrap();
                let target = request.split_whitespace().nth(1).unwrap();
                let body: &[u8] = match target {
                    "/index.m3u8" => b"#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:9\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:1.0,Fixture\npart.ts?fixture=1\n#EXT-X-ENDLIST\n",
                    "/clip.mp4" => b"\x00\x00\x00\x0cftypmp42",
                    "/key.bin" => &key,
                    "/part.ts?fixture=1" => &padded,
                    _ => panic!("unexpected local fixture request"),
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(body).await.unwrap();
            }
        });
        let (bytes, mp4) = save_video(
            &Mutex::new(Job::default()),
            &stage,
            &format!("{origin}/index.m3u8"),
            &origin,
            TransferOptions::default(),
        )
        .await
        .unwrap();
        let large = root.join("large.mp4");
        assert_eq!(
            save_mp4(
                &Mutex::new(Job::default()),
                &large,
                &format!("{origin}/clip.mp4"),
                &origin
            )
            .await
            .unwrap(),
            12
        );
        assert_eq!(
            fs::read(&large).await.unwrap().get(4..8),
            Some(b"ftyp".as_slice())
        );
        server.await.unwrap();
        assert!(!mp4);
        let item = Episode {
            id: 7,
            ep: 2,
            title: "Fixture".into(),
            bytes,
            mp4,
        };
        fs::write(stage.join("info.json"), serde_json::to_vec(&item).unwrap())
            .await
            .unwrap();
        fs::rename(&stage, path(&root, 7, 2)).await.unwrap();
        fs::create_dir(&stage).await.unwrap();
        let reopened = Cache::default();
        reopened.bind(root.clone());
        assert!(!stage.exists());
        assert_eq!(list(&root).unwrap()[0].ep, 2);
        let manifest = serve(&reopened, "/offline/7/2/index.m3u8", None).await;
        let manifest = String::from_utf8(manifest.into_body()).unwrap();
        assert!(manifest.contains("\n0.ts\n"));
        assert!(!manifest.contains("URI=") && !manifest.contains("fixture=1"));
        let response = serve(&reopened, "/offline/7/2/0.ts", Some("bytes=0-15")).await;
        assert_eq!(response.status(), 206);
        plain.truncate(16);
        assert_eq!(response.into_body(), plain);
        assert_eq!(
            serve(&reopened, "/offline/7/2/info.json", None)
                .await
                .status(),
            404
        );
        // A sparse fixture covers reads beyond the former 96 MiB per-episode limit.
        let mp4_path = path(&root, 7, 2).join("video.mp4");
        fs::rename(&large, &mp4_path).await.unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&mp4_path)
            .await
            .unwrap()
            .set_len(110 * 1024 * 1024)
            .await
            .unwrap();
        let far_offset = 100 * 1024 * 1024;
        let response = serve(
            &reopened,
            "/offline/7/2/video.mp4",
            Some(&format!("bytes={far_offset}-{}", far_offset + 31)),
        )
        .await;
        assert_eq!(response.status(), 206);
        assert_eq!(response.into_body().len(), 32);
        fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn detached_cleanup_cannot_remove_a_new_staging_writer() {
        let root = std::env::temp_dir().join(format!("hg-detached-cleanup-{}", std::process::id()));
        let old_stage = stage_path(&root, 8);
        std::fs::create_dir_all(&old_stage).unwrap();
        std::fs::write(old_stage.join("old.ts"), b"old").unwrap();
        let detached = discard_staging(&root, 8).unwrap();
        std::fs::create_dir_all(&old_stage).unwrap();
        std::fs::write(old_stage.join("new.ts"), b"new").unwrap();
        assert!(cleanup_detached(&root, detached));
        assert_eq!(std::fs::read(old_stage.join("new.ts")).unwrap(), b"new");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bind_retries_detached_garbage_without_deleting_committed_media() {
        let root = std::env::temp_dir().join(format!("hg-trash-retry-{}", std::process::id()));
        let package = path(&root, 9, 1);
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("video.mp4"), b"keep").unwrap();
        let trash = root.join(".trash").join("old-delete");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("fragment"), b"remove").unwrap();
        Cache::default().bind(root.clone());
        assert!(!root.join(".trash").exists());
        assert_eq!(std::fs::read(package.join("video.mp4")).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn large_local_mp4_responses_are_bounded_for_every_range_form() {
        let root =
            std::env::temp_dir().join(format!("hg-mp4-response-budget-{}", std::process::id()));
        let cache = Cache::default();
        cache.bind(root.clone());
        let package = path(&root, 17, 1);
        fs::create_dir_all(&package).await.unwrap();
        let file = fs::File::create(package.join("video.mp4")).await.unwrap();
        let len = 3 * 1024 * 1024 * 1024u64;
        file.set_len(len).await.unwrap();
        drop(file);
        for (range, start, size) in [
            (Some("bytes=0-"), 0, MP4_RESPONSE_BYTES),
            (Some("bytes=1024-3000000000"), 1024, MP4_RESPONSE_BYTES),
            (
                Some("bytes=-1000000000"),
                len - 1_000_000_000,
                MP4_RESPONSE_BYTES,
            ),
            (Some("bytes=100-131"), 100, 32),
            (Some("bytes=-32"), len - 32, 32),
        ] {
            let response = serve(&cache, "/offline/17/1/video.mp4", range).await;
            assert_eq!(response.status(), 206, "{range:?}");
            assert_eq!(response.headers()[header::CONTENT_LENGTH], size.to_string());
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes {start}-{}/{len}", start + size - 1)
            );
            assert_eq!(response.body().len() as u64, size);
        }
        let response = serve(&cache, "/offline/17/1/video.mp4", None).await;
        assert_eq!(response.status(), 400);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(response.body().len() < 128);
        let response = serve(&cache, "/offline/17/1/video.mp4", Some("bytes=4000000000-")).await;
        assert_eq!(response.status(), 416);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes */{len}")
        );
        fs::remove_dir_all(root).await.unwrap();
    }
}
