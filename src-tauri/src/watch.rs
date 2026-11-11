//! Recently fetched HLS resources. Only media bytes go to temporary files.
use crate::{media, net, network_policy};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::http::Response;

const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSIONS: usize = 12;
const MAX_OWNERS: usize = 24;
const MAX_RESOURCE: usize = 16 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
pub const MISSING: &str = "本集还有缺失分片，可以补齐后保留";

#[derive(Clone)]
pub struct Source {
    pub key: u64,
    pub id: i64,
    pub ep: u32,
    pub title: String,
    pub url: String,
    pub origin: String,
    pub episodes: Vec<u32>,
    pub cover: Option<String>,
}

#[derive(Serialize)]
pub struct Recent {
    key: u64,
    pub id: i64,
    pub ep: u32,
    title: String,
    bytes: u64,
    needs_fill: bool,
}

#[derive(Clone)]
enum Data {
    Memory(Vec<u8>),
    File(PathBuf),
}

#[derive(Clone)]
struct Resource {
    final_url: url::Url,
    kind: Option<String>,
    data: Data,
}

struct Files {
    dir: PathBuf,
    gate: Mutex<()>,
    retired: AtomicBool,
}

struct Cleanup {
    files: Arc<Files>,
    bytes: u64,
    retry_at: Instant,
}

struct Session {
    source: Source,
    strict: bool,
    needs_fill: bool,
    touched: Instant,
    bytes: u64,
    next_file: u64,
    reserved: u64,
    writing: std::collections::HashSet<String>,
    files: Arc<Files>,
    resources: HashMap<String, Resource>,
    media_urls: std::collections::HashSet<String>,
}

#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    next: u64,
    sessions: HashMap<u64, Session>,
    cleanup: HashMap<u64, Cleanup>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

static CLEANUP_WAKE: Condvar = Condvar::new();
static CLEANER: Lazy<()> = Lazy::new(|| {
    std::thread::Builder::new()
        .name("watch-cache-cleanup".into())
        .spawn(|| loop {
            let (key, files) = {
                let mut state = STATE.lock().unwrap();
                loop {
                    let now = Instant::now();
                    if let Some((&key, item)) =
                        state.cleanup.iter().find(|(_, item)| item.retry_at <= now)
                    {
                        break (key, item.files.clone());
                    }
                    let delay = state
                        .cleanup
                        .values()
                        .map(|item| item.retry_at.saturating_duration_since(now))
                        .min()
                        .unwrap_or(Duration::from_secs(60));
                    state = CLEANUP_WAKE.wait_timeout(state, delay).unwrap().0;
                }
            };
            // A retired writer may still be flushing. It owns only this session,
            // so source/read/pause and other sessions never wait for its disk I/O.
            let result = {
                let _file = files.gate.lock().unwrap();
                std::fs::remove_dir_all(&files.dir)
            };
            let mut state = STATE.lock().unwrap();
            finish_cleanup(&mut state, key, &result);
        })
        .expect("watch cleanup thread");
});

fn finish_cleanup(state: &mut State, key: u64, result: &std::io::Result<()>) {
    if result.is_ok()
        || result
            .as_ref()
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        state.cleanup.remove(&key);
    } else if let Some(item) = state.cleanup.get_mut(&key) {
        item.retry_at = Instant::now() + Duration::from_secs(30);
        eprintln!("watch cache cleanup deferred");
    }
}

pub fn bind(root: PathBuf) {
    // Startup only: signed URLs/keys are intentionally not restored. A failed
    // cleanup disables new temporary capture instead of hiding old disk usage.
    let removed = std::fs::remove_dir_all(&root);
    if removed.is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound) {
        return;
    }
    if std::fs::create_dir_all(&root).is_ok() {
        STATE.lock().unwrap().root = Some(root);
    }
}

fn evict(state: &mut State, key: u64) {
    if let Some(session) = state.sessions.remove(&key) {
        session.files.retired.store(true, Ordering::Release);
        state.cleanup.insert(
            key,
            Cleanup {
                files: session.files,
                bytes: session.bytes + session.reserved,
                retry_at: Instant::now(),
            },
        );
        Lazy::force(&CLEANER);
        CLEANUP_WAKE.notify_one();
    }
}

fn used_bytes(state: &State) -> u64 {
    state
        .sessions
        .values()
        .map(|item| item.bytes + item.reserved)
        .sum::<u64>()
        + state.cleanup.values().map(|item| item.bytes).sum::<u64>()
}

