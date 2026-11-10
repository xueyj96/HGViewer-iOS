use crate::{media, net, network_policy, offline, watch};
use bytes::Bytes;
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
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tokio::{
    net::TcpListener,
    task::{AbortHandle, JoinSet},
};
use uuid::Uuid;

type Body = UnsyncBoxBody<Bytes, reqwest::Error>;

#[derive(Default)]
pub struct Sessions(Mutex<(u64, bool, Option<AbortHandle>)>);

impl Sessions {
    pub fn reserve(&self, token: u64) -> bool {
        let mut session = self.0.lock().unwrap();
        if token <= session.0 {
            return false;
        }
        if let Some(task) = session.2.take() {
            task.abort();
        }
        session.0 = token;
        session.1 = true;
        true
    }

    pub fn keep(&self, token: u64, task: AbortHandle) -> bool {
        let mut session = self.0.lock().unwrap();
        if session.0 != token || !session.1 {
            task.abort();
            return false;
        }
        session.2 = Some(task);
        true
    }

    pub fn close(&self, token: u64) {
        let mut session = self.0.lock().unwrap();
        if token >= session.0 {
            session.0 = token;
            session.1 = false;
            if let Some(task) = session.2.take() {
                task.abort();
            }
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

struct Gateway {
    app: tauri::AppHandle,
    capability: String,
    base: String,
    media: Media,
    manifest: Option<Manifest>,
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
    let query = format!("u={}", media::enc(url));
    if let Some(key) = watch_key {
        watch::serve(&format!("/watch/{key}/seg"), &query, origin).await
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
                Err(err) => Some((Err(err), None)),
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

impl Gateway {
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
                if ranged_mp4.is_some() {
                    progressive(&url, ranged_mp4, head).await
                } else {
                    buffered(remote_playlist(&url, *watch_key, &self.base).await, head)
                }
            }
            _ => error(StatusCode::NOT_FOUND),
        };
        Ok(response)
    }
}

pub struct Prepared {
    pub url: String,
    pub levels: Vec<Level>,
    pub task: AbortHandle,
}

pub async fn prepare(app: tauri::AppHandle, source: Source) -> Result<Prepared, String> {
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
    let manifest = if let Media::Hls { root, watch_key } = &media {
        let response = remote_playlist(root, *watch_key, &base).await;
        if !response.status().is_success() {
            return Err("无法读取视频播放列表".into());
        }
        let text = String::from_utf8(response.into_body()).map_err(|_| "视频播放列表无效")?;
        if !text.starts_with("#EXTM3U") {
            return Err("片源未提供可播放的 HLS 列表".into());
        }
        Some(Manifest::new(text))
    } else {
        None
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
    let gateway = Arc::new(Gateway {
        app,
        capability,
        base,
        media,
        manifest,
    });
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
    Ok(Prepared { url, levels, task })
}
