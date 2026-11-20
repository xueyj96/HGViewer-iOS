//! Owns prepared playback inputs until a matching foreground command takes them.
use super::{
    hg_player_preload, hg_player_prepare_standby, prepare_input, Cache, PlaybackInput, Sessions,
    Source,
};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::{oneshot, watch, Semaphore};

const FOREGROUND_JOIN_BUDGET: Duration = Duration::from_millis(180);
const PRELOAD_TTL: Duration = Duration::from_secs(30);
const PRELOAD_LIMIT: usize = 4;
static PRELOADS: Semaphore = Semaphore::const_new(2);
static WARM: Mutex<WarmState> = Mutex::new(WarmState {
    ready: VecDeque::new(),
    pending: Vec::new(),
    opening: Vec::new(),
});

struct WarmState {
    ready: VecDeque<(WarmKey, Instant, PlaybackInput)>,
    pending: Vec<Flight>,
    opening: Vec<(WarmKey, u64)>,
}

struct Flight {
    key: WarmKey,
    completed: watch::Receiver<()>,
    // Removal also cancels the optional preparation.
    _cancel: oneshot::Sender<()>,
}

struct PendingPreload {
    identity: watch::Receiver<()>,
    // Dropping the sender wakes foreground readers after registry publication.
    _completion: watch::Sender<()>,
}

impl Drop for PendingPreload {
    fn drop(&mut self) {
        remove_flight(&self.identity);
    }
}

fn remove_flight(identity: &watch::Receiver<()>) {
    WARM.lock()
        .unwrap()
        .pending
        .retain(|flight| !flight.completed.same_channel(identity));
}

struct ForegroundInput(u64);

impl Drop for ForegroundInput {
    fn drop(&mut self) {
        WARM.lock()
            .unwrap()
            .opening
            .retain(|(_, token)| *token != self.0);
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct WarmKey {
    source: Source,
    route: String,
    strict: bool,
}

impl WarmKey {
    pub(super) fn new(source: Source) -> Self {
        Self {
            source,
            route: crate::net::base(),
            strict: crate::network_policy::strict_security(),
        }
    }
    pub(super) fn matches_current_scope(&self) -> bool {
        self.route == crate::net::base() && self.strict == crate::network_policy::strict_security()
    }
}

pub(super) struct ForegroundWarm {
    _reservation: ForegroundInput,
    pending: Option<watch::Receiver<()>>,
}

impl ForegroundWarm {
    pub(super) fn reserve(key: &WarmKey, token: u64) -> Self {
        let mut state = WARM.lock().unwrap();
        state.opening.push((key.clone(), token));
        let pending = state
            .pending
            .iter()
            .find(|flight| &flight.key == key)
            .map(|flight| flight.completed.clone());
        Self {
            _reservation: ForegroundInput(token),
            pending,
        }
    }

    pub(super) async fn join_pending(&mut self) -> Option<u128> {
        let mut completion = self.pending.take()?;
        let joined = Instant::now();
        // A speculative request must never hold the foreground until its own
        // deadline. Removing this exact flight cancels it and fences publication.
        if tokio::time::timeout(FOREGROUND_JOIN_BUDGET, completion.changed())
            .await
            .is_err()
        {
            remove_flight(&completion);
        }
        Some(joined.elapsed().as_millis())
    }

    pub(super) fn take_ready(&self, key: &WarmKey) -> Option<PlaybackInput> {
        let mut state = WARM.lock().unwrap();
        state.ready.retain(|(_, at, _)| at.elapsed() < PRELOAD_TTL);
        let index = state
            .ready
            .iter()
            .position(|(stored, _, _)| stored == key)?;
        state.ready.remove(index).map(|(_, _, input)| input)
    }
}

pub(super) async fn prepare_candidate(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    cache: &Cache,
    source: Source,
    prefetch_segment: Option<bool>,
    prepare_standby: Option<bool>,
) -> Result<(), String> {
    let Ok(_permit) = PRELOADS.try_acquire() else {
        return Ok(());
    };
    let standby_owner = (prepare_standby == Some(true)
        && matches!(
            &source,
            Source::Online {
                watch_key: Some(_),
                ..
            }
        ))
    .then(|| app.state::<Sessions>().active_token())
    .flatten();
    let key = WarmKey::new(source.clone());
    let (pending, cancelled) = {
        let mut warm = WARM.lock().unwrap();
        warm.ready.retain(|(_, at, _)| at.elapsed() < PRELOAD_TTL);
        if warm.ready.iter().any(|(stored, _, _)| *stored == key)
            || warm.pending.iter().any(|flight| flight.key == key)
            || warm.opening.iter().any(|(stored, _)| *stored == key)
        {
            return Ok(());
        }
        let (completion, receiver) = watch::channel(());
        let (cancel, cancelled) = oneshot::channel();
        warm.pending.push(Flight {
            key: key.clone(),
            completed: receiver.clone(),
            _cancel: cancel,
        });
        (
            PendingPreload {
                identity: receiver,
                _completion: completion,
            },
            cancelled,
        )
    };
    let mut input = tokio::select! {
        _ = cancelled => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(8), prepare_input(app.clone(), cache, source)) => {
            result.map_err(|_| "预加载超时")??
        }
    };
    if !key.matches_current_scope() {
        return Ok(());
    }
    let path = input.path.clone();
    let standby_path = standby_owner.map(|_| path.clone());
    let local = input.local;
    let gateway = input.prefetch_gateway.take();
    let created = Instant::now();
    {
        let mut state = WARM.lock().unwrap();
        if !state
            .pending
            .iter()
            .any(|flight| flight.completed.same_channel(&pending.identity))
        {
            return Ok(());
        }
        let warm = &mut state.ready;
        warm.retain(|(stored, at, _)| *stored != key && at.elapsed() < PRELOAD_TTL);
        if warm.len() == PRELOAD_LIMIT {
            warm.pop_front();
        }
        warm.push_back((key.clone(), created, input));
    }
    let expires_key = key.clone();
    tokio::spawn(async move {
        tokio::time::sleep(PRELOAD_TTL).await;
        WARM.lock()
            .unwrap()
            .ready
            .retain(|(stored, at, _)| *stored != expires_key || *at != created);
    });
    let native_key = key.clone();
    webview
        .with_webview(move |view| {
            if is_ready_candidate(&native_key, created) {
                unsafe {
                    hg_player_preload(view.inner(), path.as_ptr(), local);
                }
            }
        })
        .map_err(|_| "播放器窗口不可用")?;
    // Native open can already take the prepared gateway while its optional
    // media request runs. Only a request for that exact segment can join it.
    drop(pending);
    if let Some(gateway) = gateway {
        if prefetch_segment == Some(true) {
            gateway.prefetch_first_segment().await;
        }
        if let (Some(owner), Some(path)) = (standby_owner, standby_path) {
            webview
                .with_webview(move |view| {
                    if is_ready_candidate(&key, created)
                        && app.state::<Sessions>().is_current(owner)
                    {
                        unsafe {
                            hg_player_prepare_standby(view.inner(), owner, path.as_ptr());
                        }
                    }
                })
                .map_err(|_| "播放器窗口不可用")?;
        }
    }
    Ok(())
}

fn is_ready_candidate(key: &WarmKey, created: Instant) -> bool {
    key.matches_current_scope()
        && WARM
            .lock()
            .unwrap()
            .ready
            .iter()
            .any(|(stored, at, _)| stored == key && *at == created && at.elapsed() < PRELOAD_TTL)
}