fn expire(state: &mut State) {
    let expired: Vec<_> = state
        .sessions
        .iter()
        .filter_map(|(&key, item)| (item.touched.elapsed() > TTL).then_some(key))
        .collect();
    for key in expired {
        evict(state, key);
    }
}

fn same_context(session: &Session) -> bool {
    session.source.origin == net::base() && session.strict == network_policy::strict_security()
}

#[tauri::command]
pub fn watch_begin(id: i64, ep: u32, url: String) -> Option<u64> {
    if id <= 0 || ep == 0 || url.len() > 8192 {
        return None;
    }
    let parsed = network_policy::parse_target(&url).ok()?;
    if parsed.path().to_ascii_lowercase().ends_with(".mp4") {
        return None;
    }
    let url = parsed.to_string();
    let mut state = STATE.lock().unwrap();
    state.root.as_ref()?;
    expire(&mut state);
    if let Some(item) = state.sessions.values_mut().find(|item| {
        item.source.id == id && item.source.ep == ep && item.source.url == url && same_context(item)
    }) {
        item.touched = Instant::now();
        return Some(item.source.key);
    }
    if state.sessions.len() >= MAX_SESSIONS {
        if let Some(key) = state
            .sessions
            .iter()
            .min_by_key(|(_, item)| item.touched)
            .map(|(&key, _)| key)
        {
            evict(&mut state, key);
        }
    }
    // Failed deletion still owns space and an identity. Bound both the retry
    // ledger and admission until the single cleaner can release that storage.
    if state.sessions.len() + state.cleanup.len() >= MAX_OWNERS {
        return None;
    }
    let root = state.root.as_ref()?.clone();
    state.next += 1;
    let key = state.next;
    state.sessions.insert(
        key,
        Session {
            source: Source {
                key,
                id,
                ep,
                title: format!("剧集 {id}"),
                url,
                origin: net::base(),
                episodes: Vec::new(),
                cover: None,
            },
            strict: network_policy::strict_security(),
            needs_fill: false,
            touched: Instant::now(),
            bytes: 0,
            next_file: 0,
            reserved: 0,
            writing: Default::default(),
            files: Arc::new(Files {
                dir: root.join(key.to_string()),
                gate: Mutex::new(()),
                retired: AtomicBool::new(false),
            }),
            resources: HashMap::new(),
            media_urls: Default::default(),
        },
    );
    Some(key)
}

#[tauri::command]
pub fn watch_details(key: u64, title: String, mut episodes: Vec<u32>, cover: Option<String>) {
    let mut state = STATE.lock().unwrap();
    if let Some(session) = state.sessions.get_mut(&key) {
        if !title.trim().is_empty() {
            session.source.title = title.trim().chars().take(160).collect();
        }
        episodes.retain(|&ep| ep > 0);
        episodes.sort_unstable();
        episodes.dedup();
        session.source.episodes = episodes;
        session.source.cover = cover.filter(|url| url.len() <= 8192);
    }
}

pub fn discard(key: u64) {
    evict(&mut STATE.lock().unwrap(), key);
}

pub fn discard_recent(key: u64) {
    let mut state = STATE.lock().unwrap();
    let Some(selected) = state
        .sessions
        .get(&key)
        .filter(|session| same_context(session))
    else {
        return;
    };
    let id = selected.source.id;
    let ep = selected.source.ep;
    let keys: Vec<_> = state
        .sessions
        .iter()
        .filter_map(|(&key, session)| {
            (session.source.id == id && session.source.ep == ep && same_context(session))
                .then_some(key)
        })
        .collect();
    for key in keys {
        evict(&mut state, key);
    }
}

pub fn needs_fill(key: u64) {
    if let Some(session) = STATE.lock().unwrap().sessions.get_mut(&key) {
        session.needs_fill = true;
    }
}

pub fn source(key: u64) -> Option<Source> {
    let mut state = STATE.lock().unwrap();
    expire(&mut state);
    let session = state
        .sessions
        .get_mut(&key)
        .filter(|session| same_context(session))?;
    session.touched = Instant::now();
    Some(session.source.clone())
}

pub fn recent() -> Vec<Recent> {
    let mut state = STATE.lock().unwrap();
    expire(&mut state);
    let mut sessions: Vec<_> = state
        .sessions
        .values()
        .filter(|item| {
            same_context(item)
                && item
                    .resources
                    .values()
                    .any(|entry| matches!(&entry.data, Data::File(_)))
        })
        .collect();
    sessions.sort_by_key(|item| std::cmp::Reverse(item.touched));
    let mut seen = std::collections::HashSet::new();
    sessions
        .into_iter()
        .filter(|item| seen.insert((item.source.id, item.source.ep)))
        .map(|item| Recent {
            key: item.source.key,
            id: item.source.id,
            ep: item.source.ep,
            title: item.source.title.clone(),
            bytes: item.bytes,
            needs_fill: item.needs_fill,
        })
        .collect()
}

