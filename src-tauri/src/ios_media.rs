use crate::{media, net, network_policy, offline, watch};
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{
    body::{Frame, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use std::{
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, Notify},
    task::{AbortHandle, JoinSet},
};
use uuid::Uuid;

type Body = UnsyncBoxBody<Bytes, std::io::Error>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsMediaResponseTiming {
    request_ms: u128,
    bytes: usize,
    streamed: bool,
    watch: Option<watch::ServeTiming>,
}

pub(crate) type HlsMediaTiming = Arc<OnceLock<HlsMediaResponseTiming>>;

#[derive(Default)]
struct PlaybackSession {
    token: u64,
    active: bool,
    task: Option<AbortHandle>,
    reader: Option<offline::ReadLease>,
    retiring: Vec<offline::ReadLease>,
    media_timing: Option<HlsMediaTiming>,
}
#[derive(Default)]
pub struct Sessions(Mutex<PlaybackSession>);
impl Sessions {
    pub fn reserve(&self, token: u64) -> bool {
        let mut session = self.0.lock().unwrap();
        if token <= session.token {
            return false;
        }
        if let Some(task) = session.task.take() {
            task.abort();
        }
        // The previous AVPlayer still exists until the main-thread replacement/close completes.
        if let Some(reader) = session.reader.take() {
            session.retiring.push(reader);
        }
        session.media_timing = None;
        session.token = token;
        session.active = true;
        true
    }
    pub fn active_token(&self) -> Option<u64> {
        let session = self.0.lock().unwrap();
        session.active.then_some(session.token)
    }
    pub fn is_current(&self, token: u64) -> bool {
        let session = self.0.lock().unwrap();
        session.active && session.token == token
    }
    pub fn keep(
        &self,
        token: u64,
        task: Option<AbortHandle>,
        reader: Option<offline::ReadLease>,
        media_timing: Option<HlsMediaTiming>,
    ) -> bool {
        let mut session = self.0.lock().unwrap();
        if session.token != token || !session.active {
            if let Some(task) = task {
                task.abort();
            }
            return false;
        }
        session.task = task;
        session.reader = reader;
        session.media_timing = media_timing;
        true
    }
    pub(crate) fn take_first_hls_media_response(
        &self,
        token: u64,
    ) -> Option<HlsMediaResponseTiming> {
        let mut session = self.0.lock().unwrap();
        if session.token != token || !session.active {
            return None;
        }
        let timing = session.media_timing.as_ref()?.get()?.clone();
        session.media_timing = None;
        Some(timing)
    }

    pub fn opened(&self, token: u64) {
        let mut session = self.0.lock().unwrap();
        if session.token == token && session.active {
            session.retiring.clear();
        }
    }
    pub fn close(&self, token: u64) {
        let mut session = self.0.lock().unwrap();
        if token >= session.token {
            session.token = token;
            session.active = false;
            if let Some(task) = session.task.take() {
                task.abort();
            }
            session.media_timing.take();
            session.reader.take();
            session.retiring.clear();
        }
    }
}

pub enum Source {
    Offline { id: i64, ep: u32 },
    Online { url: String, watch_key: Option<u64> },
}

enum Media {
    Offline {
        id: i64,
        ep: u32,
    },
    Hls {
        root: String,
        watch_key: Option<u64>,
    },
    File(String),
}

#[derive(Clone, Serialize)]
pub struct Level {
    index: usize,
    height: u32,
    bitrate: u32,
}

struct Manifest {
    text: String,
    variants: Vec<(usize, usize, Level)>,
}

impl Manifest {
    fn new(text: String) -> Self {
        let lines: Vec<_> = text.lines().collect();
        let mut variants = Vec::new();
        for (line, tag) in lines.iter().enumerate() {
            if !tag.starts_with("#EXT-X-STREAM-INF:") {
                continue;
            }
            let Some((_, attrs)) = media::hls_attributes(tag) else {
                continue;
            };
            let Some((uri, _)) = lines
                .iter()
                .enumerate()
                .skip(line + 1)
                .find(|(_, entry)| !entry.is_empty() && !entry.starts_with('#'))
            else {
                continue;
            };
            if lines[line + 1..uri]
                .iter()
                .any(|entry| entry.starts_with("#EXT-X-STREAM-INF:"))
            {
                continue;
            }
            let value = |key| attrs.iter().find_map(|item| item.strip_prefix(key));
            let height = value("RESOLUTION=")
                .and_then(|res| res.split_once('x'))
                .and_then(|(_, height)| height.parse().ok())
                .unwrap_or(0);
            let bitrate = value("BANDWIDTH=")
                .and_then(|rate| rate.parse().ok())
                .unwrap_or(0);
            variants.push((
                line,
                uri,
                Level {
                    index: variants.len(),
                    height,
                    bitrate,
                },
            ));
        }
        Self { text, variants }
    }

    fn render(&self, index: Option<usize>) -> Option<String> {
        let Some(index) = index else {
            return Some(self.text.clone());
        };
        self.variants.get(index)?;
        let mut excluded = self
            .variants
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .flat_map(|(_, (tag, uri, _))| [*tag, *uri])
            .collect::<Vec<_>>();
        excluded.sort_unstable();
        Some(
            self.text
                .lines()
                .enumerate()
                .filter(|(line, text)| {
                    excluded.binary_search(line).is_err()
                        && !text.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                })
                .map(|(_, text)| text)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
    }
}

const PREFETCH_LIMIT: usize = 4 * 1024 * 1024;
const PREFETCH_TIMEOUT: Duration = Duration::from_secs(3);
const PREFETCH_JOIN_BUDGET: Duration = Duration::from_millis(120);
const PREFETCH_TTL: Duration = Duration::from_secs(30);
static SEGMENT_PREFETCH: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

struct SegmentPrefetch {
    url: String,
    body: Arc<AsyncMutex<Option<watch::PrefetchedMedia>>>,
    cancel: Arc<Notify>,
}

pub(crate) struct Gateway {
    app: tauri::AppHandle,
    capability: String,
    base: String,
    media: Media,
    manifest: Option<Manifest>,
    _offline_lease: Option<offline::ReadLease>,
    media_timing: Option<HlsMediaTiming>,
    prefetched_segment: OnceLock<SegmentPrefetch>,
}

fn body(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn error(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(body(Bytes::new()))
        .unwrap()
}

fn buffered(response: Response<Vec<u8>>, head: bool) -> Response<Body> {
    let (mut parts, data) = response.into_parts();
    parts
        .headers
        .entry(header::CONTENT_LENGTH)
        .or_insert_with(|| data.len().into());
    Response::from_parts(parts, body(if head { Vec::new() } else { data }))
}

async fn remote_playlist(url: &str, watch_key: Option<u64>, origin: &str) -> Response<Vec<u8>> {
    fetch_hls_resource(url, watch_key, origin, None, None).await
}

async fn fetch_hls_resource(
    url: &str,
    watch_key: Option<u64>,
    origin: &str,
    timing: Option<&mut watch::ServeTiming>,
    prefetched: Option<watch::PrefetchedMedia>,
) -> Response<Vec<u8>> {
    let query = format!("u={}", media::enc(url));
    if let Some(key) = watch_key {
        watch::serve_with_timing(
            &format!("/watch/{key}/seg"),
            &query,
            origin,
            timing,
            prefetched,
        )
        .await
    } else {
        media::handle("/seg", &query, origin).await
    }
}

async fn progressive(url: &str, range: Option<&str>, head: bool) -> Response<Body> {
    let referer = format!("{}/", net::base());
    let Ok(response) = net::get_playback_stream(url, &referer, range).await else {
        return error(StatusCode::BAD_GATEWAY);
    };
    if !response.status().is_success() && response.status() != StatusCode::RANGE_NOT_SATISFIABLE {
        return error(StatusCode::BAD_GATEWAY);
    }
    let mut builder = Response::builder().status(response.status());
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = response.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    let data = if head {
        body(Bytes::new())
    } else {
        let stream = futures_util::stream::unfold(Some(response), |state| async move {
            let mut response = state?;
            match response.chunk().await {
                Ok(Some(chunk)) => Some((Ok(Frame::data(chunk)), Some(response))),
                Ok(None) => None,
                Err(err) => Some((Err(std::io::Error::other(err)), None)),
            }
        });
        StreamBody::new(stream).boxed_unsync()
    };
    builder.body(data).unwrap()
}

async fn is_progressive(url: &url::Url) -> Result<bool, String> {
    let path = url.path().to_ascii_lowercase();
    if [".mp4", ".m4v", ".mov"]
        .iter()
        .any(|ext| path.ends_with(ext))
    {
        return Ok(true);
    }
    if path.ends_with(".m3u8") {
        return Ok(false);
    }
    // Some CDN endpoints omit a file extension. Inspect headers and the first
    // chunk without reading an entire progressive video into memory.
    let referer = format!("{}/", net::base());
    let mut response = net::get_playback_stream(url.as_str(), &referer, None).await?;
    if !response.status().is_success() {
        return Err("视频地址暂时不可用".into());
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("mpegurl") {
        return Ok(false);
    }
    if content_type.starts_with("video/mp4") || content_type.starts_with("video/quicktime") {
        return Ok(true);
    }
    let first = response.chunk().await.map_err(|_| "无法读取视频类型")?;
    Ok(first.is_some_and(|chunk| chunk.get(4..8) == Some(b"ftyp")))
}

// A segment is eligible only when the media playlist names a standalone
// resource and has a fixed end. An absent match is a normal cold open.
fn first_segment_uri(playlist: &str) -> Option<&str> {
    if !playlist.lines().any(|line| line.trim() == "#EXT-X-ENDLIST") {
        return None;
    }
    let mut starts_segment = false;
    for line in playlist.lines().map(str::trim) {
        if line.starts_with("#EXT-X-BYTERANGE:") {
            return None;
        }
        if line.starts_with("#EXTINF:") {
            starts_segment = true;
        } else if !line.is_empty() && !line.starts_with('#') {
            return starts_segment.then_some(line);
        }
    }
    None
}

impl Gateway {
    fn watch_target(&self, key: u64, entry: &str) -> Option<String> {
        let prefix = format!("{}/watch/{key}/seg?", self.base);
        let raw = media::target_from_query(entry.strip_prefix(&prefix)?);
        network_policy::parse_target(&raw)
            .ok()
            .map(|url| url.to_string())
    }

    pub(crate) async fn prefetch_first_segment(&self) {
        let (
            Media::Hls {
                watch_key: Some(key),
                ..
            },
            Some(manifest),
        ) = (&self.media, &self.manifest)
        else {
            return;
        };
        let Ok(_permit) = SEGMENT_PREFETCH.try_acquire() else {
            return;
        };
        let _ = tokio::time::timeout(PREFETCH_TIMEOUT, async {
            let key = *key;
            let Some(source) = watch::source(key) else {
                return;
            };
            // Try the first advertised rendition. Leave rendition selection to AVPlayer.
            let child;
            let playlist = if let Some((_, uri, _)) = manifest.variants.first() {
                let Some(url) = manifest
                    .text
                    .lines()
                    .nth(*uri)
                    .and_then(|uri| self.watch_target(key, uri))
                else {
                    return;
                };
                let response = remote_playlist(&url, Some(key), &self.base).await;
                if !response.status().is_success() {
                    return;
                }
                let Ok(text) = String::from_utf8(response.into_body()) else {
                    return;
                };
                child = text;
                &child
            } else {
                &manifest.text
            };
            let Some(url) = first_segment_uri(playlist).and_then(|uri| self.watch_target(key, uri))
            else {
                return;
            };
            if watch::source(key).is_none() || watch::is_recorded(key, &url) {
                return;
            }
            let body = Arc::new(AsyncMutex::new(None));
            let mut result = body.lock().await;
            let cancel = Arc::new(Notify::new());
            if self
                .prefetched_segment
                .set(SegmentPrefetch {
                    url: url.clone(),
                    body: body.clone(),
                    cancel: cancel.clone(),
                })
                .is_err()
            {
                return;
            }
            let fetched = tokio::select! {
                biased;
                _ = cancel.notified() => return,
                result = net::fetch_media_bounded(&url, &source.origin, PREFETCH_LIMIT) => result,
            };
            if let Ok((kind, bytes, final_url, true)) = fetched {
                if !bytes.is_empty() && watch::source(key).is_some() {
                    *result = Some((kind, bytes, final_url));
                    let unused = Arc::downgrade(&body);
                    tokio::spawn(async move {
                        tokio::time::sleep(PREFETCH_TTL).await;
                        if let Some(body) = unused.upgrade() {
                            body.lock().await.take();
                        }
                    });
                }
            }
        })
        .await;
    }

    async fn hls_resource(
        &self,
        url: &str,
        watch_key: Option<u64>,
        head: bool,
        full_get: bool,
    ) -> Response<Body> {
        let pending = self
            .media_timing
            .as_ref()
            .filter(|timing| !head && timing.get().is_none());
        let started = pending.map(|_| Instant::now());
        let mut watch = pending
            .and(watch_key)
            .map(|_| watch::ServeTiming::default());
        let prefetched = match self.prefetched_segment.get() {
            Some(prefetch) if !head && prefetch.url == url => {
                match tokio::time::timeout(PREFETCH_JOIN_BUDGET, prefetch.body.lock()).await {
                    Ok(mut body) => body.take(),
                    Err(_) => {
                        prefetch.cancel.notify_one();
                        None
                    }
                }
            }
            _ => None,
        };
        // Stream only the startup resource. Later requests keep the established
        // buffered path, including byte-range and playlist rewriting behavior.
        let mut early_response = None;
        if full_get && pending.is_some() && prefetched.is_none() {
            if let Some(key) = watch_key {
                let stream = match watch::open_streamed_ts(key, url).await {
                    Ok(stream) => stream,
                    // The shared network retries have already been spent.
                    Err(_) => return error(StatusCode::BAD_GATEWAY),
                };
                if let Some(stream) = stream {
                    if let Some(bytes) = stream.streamable_length() {
                        let pending = pending.cloned();
                        let chunks = stream.chunks(bytes, move |watch| {
                            if let (Some(timing), Some(started)) = (pending, started) {
                                let _ = timing.set(HlsMediaResponseTiming {
                                    request_ms: started.elapsed().as_millis(),
                                    bytes,
                                    streamed: true,
                                    watch: Some(watch),
                                });
                            }
                        });
                        return Response::builder()
                            .header(header::CONTENT_TYPE, "video/mp2t")
                            .header(header::CONTENT_LENGTH, bytes)
                            .header(header::CACHE_CONTROL, "public, max-age=3600")
                            .header("X-Content-Type-Options", "nosniff")
                            .body(StreamBody::new(chunks.map_ok(Frame::data)).boxed_unsync())
                            .unwrap();
                    }
                    let Some((response, timing)) = stream.finish_buffered(&self.base).await else {
                        return error(StatusCode::BAD_GATEWAY);
                    };
                    early_response = Some(response);
                    watch = Some(timing);
                }
            }
        }
        let response = match early_response {
            Some(response) => response,
            None => {
                fetch_hls_resource(url, watch_key, &self.base, watch.as_mut(), prefetched).await
            }
        };
        if let (Some(timing), Some(started)) = (pending, started) {
            if response.status().is_success() && is_hls_media(&response, url) {
                let _ = timing.set(HlsMediaResponseTiming {
                    request_ms: started.elapsed().as_millis(),
                    bytes: response.body().len(),
                    streamed: false,
                    watch,
                });
            }
        }
        buffered(response, head)
    }

    async fn handle(&self, request: Request<Incoming>) -> Result<Response<Body>, Infallible> {
        let head = request.method() == Method::HEAD;
        if request.method() != Method::GET && !head {
            return Ok(error(StatusCode::METHOD_NOT_ALLOWED));
        }
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| {
                value.len() < 64 && value.starts_with("bytes=") && !value.contains(',')
            });
        let Some(path) = request.uri().path().strip_prefix(&self.capability) else {
            return Ok(error(StatusCode::NOT_FOUND));
        };
        let query = request.uri().query().unwrap_or("");
        let response = match (&self.media, path) {
            (Media::Offline { id, ep }, path) if path.starts_with('/') => {
                let name = &path[1..];
                if name != "index.m3u8"
                    && !name.split_once('.').is_some_and(|(n, ext)| {
                        n.parse::<u32>().is_ok() && matches!(ext, "ts" | "mp4")
                    })
                {
                    return Ok(error(StatusCode::NOT_FOUND));
                }
                buffered(
                    offline::serve(
                        &self.app.state(),
                        &format!("/offline/{id}/{ep}/{name}"),
                        range,
                    )
                    .await,
                    head,
                )
            }
            (Media::File(url), "/video.mp4") => progressive(url, range, head).await,
            (Media::Hls { root, watch_key }, "/master.m3u8") => {
                if let Some(manifest) = &self.manifest {
                    let level = query
                        .strip_prefix("level=")
                        .and_then(|level| level.parse().ok());
                    if let Some(text) = manifest.render(level) {
                        buffered(
                            media::respond(
                                200,
                                "application/vnd.apple.mpegurl",
                                text.into_bytes(),
                                "no-store",
                            ),
                            head,
                        )
                    } else {
                        error(StatusCode::NOT_FOUND)
                    }
                } else {
                    buffered(remote_playlist(root, *watch_key, &self.base).await, head)
                }
            }
            (Media::Hls { watch_key, .. }, child) => {
                let allowed =
                    watch_key.map_or_else(|| "/seg".into(), |key| format!("/watch/{key}/seg"));
                if child != allowed {
                    return Ok(error(StatusCode::NOT_FOUND));
                }
                let url = media::target_from_query(query);
                // AVPlayer uses ranges for shared fMP4 files. Independent TS
                // resources still use the existing watch cache and capture path.
                let ranged_mp4 = range.filter(|value| *value != "bytes=0-").filter(|_| {
                    url::Url::parse(&url).ok().is_some_and(|u| {
                        let path = u.path().to_ascii_lowercase();
                        path.ends_with(".mp4") || path.ends_with(".m4s")
                    })
                });
                let full_get =
                    !request.headers().contains_key(header::RANGE) || range == Some("bytes=0-");
                if ranged_mp4.is_some() {
                    progressive(&url, ranged_mp4, head).await
                } else {
                    self.hls_resource(&url, *watch_key, head, full_get).await
                }
            }
            _ => error(StatusCode::NOT_FOUND),
        };
        Ok(response)
    }
}

// Use an allowlist so child playlists, keys, and unidentified binary responses
// do not get reported as media. MP4 initialization resources may qualify.
fn is_hls_media(response: &Response<Vec<u8>>, url: &str) -> bool {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if response.body().is_empty() || content_type.contains("mpegurl") {
        return false;
    }
    if content_type.starts_with("video/") || content_type.starts_with("audio/") {
        return true;
    }
    matches!(
        content_type.split(';').next(),
        Some("application/octet-stream" | "binary/octet-stream" | "")
    ) && url::Url::parse(url).ok().is_some_and(|url| {
        [".ts", ".m4s", ".mp4", ".aac"]
            .iter()
            .any(|ext| url.path().to_ascii_lowercase().ends_with(ext))
    })
}

pub struct Prepared {
    pub manifest_ms: Option<u128>,
    pub(crate) media_timing: Option<HlsMediaTiming>,
    pub(crate) prefetch_gateway: Option<Arc<Gateway>>,
    pub url: String,
    pub levels: Vec<Level>,
    pub task: AbortHandle,
}

pub async fn prepare(app: tauri::AppHandle, source: Source) -> Result<Prepared, String> {
    let offline_lease = match &source {
        Source::Offline { id, ep } => Some(app.state::<offline::Cache>().open_episode(*id, *ep)?.1),
        _ => None,
    };
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "本机媒体服务启动失败")?;
    let capability = format!("/{}", Uuid::new_v4().simple());
    let base = format!(
        "http://127.0.0.1:{}{capability}",
        listener
            .local_addr()
            .map_err(|_| "本机媒体服务地址不可用")?
            .port()
    );
    let (media, entry) = match source {
        Source::Offline { id, ep } => (Media::Offline { id, ep }, "index.m3u8"),
        Source::Online { url, watch_key } => {
            let parsed = network_policy::parse_target(&url)?;
            if is_progressive(&parsed).await? {
                (Media::File(parsed.to_string()), "video.mp4")
            } else {
                let url = parsed.to_string();
                let watch_key = watch_key
                    .filter(|key| watch::source(*key).is_some_and(|source| source.url == url));
                (
                    Media::Hls {
                        root: url,
                        watch_key,
                    },
                    "master.m3u8",
                )
            }
        }
    };
    let (manifest, manifest_ms) = if let Media::Hls { root, watch_key } = &media {
        let started = Instant::now();
        let response = remote_playlist(root, *watch_key, &base).await;
        if !response.status().is_success() {
            return Err("无法读取视频播放列表".into());
        }
        let text = String::from_utf8(response.into_body()).map_err(|_| "视频播放列表无效")?;
        if !text.starts_with("#EXTM3U") {
            return Err("片源未提供可播放的 HLS 列表".into());
        }
        (
            Some(Manifest::new(text)),
            Some(started.elapsed().as_millis()),
        )
    } else {
        (None, None)
    };
    let levels = manifest
        .as_ref()
        .map(|m| {
            m.variants
                .iter()
                .map(|(_, _, level)| level.clone())
                .collect()
        })
        .unwrap_or_default();
    let url = format!("{base}/{entry}");
    let media_timing = matches!(&media, Media::Hls { .. }).then(|| Arc::new(OnceLock::new()));
    let gateway = Arc::new(Gateway {
        app,
        capability,
        base,
        media,
        manifest,
        _offline_lease: offline_lease,
        media_timing: media_timing.clone(),
        prefetched_segment: OnceLock::new(),
    });
    let prefetch_gateway = media_timing.as_ref().map(|_| gateway.clone());
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = connections.join_next(), if !connections.is_empty() => {}
                accepted = listener.accept(), if connections.len() < 16 => {
                    let Ok((socket, _)) = accepted else { break; };
                    let gateway = gateway.clone();
                    connections.spawn(async move {
                        let _ = http1::Builder::new().timer(TokioTimer::new())
                            .header_read_timeout(Duration::from_secs(10))
                            .serve_connection(TokioIo::new(socket), service_fn(move |request| {
                                let gateway = gateway.clone();
                                async move { gateway.handle(request).await }
                            })).await;
                    });
                }
            }
        }
    })
    .abort_handle();
    Ok(Prepared {
        url,
        levels,
        task,
        manifest_ms,
        media_timing,
        prefetch_gateway,
    })
}
