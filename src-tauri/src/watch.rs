//! Recently fetched HLS resources. Only media bytes go to temporary files.
use crate::{media, net, network_policy};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::http::Response;

const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSIONS: usize = 12;
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
    len: u64,
    data: Data,
}

struct Session {
    source: Source,
    strict: bool,
    needs_fill: bool,
    touched: Instant,
    bytes: u64,
    next_file: u64,
    resources: HashMap<String, Resource>,
    media_urls: std::collections::HashSet<String>,
}

#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    next: u64,
    sessions: HashMap<u64, Session>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

pub fn bind(root: PathBuf) {
    // Signed source URLs and decryption keys only live in memory.
    let _ = std::fs::remove_dir_all(&root);
    if std::fs::create_dir_all(&root).is_ok() {
        STATE.lock().unwrap().root = Some(root);
    }
}

fn evict(state: &mut State, key: u64) {
    if state.sessions.remove(&key).is_some() {
        if let Some(root) = &state.root {
            let _ = std::fs::remove_dir_all(root.join(key.to_string()));
        }
    }
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

fn record(key: u64, target: String, kind: Option<String>, final_url: url::Url, bytes: &[u8]) {
    if bytes.is_empty() || bytes.len() > MAX_RESOURCE {
        return;
    }
    let playlist = bytes.starts_with(b"#EXTM3U") || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    let memory = playlist || bytes.len() <= 64;
    if playlist && bytes.len() > 512 * 1024 {
        return;
    }
    let mut state = STATE.lock().unwrap();
    let Some(session) = state.sessions.get(&key) else {
        return;
    };
    if !same_context(session) || (!memory && !session.media_urls.contains(&target)) {
        return;
    }
    if session
        .resources
        .get(&target)
        .is_some_and(|old| match &old.data {
            Data::Memory(_) => true,
            Data::File(path) => path.is_file(),
        })
    {
        return;
    }
    let size = bytes.len() as u64;
    let previous_size = session.resources.get(&target).map_or(0, |entry| entry.len);
    let mut used: u64 = state.sessions.values().map(|item| item.bytes).sum();
    used -= previous_size;
    while used + size > MAX_BYTES {
        let Some((&old, session)) = state
            .sessions
            .iter()
            .filter(|(&id, _)| id != key)
            .min_by_key(|(_, item)| item.touched)
        else {
            return;
        };
        used -= session.bytes;
        evict(&mut state, old);
    }
    let data = if memory {
        Data::Memory(bytes.to_vec())
    } else {
        let Some(root) = &state.root else {
            return;
        };
        let dir = root.join(key.to_string());
        let session = state.sessions.get_mut(&key).unwrap();
        session.next_file += 1;
        let file = dir.join(session.next_file.to_string());
        if std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&file, bytes))
            .is_err()
        {
            return;
        }
        Data::File(file)
    };
    let session = state.sessions.get_mut(&key).unwrap();
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
    session.bytes = session.bytes - previous_size + size;
    session.touched = Instant::now();
    session.resources.insert(
        target,
        Resource {
            final_url,
            kind,
            len: size,
            data,
        },
    );
}

pub async fn serve(path: &str, query: &str, origin: &str) -> Response<Vec<u8>> {
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
        None => net::fetch_media(&target, &source.origin).await,
    };
    match fetched {
        Ok((kind, bytes, final_url, complete)) => {
            if !cached && complete && bytes.len() <= MAX_RESOURCE {
                let target = target.clone();
                let content_type = kind.clone();
                let final_url = final_url.clone();
                let data = bytes.clone();
                // Finish recording before the player can report the episode ended.
                let _ = tokio::task::spawn_blocking(move || {
                    record(source.key, target, content_type, final_url, &data)
                })
                .await;
            }
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