pub async fn read(key: u64, url: &str) -> Option<(Option<String>, Vec<u8>, url::Url)> {
    let entry = {
        let mut state = STATE.lock().unwrap();
        let session = state
            .sessions
            .get_mut(&key)
            .filter(|session| same_context(session))?;
        session.touched = Instant::now();
        session.resources.get(url)?.clone()
    };
    let bytes = match entry.data {
        Data::Memory(bytes) => bytes,
        Data::File(file) => tokio::fs::read(file).await.ok()?,
    };
    Some((entry.kind, bytes, entry.final_url))
}

fn write_resource(
    files: &Files,
    number: u64,
    bytes: &[u8],
    write: impl FnOnce(&std::path::Path, &[u8]) -> std::io::Result<()>,
) -> Option<Data> {
    let _file = files.gate.lock().unwrap();
    if files.retired.load(Ordering::Acquire) {
        return None;
    }
    let temporary = files.dir.join(format!("{number}.part"));
    let final_path = files.dir.join(number.to_string());
    let result = std::fs::create_dir_all(&files.dir)
        .and_then(|_| write(&temporary, bytes))
        .and_then(|_| std::fs::rename(&temporary, &final_path));
    if result.is_ok() {
        Some(Data::File(final_path))
    } else {
        // The caller retires this session even if this best-effort removal
        // fails, so the cleanup owner retains its bytes until a later retry.
        let _ = std::fs::remove_file(&temporary);
        None
    }
}

fn record(key: u64, target: String, kind: Option<String>, final_url: url::Url, bytes: &[u8]) {
    record_with_writer(key, target, kind, final_url, bytes, |path, data| {
        std::fs::write(path, data)
    });
}

fn record_with_writer(
    key: u64,
    target: String,
    kind: Option<String>,
    final_url: url::Url,
    bytes: &[u8],
    write: impl FnOnce(&std::path::Path, &[u8]) -> std::io::Result<()>,
) {
    if bytes.is_empty() || bytes.len() > MAX_RESOURCE {
        return;
    }
    let playlist = bytes.starts_with(b"#EXTM3U") || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    let memory = playlist || bytes.len() <= 64;
    if playlist && bytes.len() > 512 * 1024 {
        return;
    }
    let size = bytes.len() as u64;
    let reservation = {
        let mut state = STATE.lock().unwrap();
        let Some(session) = state.sessions.get(&key) else {
            return;
        };
        if !same_context(session)
            || (!memory && !session.media_urls.contains(&target))
            || session.resources.contains_key(&target)
            || session.writing.contains(&target)
        {
            return;
        }
        // Retired files remain charged until deletion succeeds. Eviction is
        // asynchronous; a full disk budget may skip this optional capture.
        if used_bytes(&state).saturating_add(size) > MAX_BYTES {
            let oldest = state
                .sessions
                .iter()
                .filter(|(&id, _)| id != key)
                .min_by_key(|(_, item)| item.touched)
                .map(|(&id, _)| id);
            if let Some(oldest) = oldest {
                evict(&mut state, oldest);
            }
            return;
        }
        let session = state.sessions.get_mut(&key).unwrap();
        session.reserved += size;
        session.writing.insert(target.clone());
        session.next_file += 1;
        (session.files.clone(), session.next_file)
    };
    let (files, number) = reservation;
    let data = if memory {
        Some(Data::Memory(bytes.to_vec()))
    } else {
        write_resource(&files, number, bytes, write)
    };
    let mut state = STATE.lock().unwrap();
    let Some(session) = state.sessions.get_mut(&key) else {
        return;
    };
    session.writing.remove(&target);
    if data.is_none() {
        // A write error may have left an untracked partial file. Retire this
        // optional cache session; its entire reserved budget stays charged.
        evict(&mut state, key);
        return;
    }
    session.reserved -= size;
    if !same_context(session) {
        // The result belongs to the old policy/origin, never publish it.
        session.reserved += size;
        evict(&mut state, key);
        return;
    }
    let data = data.unwrap();
    if playlist {
        let text = String::from_utf8_lossy(bytes);
        for line in text.lines().map(str::trim) {
            let asset = if line.starts_with("#EXT-X-MAP:") {
                media::hls_attributes(line).and_then(|(_, attrs)| {
                    attrs.into_iter().find_map(|attr| {
                        attr.trim()
                            .strip_prefix("URI=")
                            .map(|value| value.trim_matches('"'))
                    })
                })
            } else if !line.is_empty() && !line.starts_with('#') {
                Some(line)
            } else {
                None
            };
            if let Some(asset) = asset.and_then(|asset| final_url.join(asset).ok()) {
                session.media_urls.insert(asset.to_string());
            }
        }
    }
    session.bytes += size;
    session.touched = Instant::now();
    session.resources.insert(
        target,
        Resource {
            final_url,
            kind,
            data,
        },
    );
}

