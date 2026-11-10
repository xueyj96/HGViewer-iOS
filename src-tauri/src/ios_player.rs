use crate::{
    ios_media::{self, Sessions},
    offline::Cache,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_void, CString},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{
    sync::{oneshot, Semaphore},
    task::AbortHandle,
};

#[repr(C)]
#[derive(Default, Serialize)]
struct Snapshot {
    time: f64,
    duration: f64,
    width: f64,
    height: f64,
    status: i32,
    ready: i32,
    app_state: i32,
    error_domain: i32,
    underlying_domain: i32,
    error_code: i64,
    underlying_code: i64,
}

#[repr(C)]
#[derive(Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    top: f64,
    bottom: f64,
    viewport: bool,
}

#[repr(i32)]
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Status,
    Play,
    Pause,
    Seek,
    Rate,
    Volume,
    Mute,
    Close,
    Quality,
    SlideOut,
    SlideIn,
    EdgePull,
    EpisodePull,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    Offline { id: i64, ep: u32, mp4: bool },
    Online { url: String, watch_key: Option<u64> },
}

const PRELOAD_TTL: Duration = Duration::from_secs(30);
const PRELOAD_LIMIT: usize = 4;
static PRELOADS: Semaphore = Semaphore::const_new(2);
static WARM: Mutex<VecDeque<(WarmKey, Instant, PlaybackInput)>> = Mutex::new(VecDeque::new());

#[derive(Clone, PartialEq, Eq)]
struct WarmKey {
    source: Source,
    route: String,
    strict: bool,
}

impl WarmKey {
    fn new(source: Source) -> Self {
        Self {
            source,
            route: crate::net::base(),
            strict: crate::network_policy::strict_security(),
        }
    }
}

struct PlaybackInput {
    path: CString,
    levels: Vec<ios_media::Level>,
    local: bool,
    task: Option<AbortHandle>,
}

impl Drop for PlaybackInput {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn prepare_input(
    app: tauri::AppHandle,
    cache: &Cache,
    source: Source,
) -> Result<PlaybackInput, String> {
    let (path, levels, local, task) = match source {
        Source::Offline { id, ep, mp4: true } => {
            let path = cache.mp4_path(id, ep)?;
            (
                path.to_str().ok_or("本地视频路径无效")?.to_owned(),
                vec![],
                true,
                None,
            )
        }
        source => {
            let source = match source {
                Source::Offline { id, ep, .. } => ios_media::Source::Offline { id, ep },
                Source::Online { url, watch_key } => ios_media::Source::Online { url, watch_key },
            };
            let input = ios_media::prepare(app, source).await?;
            (input.url, input.levels, false, Some(input.task))
        }
    };
    let path = CString::new(path).map_err(|_| {
        if let Some(task) = &task {
            task.abort();
        }
        "视频地址无效"
    })?;
    Ok(PlaybackInput {
        path,
        levels,
        local,
        task,
    })
}

#[tauri::command]
pub async fn ios_player_preload(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    source: Source,
) -> Result<(), String> {
    let Ok(_permit) = PRELOADS.try_acquire() else {
        return Ok(());
    };
    let key = WarmKey::new(source.clone());
    if WARM
        .lock()
        .unwrap()
        .iter()
        .any(|(stored, at, _)| *stored == key && at.elapsed() < PRELOAD_TTL)
    {
        return Ok(());
    }
    let input = tokio::time::timeout(Duration::from_secs(8), prepare_input(app, &cache, source))
        .await
        .map_err(|_| "预加载超时")??;
    if key != WarmKey::new(key.source.clone()) {
        return Ok(());
    }
    let path = input.path.clone();
    let local = input.local;
    webview
        .with_webview(move |view| unsafe {
            hg_player_preload(view.inner(), path.as_ptr(), local);
        })
        .map_err(|_| "播放器窗口不可用")?;

    let created = Instant::now();
    {
        let mut warm = WARM.lock().unwrap();
        warm.retain(|(stored, at, _)| *stored != key && at.elapsed() < PRELOAD_TTL);
        if warm.len() == PRELOAD_LIMIT {
            warm.pop_front();
        }
        warm.push_back((key.clone(), created, input));
    }
    tokio::spawn(async move {
        tokio::time::sleep(PRELOAD_TTL).await;
        WARM.lock()
            .unwrap()
            .retain(|(stored, at, _)| *stored != key || *at != created);
    });
    Ok(())
}

extern "C" {
    fn hg_player_preload(view: *mut c_void, source: *const c_char, local: bool);
    fn hg_player_open(view: *mut c_void, token: u64, source: *const c_char, local: bool) -> bool;
    fn hg_player_frame(view: *mut c_void, token: u64, rect: *const Rect);
    fn hg_player_control(
        view: *mut c_void,
        token: u64,
        action: i32,
        value: f64,
        resume: bool,
        snapshot: *mut Snapshot,
    ) -> bool;
}

#[tauri::command]
pub async fn ios_player_open(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    sessions: tauri::State<'_, Sessions>,
    source: Source,
    token: u64,
) -> Result<Vec<ios_media::Level>, String> {
    if !sessions.reserve(token) {
        return Err("播放器已关闭".into());
    }
    let key = WarmKey::new(source.clone());
    let warm = {
        let mut warm = WARM.lock().unwrap();
        warm.retain(|(_, at, _)| at.elapsed() < PRELOAD_TTL);
        warm.iter()
            .position(|(stored, _, _)| *stored == key)
            .and_then(|index| warm.remove(index))
            .map(|(_, _, input)| input)
    };
    let mut input = match warm {
        Some(input) => input,
        None => prepare_input(app, &cache, source).await?,
    };
    if let Some(task) = input.task.take() {
        if !sessions.keep(token, task) {
            return Err("播放器已关闭".into());
        }
    }
    let path = input.path.clone();
    let local = input.local;
    let levels = std::mem::take(&mut input.levels);
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |view| {
            let opened = unsafe { hg_player_open(view.inner(), token, path.as_ptr(), local) };
            let _ = tx.send(opened);
        })
        .map_err(|_| "播放器窗口不可用")?;
    match rx.await {
        Ok(true) => Ok(levels),
        _ => {
            sessions.close(token);
            Err("无法启动原生播放器".into())
        }
    }
}

#[tauri::command]
pub fn ios_player_frame(webview: tauri::Webview, token: u64, rect: Rect) -> Result<(), String> {
    if ![
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        rect.top,
        rect.bottom,
    ]
    .iter()
    .all(|value| value.is_finite() && value.abs() <= 20_000.0)
    {
        return Err("播放器位置无效".into());
    }
    webview
        .with_webview(move |view| unsafe {
            hg_player_frame(view.inner(), token, &rect);
        })
        .map_err(|_| "播放器窗口不可用".into())
}

#[tauri::command]
pub async fn ios_player_control(
    webview: tauri::Webview,
    sessions: tauri::State<'_, Sessions>,
    token: u64,
    action: Action,
    value: f64,
    resume: bool,
) -> Result<serde_json::Value, String> {
    if matches!(action, Action::Close) {
        sessions.close(token);
    }
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |view| {
            let mut snapshot = Snapshot::default();
            let active = unsafe {
                hg_player_control(
                    view.inner(),
                    token,
                    action as i32,
                    value,
                    resume,
                    &mut snapshot,
                )
            };
            let _ = tx.send(active.then_some(snapshot));
        })
        .map_err(|_| "播放器窗口不可用")?;
    match rx.await {
        Ok(Some(snapshot)) => Ok(serde_json::json!(snapshot)),
        _ => Err("原生播放器已关闭".into()),
    }
}
