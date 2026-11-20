//! Durable finalization. Complete source fragments survive every failure before the metadata switch.
use super::{check_job, diagnostics, files, Cache, Episode, Job, TransferFailure, HLS_PACKAGE};
use files::Ready;
use std::{path::Path, sync::Mutex};

fn failure(error: super::remux::Error) -> TransferFailure {
    TransferFailure::from(error.message()).at("local_remux")
}
pub(super) async fn package(
    job: &Mutex<Job>,
    stage: &Path,
    ready: &Ready,
) -> Result<Episode, TransferFailure> {
    check_job(job)?;
    let package = stage.join(HLS_PACKAGE);
    let output = package.join(&ready.filename);
    files::cleanup_remux_temps(&package, &ready.filename).map_err(TransferFailure::storage)?;
    job.lock().unwrap().finalizing = true;
    let result = async {
        if ready.mp4 {
            if !output.exists() {
                tokio::fs::rename(package.join("video.mp4"), &output)
                    .await
                    .map_err(TransferFailure::storage)?;
            }
        } else {
            if output.exists() {
                if let Err(e) = super::remux::convert(
                    &output,
                    &output,
                    true,
                    || check_job(job).is_err(),
                    |_| {},
                )
                .await
                {
                    if e == super::remux::Error::Cancelled {
                        return Err(failure(e));
                    }
                    tokio::fs::remove_file(&output)
                        .await
                        .map_err(TransferFailure::storage)?;
                }
            }
            if !output.exists() {
                super::remux::convert(
                    &package.join("index.m3u8"),
                    &output,
                    false,
                    || check_job(job).is_err(),
                    |_| {},
                )
                .await
                .map_err(failure)?;
            }
        }
        check_job(job)?;
        let bytes = tokio::fs::metadata(&output)
            .await
            .map_err(TransferFailure::storage)?
            .len();
        if bytes == 0 {
            return Err(TransferFailure::from("合成文件为空，原分片已保留").at("local_remux"));
        }
        let episode = Episode {
            id: ready.id,
            ep: ready.ep,
            title: ready.title.clone(),
            bytes,
            mp4: true,
            media_file: Some(ready.filename.clone()),
        };
        files::atomic_json(&package, "info.json", &episode).map_err(TransferFailure::storage)?;
        Ok(episode)
    }
    .await;
    job.lock().unwrap().finalizing = false;
    result
}

struct Worker(std::sync::Arc<Mutex<files::Access>>, tauri::AppHandle);
impl Drop for Worker {
    fn drop(&mut self) {
        let restart = {
            let mut state = self.0.lock().unwrap();
            state.migration_running = false;
            std::mem::take(&mut state.restart_requested)
        };
        if restart {
            start(&self.1);
        }
    }
}
struct Converting(std::sync::Arc<Mutex<files::Access>>, (i64, u32));
impl Drop for Converting {
    fn drop(&mut self) {
        self.0.lock().unwrap().converting.remove(&self.1);
    }
}

pub(super) fn start(app: &tauri::AppHandle) {
    use tauri::Manager;
    let cache = app.state::<Cache>();
    {
        let mut state = cache.access.lock().unwrap();
        if state.migration_running {
            state.restart_requested = true;
            return;
        }
        state.migration_running = true;
    }
    let guard = Worker(cache.access.clone(), app.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _worker = guard;
        let cache = app.state::<Cache>();
        let Ok(root) = cache.root() else { return };
        let Ok(items) = super::list(&root) else {
            return;
        };
        let mut deferred = Vec::new();
        for item in items {
            if cache.queue.lock().unwrap().backgrounded {
                return;
            }
            match migrate(&cache, &root, &item).await {
                Ok(false) => deferred.push(item),
                Ok(true) => {}
                Err(_) => {}
            }
        }
        // A player lease can outlive the first scan. Retry only deferred items, never rescan/remerge failures in a loop.
        while !deferred.is_empty() {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if cache.queue.lock().unwrap().backgrounded {
                return;
            }
            let mut next = Vec::new();
            for item in deferred {
                if let Ok(false) = migrate(&cache, &root, &item).await {
                    next.push(item)
                }
            }
            deferred = next;
        }
    });
}