// Retain admission until recording finishes, so slow disk writes cannot queue
// an unbounded number of fully downloaded segment buffers.
static SERVE_SLOTS: Lazy<Arc<tokio::sync::Semaphore>> =
    Lazy::new(|| Arc::new(tokio::sync::Semaphore::new(4)));

fn record_response(
    bytes: Vec<u8>,
    slot: tokio::sync::OwnedSemaphorePermit,
    write: impl FnOnce(&[u8]) + Send + 'static,
) -> tokio::task::JoinHandle<(Vec<u8>, tokio::sync::OwnedSemaphorePermit)> {
    tokio::task::spawn_blocking(move || {
        write(&bytes);
        // Cancellation cannot release admission while disk I/O owns the body.
        (bytes, slot)
    })
}

pub async fn serve(path: &str, query: &str, origin: &str) -> Response<Vec<u8>> {
    let Ok(slot) = SERVE_SLOTS.clone().acquire_owned().await else {
        return media::respond(503, "text/plain", Vec::new(), "no-store");
    };
    let Some((key, kind)) = path
        .strip_prefix("/watch/")
        .and_then(|rest| rest.split_once('/'))
    else {
        return media::respond(404, "text/plain", Vec::new(), "no-store");
    };
    let route = if kind == "hls" {
        "/hls"
    } else if kind == "seg" {
        "/seg"
    } else {
        return media::respond(404, "text/plain", Vec::new(), "no-store");
    };
    let Some(source) = key.parse().ok().and_then(source) else {
        return media::handle(route, query, origin).await;
    };
    let raw = media::target_from_query(query);
    let Ok(target) = network_policy::parse_target(&raw) else {
        return media::respond(400, "text/plain", Vec::new(), "no-store");
    };
    let target = target.to_string();
    let hit = read(source.key, &target).await;
    let cached = hit.is_some();
    let fetched = match hit {
        Some((kind, bytes, url)) => Ok((kind, bytes, url, true)),
        None => net::fetch_media_bounded(&target, &source.origin, MAX_RESOURCE).await,
    };
    match fetched {
        Ok((kind, bytes, final_url, complete)) => {
            let (bytes, _slot) = if !cached && complete && bytes.len() <= MAX_RESOURCE {
                let target = target.clone();
                let content_type = kind.clone();
                let final_url = final_url.clone();
                // Move the body through recording and return it for the response;
                // retaining a second full segment is unnecessary.
                match record_response(bytes, slot, move |bytes| {
                    record(source.key, target, content_type, final_url, bytes);
                })
                .await
                {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        return media::respond(
                            502,
                            "text/plain",
                            b"media unavailable".to_vec(),
                            "no-store",
                        )
                    }
                }
            } else {
                (bytes, slot)
            };
            media::segment_response(
                final_url.as_str(),
                kind.as_deref(),
                bytes,
                &format!("{origin}/watch/{key}"),
            )
        }
        Err(_) => media::respond(502, "text/plain", b"media unavailable".to_vec(), "no-store"),
    }
}

