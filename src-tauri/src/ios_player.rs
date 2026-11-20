mod preload;

use crate::{
    ios_media::{self, Sessions},
    offline::Cache,
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_char, c_void, CString},
    time::Instant,
};
use tauri::Manager;
use tokio::{sync::oneshot, task::AbortHandle};

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
    native_elapsed_ms: f64,
    item_ready_ms: f64,
    layer_ready_ms: f64,
    warm_asset: i32,
    standby_hit: i32,
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

struct PlaybackInput {
    path: CString,
    levels: Vec<ios_media::Level>,
    local: bool,
    manifest_ms: Option<u128>,
    media_timing: Option<ios_media::HlsMediaTiming>,
    prefetch_gateway: Option<std::sync::Arc<ios_media::Gateway>>,
    task: Option<AbortHandle>,
    _offline_lease: Option<crate::offline::ReadLease>,
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
    // The frontend may still hold a pre-migration mp4=false snapshot. Disk metadata is authoritative.
    let (source, offline_lease) = match source {
        Source::Offline { id, ep, .. } => {
            let (item, lease) = cache.open_episode(id, ep)?;
            (
                Source::Offline {
                    id,
                    ep,
                    mp4: item.mp4,
                },
                Some(lease),
            )
        }
        source => (source, None),
    };
    let (path, levels, local, task, manifest_ms, media_timing, prefetch_gateway) = match source {
        Source::Offline { id, ep, mp4: true } => {
            let path = cache.mp4_path(id, ep)?;
            (
                path.to_str().ok_or("本地视频路径无效")?.to_owned(),
                vec![],
                true,
                None,
                None,
                None,
                None,
            )
        }
        source => {
            let source = match source {
                Source::Offline { id, ep, .. } => ios_media::Source::Offline { id, ep },
                Source::Online { url, watch_key } => ios_media::Source::Online { url, watch_key },
            };
            let input = ios_media::prepare(app, source).await?;
            (
                input.url,
                input.levels,
                false,
                Some(input.task),
                input.manifest_ms,
                input.media_timing,
                input.prefetch_gateway,
            )
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
        manifest_ms,
        media_timing,
        prefetch_gateway,
        task,
        _offline_lease: offline_lease,
    })
}

#[tauri::command]
pub async fn ios_player_preload(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    source: Source,
    prefetch_segment: Option<bool>,
    prepare_standby: Option<bool>,
) -> Result<(), String> {
    preload::prepare_candidate(
        webview,
        app,
        &cache,
        source,
        prefetch_segment,
        prepare_standby,
    )
    .await
}

#[repr(C)]
#[derive(Default, Serialize)]
struct NativeOpenTiming {
    close_ms: f64,
    attach_ms: f64,
}

extern "C" {
    fn hg_player_preload(view: *mut c_void, source: *const c_char, local: bool);
    fn hg_player_prepare_standby(view: *mut c_void, owner: u64, source: *const c_char);
    fn hg_player_open(
        view: *mut c_void,
        token: u64,
        source: *const c_char,
        local: bool,
        timing: *mut NativeOpenTiming,
    ) -> bool;
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

#[derive(Serialize)]
pub struct Opened {
    levels: Vec<ios_media::Level>,
    warm_input: bool,
    input_ms: u128,
    preload_join_ms: Option<u128>,
    manifest_ms: Option<u128>,
    main_queue_ms: u128,
    native_timing: NativeOpenTiming,
}

#[tauri::command]
pub async fn ios_player_open(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    cache: tauri::State<'_, Cache>,
    sessions: tauri::State<'_, Sessions>,
    source: Source,
    token: u64,
) -> Result<Opened, String> {
    if !sessions.reserve(token) {
        return Err("播放器已关闭".into());
    }
    let input_started = Instant::now();
    let key = preload::WarmKey::new(source.clone());
    let mut foreground = preload::ForegroundWarm::reserve(&key, token);
    let preload_join_ms = foreground.join_pending().await;
    if !sessions.is_current(token) || !key.matches_current_scope() {
        return Err("播放器已关闭或线路已更改".into());
    }
    let warm = foreground.take_ready(&key);
    let warm_input = warm.is_some();
    let mut input = match warm {
        Some(input) => input,
        None => prepare_input(app.clone(), &cache, source).await?,
    };
    let manifest_ms = input.manifest_ms;
    let input_ms = input_started.elapsed().as_millis();
    if !key.matches_current_scope() {
        return Err("播放器线路已更改".into());
    }
    if !sessions.keep(
        token,
        input.task.take(),
        input._offline_lease.take(),
        input.media_timing.take(),
    ) {
        return Err("播放器已关闭".into());
    }
    let path = input.path.clone();
    let local = input.local;
    let levels = std::mem::take(&mut input.levels);
    let (tx, rx) = oneshot::channel();
    let dispatched = Instant::now();
    webview
        .with_webview(move |view| {
            let main_queue_ms = dispatched.elapsed().as_millis();
            if !app.state::<Sessions>().is_current(token) || !key.matches_current_scope() {
                let _ = tx.send(None);
                return;
            }
            let mut timing = NativeOpenTiming::default();
            let opened =
                unsafe { hg_player_open(view.inner(), token, path.as_ptr(), local, &mut timing) };
            if !opened {
                let mut snapshot = Snapshot::default();
                unsafe {
                    hg_player_control(
                        view.inner(),
                        token,
                        Action::Close as i32,
                        0.,
                        false,
                        &mut snapshot,
                    )
                };
            }
            let _ = tx.send(Some((opened, main_queue_ms, timing)));
        })
        .map_err(|_| {
            sessions.close(token);
            "播放器窗口不可用"
        })?;
    match rx.await {
        Ok(Some((true, main_queue_ms, native_timing))) => {
            sessions.opened(token);
            Ok(Opened {
                levels,
                warm_input,
                input_ms,
                preload_join_ms,
                manifest_ms,
                main_queue_ms,
                native_timing,
            })
        }
        Ok(None) => Err("播放器已关闭或线路已更改".into()),
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
        .map_err(|_| {
            if matches!(action, Action::Close) {
                sessions.close(token);
            }
            "播放器窗口不可用"
        })?;
    let result = rx.await;
    if matches!(action, Action::Close) {
        sessions.close(token);
    }
    match result {
        Ok(Some(snapshot)) => {
            let mut result = serde_json::json!(snapshot);
            if matches!(action, Action::Status) && snapshot.ready != 0 {
                if let Some(timing) = sessions.take_first_hls_media_response(token) {
                    result["first_hls_media_response"] = serde_json::json!(timing);
                }
            }
            Ok(result)
        }
        _ => Err("原生播放器已关闭".into()),
    }
}