pub(super) async fn migrate(cache: &Cache, root: &Path, item: &Episode) -> Result<bool, ()> {
    let key = (item.id, item.ep);
    let directory = super::path(root, item.id, item.ep);
    // queue -> access is also the delete order. Reserving prevents deletion while native holds source files.
    {
        let queue = cache.queue.lock().unwrap();
        if queue.active.contains_key(&item.id) {
            return Ok(false);
        }
        let mut state = cache.access.lock().unwrap();
        if state.readers.get(&key).copied().unwrap_or(0) > 0 || !state.converting.insert(key) {
            return Ok(false);
        }
    }
    let _converting = Converting(cache.access.clone(), key);
    let Some(current) = super::read_episode(root, &directory) else {
        return Ok(true);
    };
    if current.media_file.is_some() {
        let state = cache.access.lock().unwrap();
        if state.readers.contains_key(&key) {
            return Ok(false);
        }
        let _ = files::cleanup_legacy(&directory, &current);
        return Ok(true);
    }
    let ready =
        files::read_ready(&directory, current.id, Some(current.ep)).unwrap_or_else(|| Ready {
            id: current.id,
            ep: current.ep,
            title: current.title.clone(),
            bytes: current.bytes,
            mp4: current.mp4,
            filename: files::filename(
                &current.title,
                current.ep,
                files::timestamp(&directory.join("info.json")),
            ),
            watch_key: None,
        });
    files::persist_ready(&directory, &ready).map_err(|_| ())?;
    let output = directory.join(&ready.filename);
    files::cleanup_remux_temps(&directory, &ready.filename).map_err(|_| ())?;
    let stopped = || cache.queue.lock().unwrap().backgrounded;
    let result = async {
        if stopped() {
            return Err(super::remux::Error::Cancelled);
        }
        if current.mp4 {
            if !output.exists() {
                std::fs::hard_link(
                    current
                        .media_path(&directory)
                        .ok_or(super::remux::Error::Storage)?,
                    &output,
                )
                .map_err(|_| super::remux::Error::Storage)?;
            }
        } else {
            if output.exists() {
                if let Err(error) =
                    super::remux::convert(&output, &output, true, stopped, |_| {}).await
                {
                    if error == super::remux::Error::Cancelled {
                        return Err(error);
                    }
                    std::fs::remove_file(&output).map_err(|_| super::remux::Error::Storage)?;
                }
            }
            if !output.exists() {
                super::remux::convert(
                    &directory.join("index.m3u8"),
                    &output,
                    false,
                    stopped,
                    |_| {},
                )
                .await?;
            }
        }
        if stopped() {
            return Err(super::remux::Error::Cancelled);
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        diagnostics::record(
            root,
            "single_file_migration_deferred",
            serde_json::json!({"id":item.id,"ep":item.ep,"reason":format!("{error:?}")}),
        );
        return if error == super::remux::Error::Cancelled {
            Ok(false)
        } else {
            Err(())
        };
    }
    // Re-check readers under the same lock used by playback open, immediately before the authoritative pointer switch.
    let state = cache.access.lock().unwrap();
    if state.readers.contains_key(&key) {
        return Ok(false);
    }
    let bytes = std::fs::metadata(&output).map_err(|_| ())?.len();
    if bytes == 0 {
        return Err(());
    }
    let merged = Episode {
        mp4: true,
        media_file: Some(ready.filename),
        bytes,
        ..current
    };
    files::atomic_json(&directory, "info.json", &merged).map_err(|_| ())?;
    drop(state);
    let cleanup = files::cleanup_legacy(&directory, &merged);
    diagnostics::record(
        root,
        if cleanup.is_ok() {
            "single_file_migrated"
        } else {
            "single_file_cleanup_pending"
        },
        serde_json::json!({"id":item.id,"ep":item.ep,"bytes":bytes}),
    );
    Ok(true)
}