pub fn playlist_score(key: u64, url: &str) -> usize {
    let state = STATE.lock().unwrap();
    let Some(session) = state.sessions.get(&key) else {
        return 0;
    };
    let Some(resource) = session.resources.get(url) else {
        return 0;
    };
    let Data::Memory(bytes) = &resource.data else {
        return 0;
    };
    let Ok(playlist) = std::str::from_utf8(bytes) else {
        return 0;
    };
    let mut total = 0;
    let mut present = 0;
    for line in playlist
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        total += 1;
        if resource
            .final_url
            .join(line)
            .ok()
            .is_some_and(|url| session.resources.contains_key(url.as_str()))
        {
            present += 1;
        }
    }
    if total == 0 {
        1
    } else {
        1 + present * 1000 / total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, sync::mpsc, time::SystemTime};

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn files() -> Arc<Files> {
        let dir = std::env::temp_dir().join(format!(
            "hg-watch-owner-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(Files {
            dir,
            gate: Mutex::new(()),
            retired: AtomicBool::new(false),
        })
    }

    fn session(files: Arc<Files>) -> (u64, String) {
        let target = "https://example.invalid/part.ts".to_string();
        let mut state = STATE.lock().unwrap();
        state.next += 1;
        let key = state.next;
        state.sessions.insert(
            key,
            Session {
                source: Source {
                    key,
                    id: 1,
                    ep: 1,
                    title: "fixture".into(),
                    url: "https://example.invalid/index.m3u8".into(),
                    origin: net::base(),
                    episodes: vec![1],
                    cover: None,
                },
                strict: network_policy::strict_security(),
                needs_fill: false,
                touched: Instant::now(),
                bytes: 0,
                next_file: 0,
                reserved: 0,
                writing: Default::default(),
                files,
                resources: HashMap::new(),
                media_urls: std::collections::HashSet::from([target.clone()]),
            },
        );
        (key, target)
    }

    fn wait_cleaned(key: u64, files: &Files) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while STATE.lock().unwrap().cleanup.contains_key(&key) {
            assert!(Instant::now() < deadline, "cleanup did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!files.dir.exists());
    }

    #[test]
    fn eviction_during_write_keeps_control_unblocked_and_prevents_resurrection() {
        let _serial = TEST_LOCK.lock().unwrap();
        let files = files();
        let (key, target) = session(files.clone());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            record_with_writer(
                key,
                target.clone(),
                None,
                target.parse().unwrap(),
                &[0x47; 188],
                |path, bytes| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    std::fs::write(path, bytes)
                },
            );
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut state = STATE.try_lock().expect("disk writer must not hold STATE");
        evict(&mut state, key);
        assert!(!state.sessions.contains_key(&key));
        assert_eq!(state.cleanup[&key].bytes, 188);
        assert!(used_bytes(&state) >= 188);
        drop(state);
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        wait_cleaned(key, &files);
        assert!(!STATE.lock().unwrap().sessions.contains_key(&key));
    }

    #[test]
    fn failed_partial_write_is_retired_and_removed() {
        let _serial = TEST_LOCK.lock().unwrap();
        let files = files();
        let (key, target) = session(files.clone());
        record_with_writer(
            key,
            target.clone(),
            None,
            target.parse().unwrap(),
            &[0x47; 188],
            |path, bytes| {
                std::fs::write(path, &bytes[..3])?;
                Err(io::Error::other("injected partial write"))
            },
        );
        assert!(!STATE.lock().unwrap().sessions.contains_key(&key));
        wait_cleaned(key, &files);
    }

    #[test]
    fn failed_cleanup_retains_ownership_and_budget_until_retry_succeeds() {
        let mut state = State::default();
        state.cleanup.insert(
            1,
            Cleanup {
                files: files(),
                bytes: 188,
                retry_at: Instant::now(),
            },
        );
        finish_cleanup(
            &mut state,
            1,
            &Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        );
        assert_eq!(used_bytes(&state), 188);
        assert!(state.cleanup[&1].retry_at > Instant::now());
        finish_cleanup(&mut state, 1, &Ok(()));
        assert!(state.cleanup.is_empty());
        assert_eq!(used_bytes(&state), 0);
    }

    #[tokio::test]
    async fn cancelled_responses_keep_admission_until_blocking_writers_finish() {
        let slots = Arc::new(tokio::sync::Semaphore::new(4));
        let release = Arc::new(std::sync::Barrier::new(5));
        let (started_tx, started_rx) = mpsc::channel();
        let mut requests = Vec::new();
        for _ in 0..4 {
            let slot = slots.clone().acquire_owned().await.unwrap();
            let release = release.clone();
            let started = started_tx.clone();
            requests.push(tokio::spawn(async move {
                record_response(vec![0; 188], slot, move |_| {
                    started.send(()).unwrap();
                    release.wait();
                })
                .await
            }));
        }
        tokio::task::spawn_blocking(move || {
            for _ in 0..4 {
                started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            }
        })
        .await
        .unwrap();
        for request in requests {
            request.abort();
            let _ = request.await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(30), slots.acquire())
                .await
                .is_err()
        );
        release.wait();
        tokio::time::timeout(Duration::from_secs(3), async {
            while slots.available_permits() != 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn retired_writer_never_recreates_its_directory() {
        let files = files();
        files.retired.store(true, Ordering::Release);
        assert!(write_resource(&files, 1, b"body", |_, _| panic!("retired write")).is_none());
        assert!(!files.dir.exists());
    }
}
