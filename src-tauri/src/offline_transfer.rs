use super::{check_job, storage_error, Capture, Job};
use crate::{media, net, network_policy, watch};
use aes::{
    cipher::{Block, BlockEncrypt, KeyInit},
    Aes128,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use md5::Md5;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex, time::Duration};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
};

const SEG_LIMIT: u64 = 16 * 1024 * 1024;
const PLAYLIST_LIMIT: u64 = 512 * 1024;
pub(super) const HLS_CHECKPOINT: &str = ".hls-checkpoint";
pub(super) const HLS_ASSETS: &str = ".hls-assets";
pub(super) const HLS_PACKAGE: &str = ".hls-package";
// Limit media buffers even when several shows are downloading together.
static SEGMENT_SLOTS: Semaphore = Semaphore::const_new(8);

#[derive(Clone, Copy)]
pub(super) struct TransferOptions {
    pub capture: Option<Capture>,
    pub segments: usize,
    pub resume_episode: Option<u32>,
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            capture: None,
            segments: super::queue::default_segment_limit(),
            resume_episode: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum MediaKind {
    Hls,
    Mp4,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FailureReason {
    Dns,
    Timeout,
    Connection,
    AddressRejected,
    Http(u16),
    BodyInterrupted,
    ReadStalled,
    MediaInvalid,
    CaptureUnavailable,
    StorageFull,
    StorageWrite,
    Other,
}

#[derive(Debug)]
pub(super) struct TransferFailure {
    pub message: String,
    pub retry_after: Option<Duration>,
    pub reason: FailureReason,
    pub stage: &'static str,
}

impl From<&str> for TransferFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<String> for TransferFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            retry_after: None,
            reason: FailureReason::Other,
            stage: "media",
        }
    }
}

impl TransferFailure {
    pub fn transient(message: &str, delay: Duration) -> Self {
        Self {
            retry_after: Some(delay),
            ..Self::from(message)
        }
    }

    pub fn with_reason(mut self, reason: FailureReason) -> Self {
        self.reason = reason;
        self
    }

    pub fn at(mut self, stage: &'static str) -> Self {
        self.stage = stage;
        self
    }

    pub fn storage(error: std::io::Error) -> Self {
        let reason = if error.kind() == std::io::ErrorKind::StorageFull {
            FailureReason::StorageFull
        } else {
            FailureReason::StorageWrite
        };
        Self::from(storage_error(error))
            .with_reason(reason)
            .at("storage")
    }

    fn connect(reason: String) -> Self {
        let code = match reason.as_str() {
            "DNS 解析超时" | "DNS 解析失败" => FailureReason::Dns,
            "请求超时" => FailureReason::Timeout,
            reason if reason.starts_with("error sending request") => FailureReason::Connection,
            reason if reason.starts_with("禁止访问") => FailureReason::AddressRejected,
            _ => FailureReason::Other,
        };
        if matches!(
            code,
            FailureReason::Dns | FailureReason::Timeout | FailureReason::Connection
        ) {
            net::heal_client(&reason);
            Self::transient("下载超时或连接失败", Duration::ZERO).with_reason(code)
        } else {
            Self::from("无法连接媒体地址，请检查线路").with_reason(code)
        }
    }

    fn status(response: &reqwest::Response) -> Self {
        let status = response.status().as_u16();
        let message = format!("媒体请求失败（HTTP {status}）");
        let mut failure = Self::from(message).with_reason(FailureReason::Http(status));
        if matches!(status, 408 | 429 | 500 | 502 | 503 | 504) {
            let requested = response.headers().get(reqwest::header::RETRY_AFTER);
            let seconds = requested
                .and_then(|header| header.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            failure.retry_after = match (requested, seconds) {
                (_, Some(seconds)) if seconds <= 5 => Some(Duration::from_secs(seconds)),
                (None, None) if status == 429 => Some(Duration::from_secs(1)),
                (None, None) => Some(Duration::ZERO),
                _ => None,
            };
        }
        failure
    }
}

impl TransferFailure {
    pub fn with_context(mut self, context: &str) -> Self {
        self.message = format!("{context}{}", self.message);
        self
    }
}

pub(super) async fn wait_to_retry(job: &Mutex<Job>, delay: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + delay;
    while tokio::time::Instant::now() < deadline {
        check_job(job)?;
        let next = (tokio::time::Instant::now() + Duration::from_millis(150)).min(deadline);
        tokio::time::sleep_until(next).await;
    }
    check_job(job)
}

async fn retry_transfer<T, F, Fut>(job: &Mutex<Job>, mut transfer: F) -> Result<T, TransferFailure>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, TransferFailure>>,
{
    for attempt in 0..3 {
        check_job(job)?;
        match transfer().await {
            Ok(value) => return Ok(value),
            Err(error) => match error.retry_after {
                Some(delay) if attempt < 2 => {
                    {
                        let mut progress = job.lock().unwrap();
                        progress.resource_retries += 1;
                        progress.resource_retry_reason = Some(error.reason);
                    }
                    let backoff = Duration::from_millis(if attempt == 0 { 350 } else { 900 });
                    wait_to_retry(job, delay.max(backoff)).await?;
                }
                _ => return Err(error),
            },
        }
    }
    unreachable!("each transfer finishes or reports its final attempt")
}

async fn download_response(
    job: &Mutex<Job>,
    url: &str,
    origin: &str,
    limit: u64,
    capture: Option<Capture>,
) -> Result<(Vec<u8>, url::Url), TransferFailure> {
    check_job(job)?;
    if let Some(capture) = capture {
        if let Some((_, bytes, final_url)) = watch::read(capture.key, url).await {
            if bytes.len() as u64 <= limit {
                return Ok((bytes, final_url));
            }
        }
        if !capture.fill {
            return Err(TransferFailure::from(watch::MISSING)
                .with_reason(FailureReason::CaptureUnavailable));
        }
    }
    let referer = format!("{origin}/");
    retry_transfer(job, || async {
        let mut response = net::get_stream(url, &referer)
            .await
            .map_err(TransferFailure::connect)?;
        if response.status() != 200 {
            return Err(TransferFailure::status(&response));
        }
        if response.content_length().is_some_and(|len| len > limit) {
            return Err("媒体分片或清单过大".into());
        }
        let mut data = Vec::new();
        let max_read = Duration::from_secs(if limit == SEG_LIMIT { 180 } else { 20 });
        let deadline = tokio::time::Instant::now() + max_read;
        loop {
            let chunk = tokio::time::timeout_at(deadline, response.chunk())
                .await
                .map_err(|_| {
                    TransferFailure::transient("媒体下载超时", Duration::ZERO)
                        .with_reason(FailureReason::Timeout)
                })?
                .map_err(|error| {
                    TransferFailure::transient("媒体下载中断", Duration::ZERO).with_reason(
                        if error.is_timeout() {
                            FailureReason::ReadStalled
                        } else {
                            FailureReason::BodyInterrupted
                        },
                    )
                })?;
            let Some(chunk) = chunk else { break };
            check_job(job)?;
            if data.len() as u64 + chunk.len() as u64 > limit {
                return Err("媒体分片或清单过大".into());
            }
            job.lock().unwrap().record_network_bytes(chunk.len());
            data.extend_from_slice(&chunk);
        }
        Ok((data, response.url().clone()))
    })
    .await
}

async fn download(
    job: &Mutex<Job>,
    url: &str,
    origin: &str,
    limit: u64,
    capture: Option<Capture>,
) -> Result<Vec<u8>, TransferFailure> {
    Ok(download_response(job, url, origin, limit, capture).await?.0)
}

pub(super) async fn save_mp4(
    job: &Mutex<Job>,
    path: &Path,
    url: &str,
    origin: &str,
) -> Result<u64, TransferFailure> {
    retry_transfer(job, || save_mp4_attempt(job, path, url, origin))
        .await
        .map_err(|error| {
            if error.stage == "media" {
                error.at("mp4")
            } else {
                error
            }
        })
}

async fn save_mp4_attempt(
    job: &Mutex<Job>,
    path: &Path,
    url: &str,
    origin: &str,
) -> Result<u64, TransferFailure> {
    let mut response = net::get_stream(url, &format!("{origin}/"))
        .await
        .map_err(TransferFailure::connect)?;
    if response.status() != 200 {
        return Err(TransferFailure::status(&response));
    }
    let mut file = fs::File::create(path)
        .await
        .map_err(TransferFailure::storage)?;
    {
        let mut progress = job.lock().unwrap();
        progress.begin_transfer(response.content_length().unwrap_or(0), 512 * 1024);
    }
    let mut prefix = Vec::with_capacity(8);
    let mut bytes = 0u64;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(20), response.chunk())
        .await
        .map_err(|_| {
            TransferFailure::transient("媒体下载超时", Duration::ZERO)
                .with_reason(FailureReason::Timeout)
        })?
        .map_err(|_| {
            TransferFailure::transient("媒体下载中断", Duration::ZERO)
                .with_reason(FailureReason::BodyInterrupted)
        })?
    {
        check_job(job)?;
        job.lock().unwrap().record_network_bytes(chunk.len());
        if prefix.len() < 8 {
            let remaining = 8 - prefix.len();
            prefix.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
            if prefix.len() == 8 && prefix.get(4..8) != Some(b"ftyp") {
                return Err(TransferFailure::from("视频文件格式异常")
                    .with_reason(FailureReason::MediaInvalid));
            }
        }
        file.write_all(&chunk)
            .await
            .map_err(TransferFailure::storage)?;
        bytes += chunk.len() as u64;
        job.lock()
            .unwrap()
            .advance_transfer(chunk.len() as u64, chunk.len() as u64, false);
    }
    if prefix.len() < 8 {
        return Err(
            TransferFailure::from("视频文件格式异常").with_reason(FailureReason::MediaInvalid)
        );
    }
    file.flush().await.map_err(TransferFailure::storage)?;
    Ok(bytes)
}

fn resolve(base: &url::Url, value: &str) -> Result<url::Url, String> {
    network_policy::redirect_target(base, value).map_err(|_| "媒体链接无效".to_string())
}

fn attr(line: &str, name: &str) -> Option<String> {
    media::hls_attributes(line)?
        .1
        .into_iter()
        .find_map(|attribute| {
            let (key, value) = attribute.split_once('=')?;
            (key.trim() == name).then(|| value.trim().trim_matches('"').to_owned())
        })
}

pub(super) fn best_variant(raw: &str, base: &url::Url, watch_key: Option<u64>) -> Option<url::Url> {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .zip(raw.lines().filter(|line| !line.trim().is_empty()).skip(1))
        .filter_map(|(tag, url)| {
            let url = url.trim();
            if !tag.starts_with("#EXT-X-STREAM-INF:")
                || attr(tag, "AUDIO").is_some()
                || url.is_empty()
                || url.starts_with('#')
            {
                return None;
            }
            let variant = resolve(base, url).ok()?;
            let pixels = attr(tag, "RESOLUTION")
                .and_then(|resolution| {
                    let (width, height) = resolution.split_once('x')?;
                    width
                        .parse::<u64>()
                        .ok()?
                        .checked_mul(height.parse::<u64>().ok()?)
                })
                .unwrap_or(0);
            let bitrate = attr(tag, "AVERAGE-BANDWIDTH")
                .or_else(|| attr(tag, "BANDWIDTH"))
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            let available = watch_key.map_or(0, |key| watch::playlist_score(key, variant.as_str()));
            Some(((pixels, bitrate, available), variant))
        })
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, url)| url)
}

#[derive(Clone)]
struct Encryption {
    key: Vec<u8>,
    iv: Option<[u8; 16]>,
}

pub(super) async fn save_video(
    job: &Mutex<Job>,
    stage: &Path,
    url: &str,
    origin: &str,
    options: TransferOptions,
) -> Result<(u64, bool), TransferFailure> {
    let capture = options.capture;
    let mut base = network_policy::parse_target(url).map_err(|_| "播放地址无效")?;
    let mp4 = base.path().to_ascii_lowercase().ends_with(".mp4");
    job.lock().unwrap().media_kind = Some(if mp4 { MediaKind::Mp4 } else { MediaKind::Hls });
    if mp4 {
        let package = if options.resume_episode.is_some() {
            let package = stage.join(HLS_PACKAGE);
            reset_stage(&package).await?;
            package
        } else {
            stage.to_owned()
        };
        let bytes = save_mp4(job, &package.join("video.mp4"), base.as_str(), origin).await?;
        return Ok((bytes, true));
    }
    let (mut playlist, final_url) =
        download_response(job, base.as_str(), origin, PLAYLIST_LIMIT, capture)
            .await
            .map_err(|error| error.at("hls_playlist"))?;
    base = final_url;
    let raw = std::str::from_utf8(&playlist).map_err(|_| "播放列表格式异常")?;
    if raw
        .lines()
        .any(|line| line.starts_with("#EXT-X-STREAM-INF:"))
    {
        base = best_variant(raw, &base, capture.map(|item| item.key))
            .ok_or("暂不支持独立音轨的离线视频")?;
        (playlist, base) = download_response(job, base.as_str(), origin, PLAYLIST_LIMIT, capture)
            .await
            .map_err(|error| error.at("hls_playlist"))?;
    }
    let raw = std::str::from_utf8(&playlist)
        .map_err(|_| "播放列表格式异常")?
        .trim_start_matches('\u{feff}');
    if !raw.starts_with("#EXTM3U") || !raw.lines().any(|line| line.trim() == "#EXT-X-ENDLIST") {
        return Err("只支持完整的点播视频".into());
    }
    let mut lines = Vec::new();
    let mut sequence = 0u64;
    let mut encryption: Option<Encryption> = None;
    let mut assets = Vec::new();
    let mut segments = 0;
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        check_job(job)?;
        let text = if let Some(number) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = number.parse().map_err(|_| "媒体序号异常")?;
            format!("#EXT-X-MEDIA-SEQUENCE:{sequence}")
        } else if line.starts_with("#EXT-X-KEY:") {
            encryption = match attr(line, "METHOD").as_deref() {
                Some("NONE") => None,
                Some("AES-128")
                    if attr(line, "KEYFORMAT").is_none_or(|value| value == "identity") =>
                {
                    let uri = attr(line, "URI").ok_or("视频密钥地址缺失")?;
                    let key =
                        download(job, resolve(&base, &uri)?.as_str(), origin, 16, capture).await?;
                    if key.len() != 16 {
                        return Err("视频密钥格式异常".into());
                    }
                    let iv = attr(line, "IV").map(|value| parse_iv(&value)).transpose()?;
                    Some(Encryption { key, iv })
                }
                _ => return Err("此视频的加密格式暂不支持缓存".into()),
            };
            continue;
        } else if line.starts_with("#EXT-X-BYTERANGE:") {
            return Err("暂不支持字节范围分片".into());
        } else if !line.starts_with('#') || line.starts_with("#EXT-X-MAP:") {
            let init = line.starts_with("#EXT-X-MAP:");
            if init && attr(line, "BYTERANGE").is_some() {
                return Err("暂不支持字节范围分片".into());
            }
            let uri = if init {
                attr(line, "URI").ok_or("初始化分片地址缺失")?
            } else {
                line.to_owned()
            };
            if init && encryption.as_ref().is_some_and(|key| key.iv.is_none()) {
                return Err("初始化分片缺少加密参数".into());
            }
            assets.push(Asset {
                url: resolve(&base, &uri)?,
                index: assets.len(),
                encryption: encryption.clone(),
                sequence,
                signature: None,
            });
            lines.push(PlaylistLine::Asset {
                init,
                index: assets.len() - 1,
            });
            if !init {
                segments += 1;
                sequence = sequence.saturating_add(1);
            }
            continue;
        } else if let Some(info) = line.strip_prefix("#EXTINF:") {
            let duration = info
                .split(',')
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or("媒体时长格式异常")?;
            format!("#EXTINF:{duration},")
        } else if matches!(
            line,
            "#EXTM3U"
                | "#EXT-X-DISCONTINUITY"
                | "#EXT-X-PLAYLIST-TYPE:VOD"
                | "#EXT-X-ENDLIST"
                | "#EXT-X-INDEPENDENT-SEGMENTS"
        ) {
            line.to_owned()
        } else if let Some((tag, value)) = line.split_once(':') {
            if matches!(
                tag,
                "#EXT-X-VERSION" | "#EXT-X-TARGETDURATION" | "#EXT-X-DISCONTINUITY-SEQUENCE"
            ) {
                let value = value.parse::<u32>().map_err(|_| "播放列表格式异常")?;
                format!("{tag}:{value}")
            } else {
                continue;
            }
        } else {
            continue;
        };
        lines.push(PlaylistLine::Text(text));
    }
    if segments == 0 {
        return Err("没有可缓存的视频分片".into());
    }
    let resumable = options.resume_episode.is_some();
    let asset_root = if resumable {
        stage.join(HLS_ASSETS)
    } else {
        stage.to_owned()
    };
    let mut legacy_matches = false;
    if let Some(ep) = options.resume_episode {
        let legacy = fs::read(stage.join(HLS_CHECKPOINT)).await.ok();
        if let Some(previous) = legacy {
            legacy_matches = previous == checkpoint_signature(ep, origin, &lines, &assets);
            if !legacy_matches {
                job.lock().unwrap().checkpoint_changes += 1;
            }
        }
        fs::create_dir_all(&asset_root)
            .await
            .map_err(TransferFailure::storage)?;
        for line in &lines {
            if let PlaylistLine::Asset { init, index } = line {
                let asset = &mut assets[*index];
                asset.signature = Some(asset_signature(ep, origin, *init, asset));
            }
        }
    }
    let parallelism = options
        .segments
        .clamp(1, super::queue::MAX_SEGMENTS)
        .min(assets.len());
    job.lock().unwrap().begin_transfer(assets.len() as u64, 3);
    let reservation = SEGMENT_SLOTS.acquire_many(parallelism as u32);
    tokio::pin!(reservation);
    let _slots = loop {
        tokio::select! {
            slots = &mut reservation => break slots.map_err(|_| "媒体下载暂不可用")?,
            _ = tokio::time::sleep(Duration::from_millis(250)) => check_job(job)?,
        }
    };
    let mut names = vec![None; assets.len()];
    let checkpoint = resumable.then_some((stage, legacy_matches));
    let asset_root = asset_root.as_path();
    let mut pending = assets.into_iter();
    let load = |asset| load_asset(asset, job, asset_root, origin, options.capture, checkpoint);
    let mut completed = FuturesUnordered::new();
    completed.extend(pending.by_ref().take(parallelism).map(load));
    let mut failure = None;
    let mut drain_deadline = None;
    let mut bytes = 0;
    loop {
        let result = tokio::select! {
            result = completed.next() => result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                check_job(job)?;
                if drain_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                    break;
                }
                continue;
            }
        };
        let Some(result) = result else { break };
        let (index, name, data) = match result {
            Ok(asset) => asset,
            Err(error) => {
                let error = if error.stage == "media" {
                    error.at("hls_asset")
                } else {
                    error
                };
                if !resumable {
                    return Err(error);
                }
                // Drain only this batch, with a bounded grace period for slow
                // siblings. Pause/cancel remains checked every 250 ms.
                failure.get_or_insert(error);
                drain_deadline
                    .get_or_insert_with(|| tokio::time::Instant::now() + Duration::from_secs(20));
                continue;
            }
        };
        let (size, reused, source) = match data {
            AssetData::Reused {
                size,
                source,
                promote,
            } => {
                let source = if let Some(signature) = promote {
                    let destination = asset_root.join(&name);
                    if source != destination {
                        let temp = asset_root.join(format!(".{name}.part"));
                        remove_if_present(&temp).await?;
                        link_staged_asset(&source, &temp).await?;
                        prepare_asset_replacement(asset_root, index, &name).await?;
                        fs::rename(temp, &destination)
                            .await
                            .map_err(TransferFailure::storage)?;
                    }
                    write_atomic(asset_root, &format!("{index}.digest"), &signature).await?;
                    destination
                } else {
                    source
                };
                (size, true, source)
            }
            AssetData::Downloaded { data, signature } => {
                let destination = asset_root.join(&name);
                if let Some(signature) = signature {
                    prepare_asset_replacement(asset_root, index, &name).await?;
                    write_atomic(asset_root, &name, &data).await?;
                    write_atomic(asset_root, &format!("{index}.digest"), &signature).await?;
                } else {
                    write_atomic(asset_root, &name, &data).await?;
                }
                (data.len() as u64, false, destination)
            }
        };
        names[index] = Some((name, source));
        bytes += size;
        job.lock().unwrap().advance_transfer(1, size, reused);
        if failure.is_none() {
            if let Some(asset) = pending.next() {
                completed.push(load(asset));
            }
        }
    }
    check_job(job)?;
    if let Some(error) = failure {
        return Err(error);
    }
    let package = if resumable {
        let package = stage.join(HLS_PACKAGE);
        reset_stage(&package).await?;
        package
    } else {
        stage.to_owned()
    };
    let mut out = String::new();
    for line in lines {
        match line {
            PlaylistLine::Text(line) => out.push_str(&line),
            PlaylistLine::Asset { init, index } => {
                let (name, source) = names[index].as_ref().ok_or("媒体分片不完整")?;
                if resumable {
                    check_job(job)?;
                    link_staged_asset(source, &package.join(name)).await?;
                }
                if init {
                    out.push_str(&format!("#EXT-X-MAP:URI=\"{name}\""));
                } else {
                    out.push_str(name);
                }
            }
        }
        out.push('\n');
    }
    bytes += out.len() as u64;
    fs::write(package.join("index.m3u8"), out)
        .await
        .map_err(TransferFailure::storage)?;
    Ok((bytes, false))
}

enum PlaylistLine {
    Text(String),
    Asset { init: bool, index: usize },
}

async fn reset_stage(stage: &Path) -> Result<(), TransferFailure> {
    if let Err(error) = fs::remove_dir_all(stage).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(TransferFailure::storage(error));
        }
    }
    fs::create_dir_all(stage)
        .await
        .map_err(TransferFailure::storage)
}

// Store only the digest. URL queries can identify different media and must participate
// in the comparison, but the URLs and encryption keys never go on disk.
fn checkpoint_signature(
    ep: u32,
    origin: &str,
    lines: &[PlaylistLine],
    assets: &[Asset],
) -> [u8; 32] {
    fn field(hash: &mut Sha256, data: &[u8]) {
        hash.update((data.len() as u64).to_be_bytes());
        hash.update(data);
    }
    let mut hash = Sha256::new();
    hash.update(b"hg-hls-checkpoint-v1");
    hash.update(ep.to_be_bytes());
    hash.update([u8::from(network_policy::strict_security())]);
    field(&mut hash, origin.as_bytes());
    for line in lines {
        match line {
            PlaylistLine::Text(line) => {
                hash.update([0]);
                field(&mut hash, line.as_bytes());
            }
            PlaylistLine::Asset { init, index } => {
                hash.update([1, u8::from(*init)]);
                let asset = &assets[*index];
                field(&mut hash, asset.url.as_str().as_bytes());
                hash.update(asset.sequence.to_be_bytes());
                if let Some(key) = &asset.encryption {
                    field(&mut hash, &key.key);
                    hash.update(
                        key.iv
                            .unwrap_or_else(|| u128::from(asset.sequence).to_be_bytes()),
                    );
                } else {
                    field(&mut hash, &[]);
                }
            }
        }
    }
    hash.finalize().into()
}

fn asset_signature(ep: u32, origin: &str, init: bool, asset: &Asset) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"hg-hls-asset-v2");
    hash.update(ep.to_be_bytes());
    hash.update(asset.sequence.to_be_bytes());
    hash.update([u8::from(init), u8::from(network_policy::strict_security())]);
    let url = media_identity(&asset.url);
    for value in [origin.as_bytes(), url.as_str().as_bytes()] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value);
    }
    if let Some(key) = &asset.encryption {
        hash.update(&key.key);
        hash.update(
            key.iv
                .unwrap_or_else(|| u128::from(asset.sequence).to_be_bytes()),
        );
    }
    hash.finalize().into()
}

fn media_identity(url: &url::Url) -> url::Url {
    let mut identity = url.clone();
    identity.set_fragment(None);
    let Some(query) = url.query() else {
        return identity;
    };
    let pairs: Vec<_> = query.split('&').collect();
    let value = |name: &str| {
        let mut values = pairs.iter().filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key == name).then_some(value)
        });
        let first = values.next()?;
        values.next().is_none().then_some(first)
    };
    let hex =
        |value: &str, len| value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    let ali = value("auth_key").is_some_and(|value| {
        let parts: Vec<_> = value.split('-').collect();
        matches!(parts.as_slice(), [time, random, "0", signature]
            if time.len() == 10 && time.bytes().all(|b| b.is_ascii_digit())
                && !random.is_empty() && random.bytes().all(|b| b.is_ascii_alphanumeric())
                && hex(signature, 32))
    });
    let tencent =
        value("txSecret").is_some_and(|v| hex(v, 32)) && value("txTime").is_some_and(|v| hex(v, 8));
    let cloudfront = url
        .host_str()
        .is_some_and(|host| host.ends_with(".cloudfront.net"))
        && value("Signature").is_some_and(|v| !v.is_empty())
        && value("Key-Pair-Id").is_some_and(|v| !v.is_empty())
        && (value("Expires")
            .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            || value("Policy").is_some_and(|v| !v.is_empty()));
    if ali || tencent || cloudfront {
        let kept: Vec<_> = pairs
            .into_iter()
            .filter(|pair| {
                let key = pair.split_once('=').map_or(*pair, |(key, _)| key);
                !(ali && key == "auth_key"
                    || tencent && matches!(key, "txSecret" | "txTime")
                    || cloudfront
                        && matches!(
                            key,
                            "Signature" | "Key-Pair-Id" | "Expires" | "Policy" | "Hash-Algorithm"
                        ))
            })
            .collect();
        identity.set_query((!kept.is_empty()).then(|| kept.join("&")).as_deref());
    }
    identity
}

async fn staged_asset(
    stage: &Path,
    index: usize,
) -> Result<Option<(String, u64)>, TransferFailure> {
    for extension in ["mp4", "ts"] {
        let name = format!("{index}.{extension}");
        let file_path = stage.join(&name);
        let mut file = match fs::File::open(&file_path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(TransferFailure::storage(error)),
        };
        let len = file
            .metadata()
            .await
            .map_err(TransferFailure::storage)?
            .len();
        let mut prefix = [0; 8];
        if (8..=SEG_LIMIT).contains(&len)
            && file.read_exact(&mut prefix).await.is_ok()
            && media_extension(&prefix) == Some(extension)
        {
            return Ok(Some((name, len)));
        }
    }
    Ok(None)
}

async fn link_staged_asset(source: &Path, destination: &Path) -> Result<(), TransferFailure> {
    match fs::hard_link(source, destination).await {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            fs::copy(source, destination)
                .await
                .map(|_| ())
                .map_err(TransferFailure::storage)
        }
        Err(error) => Err(TransferFailure::storage(error)),
    }
}

async fn remove_if_present(path: &Path) -> Result<(), TransferFailure> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TransferFailure::storage(error)),
    }
}

async fn write_atomic(dir: &Path, name: &str, data: &[u8]) -> Result<(), TransferFailure> {
    let temp = dir.join(format!(".{name}.part"));
    fs::write(&temp, data)
        .await
        .map_err(TransferFailure::storage)?;
    fs::rename(temp, dir.join(name))
        .await
        .map_err(TransferFailure::storage)
}

async fn prepare_asset_replacement(
    root: &Path,
    index: usize,
    name: &str,
) -> Result<(), TransferFailure> {
    // Remove the old stamp before committing any replacement bytes.
    remove_if_present(&root.join(format!("{index}.digest"))).await?;
    let other = if name.ends_with(".ts") { "mp4" } else { "ts" };
    remove_if_present(&root.join(format!("{index}.{other}"))).await
}

enum AssetData {
    Reused {
        size: u64,
        source: std::path::PathBuf,
        promote: Option<[u8; 32]>,
    },
    Downloaded {
        data: Vec<u8>,
        signature: Option<[u8; 32]>,
    },
}

async fn load_asset(
    asset: Asset,
    job: &Mutex<Job>,
    root: &Path,
    origin: &str,
    capture: Option<Capture>,
    checkpoint: Option<(&Path, bool)>,
) -> Result<(usize, String, AssetData), TransferFailure> {
    check_job(job)?;
    let index = asset.index;
    let signature = asset.signature;
    if let Some(signature) = signature {
        if let Ok(stamp) = fs::read(root.join(format!("{index}.digest"))).await {
            if stamp == signature {
                if let Some((name, size)) = staged_asset(root, index).await? {
                    let source = root.join(&name);
                    job.lock().unwrap().checkpoint_matches += 1;
                    return Ok((
                        index,
                        name,
                        AssetData::Reused {
                            size,
                            source,
                            promote: None,
                        },
                    ));
                }
            } else {
                job.lock().unwrap().checkpoint_changes += 1;
            }
        }
        if let Some((legacy, legacy_matches)) = checkpoint {
            let staged = if legacy_matches {
                staged_asset(legacy, index).await?.map(|(name, size)| {
                    let source = legacy.join(&name);
                    (name, size, source)
                })
            } else {
                None
            };
            let verified = match staged {
                Some(staged) => Some(staged),
                None => verify_cdn_checkpoint(&asset, origin, root, legacy).await?,
            };
            if let Some((name, size, source)) = verified {
                check_job(job)?;
                job.lock().unwrap().checkpoint_matches += 1;
                return Ok((
                    index,
                    name,
                    AssetData::Reused {
                        size,
                        source,
                        promote: Some(signature),
                    },
                ));
            }
        }
    }
    let (name, data) = fetch_asset(asset, job, origin, capture).await?;
    Ok((index, name, AssetData::Downloaded { data, signature }))
}

// Some CDN routes expose the wire content checksum as a strong ETag. On the
// built-in service, verify the full representation before promoting old bytes.
async fn verify_cdn_checkpoint(
    asset: &Asset,
    origin: &str,
    root: &Path,
    legacy: &Path,
) -> Result<Option<(String, u64, std::path::PathBuf)>, TransferFailure> {
    const CDN: &str = "tp1.drleao.cn";
    if asset.url.scheme() != "https"
        || !(net::trusted_auth_origin(origin) || asset.url.host_str() == Some(CDN))
    {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for dir in [root, legacy] {
        if let Some((name, size)) = staged_asset(dir, asset.index).await? {
            let source = dir.join(&name);
            candidates.push((name, size, source));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let Ok(response) = net::head_media(asset.url.as_str(), &format!("{origin}/")).await else {
        return Ok(None);
    };
    // The network layer validates every redirect. Only accept HTTPS evidence.
    if response.status() != 200 || response.url().scheme() != "https" {
        return Ok(None);
    }
    let headers = response.headers();
    if headers.contains_key(reqwest::header::CONTENT_ENCODING) {
        return Ok(None);
    }
    let Some(etag) = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix('"')?.strip_suffix('"'))
        .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return Ok(None);
    };
    let size = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    let etag = etag.to_owned();
    let encryption = asset.encryption.clone();
    let sequence = asset.sequence;
    let matched = tokio::task::spawn_blocking(move || {
        candidates.into_iter().find(|(_, bytes, source)| {
            let expected_size = if encryption.is_some() {
                (bytes / 16 + 1) * 16
            } else {
                *bytes
            };
            size == Some(expected_size)
                && checkpoint_md5(source, *bytes, encryption.as_ref(), sequence)
                    .is_some_and(|digest| digest.eq_ignore_ascii_case(&etag))
        })
    })
    .await
    .unwrap_or_default();
    Ok(matched)
}

fn checkpoint_md5(
    path: &Path,
    len: u64,
    encryption: Option<&Encryption>,
    sequence: u64,
) -> Option<String> {
    use std::io::{BufReader, Read};
    let mut file = BufReader::new(std::fs::File::open(path).ok()?);
    let mut hash = Md5::new();
    if let Some(encryption) = encryption {
        let cipher = Aes128::new_from_slice(&encryption.key).ok()?;
        let mut previous = encryption
            .iv
            .unwrap_or_else(|| u128::from(sequence).to_be_bytes());
        let mut encrypt = |mut block: [u8; 16]| {
            for (byte, prev) in block.iter_mut().zip(previous) {
                *byte ^= prev;
            }
            let mut block = Block::<Aes128>::from(block);
            cipher.encrypt_block(&mut block);
            previous = block.into();
            hash.update(previous);
        };
        for _ in 0..len / 16 {
            let mut block = [0; 16];
            file.read_exact(&mut block).ok()?;
            encrypt(block);
        }
        let tail = (len % 16) as usize;
        let mut last = [(16 - tail) as u8; 16];
        file.read_exact(&mut last[..tail]).ok()?;
        encrypt(last);
        if file.read(&mut [0]).ok()? != 0 {
            return None;
        }
    } else {
        std::io::copy(&mut file, &mut hash)
            .ok()
            .filter(|&size| size == len)?;
    }
    Some(format!("{:x}", hash.finalize()))
}

fn media_extension(data: &[u8]) -> Option<&'static str> {
    if data
        .get(4..8)
        .is_some_and(|tag| matches!(tag, b"ftyp" | b"styp" | b"moof" | b"sidx"))
    {
        Some("mp4")
    } else if data.first() == Some(&0x47) {
        Some("ts")
    } else {
        None
    }
}

struct Asset {
    url: url::Url,
    index: usize,
    encryption: Option<Encryption>,
    sequence: u64,
    signature: Option<[u8; 32]>,
}

async fn fetch_asset(
    Asset {
        url,
        index,
        encryption,
        sequence,
        ..
    }: Asset,
    job: &Mutex<Job>,
    origin: &str,
    capture: Option<Capture>,
) -> Result<(String, Vec<u8>), TransferFailure> {
    let mut data = download(job, url.as_str(), origin, SEG_LIMIT, capture).await?;
    if let Some(key) = encryption {
        let iv = key.iv.unwrap_or_else(|| u128::from(sequence).to_be_bytes());
        media::aes_cbc_decrypt_in_place(&mut data, &key.key, &iv).ok_or("无法解码视频分片")?;
        data = media::strip_padding(data);
    }
    if data.is_empty() {
        return Err(TransferFailure::from("媒体分片为空").with_reason(FailureReason::MediaInvalid));
    }
    let extension = media_extension(&data).ok_or_else(|| {
        TransferFailure::from("媒体分片格式异常").with_reason(FailureReason::MediaInvalid)
    })?;
    check_job(job)?;
    let name = format!("{index}.{extension}");
    Ok((name, data))
}

fn parse_iv(value: &str) -> Result<[u8; 16], String> {
    let hex = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .ok_or("加密参数无效")?;
    u128::from_str_radix(hex, 16)
        .map(u128::to_be_bytes)
        .map_err(|_| "加密参数无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{io::AsyncReadExt, net::TcpListener, sync::Barrier};

    #[test]
    fn checkpoint_digest_reconstructs_the_downloaded_ciphertext() {
        let path = std::env::temp_dir().join(format!("hg-segment-digest-{}", std::process::id()));
        let data = b"fixture segment payload";
        std::fs::write(&path, data).unwrap();
        let key = Encryption {
            key: vec![0; 16],
            iv: None,
        };
        let size = data.len() as u64;
        assert_eq!(
            checkpoint_md5(&path, size, Some(&key), 7).as_deref(),
            Some("5511c2790ac5739111d4e224bf06bd08")
        );
        assert_ne!(
            checkpoint_md5(&path, size, Some(&key), 8),
            checkpoint_md5(&path, size, Some(&key), 7)
        );
        assert_eq!(
            checkpoint_md5(&path, size, None, 7).as_deref(),
            Some("0cb2097d4bb5f2ac6bc71d197b4683b1")
        );
        assert_eq!(checkpoint_md5(&path, size - 1, Some(&key), 7), None);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    #[ignore = "uses a slow local HTTP fixture and temporarily disables the network guard"]
    async fn active_segment_can_finish_after_twenty_seconds() {
        let root = std::env::temp_dir().join(format!("hg-hls-slow-{}", std::process::id()));
        fs::create_dir(&root).await.unwrap();
        network_policy::bind_security(&root);
        network_policy::set_strict_security(false).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(11)).await;
            socket.write_all(b"b").await.unwrap();
            tokio::time::sleep(Duration::from_secs(11)).await;
            socket.write_all(b"c").await.unwrap();
        });
        let job = Mutex::new(Job::default());
        let url = format!("{origin}/slow.ts");
        let body = tokio::time::timeout(
            Duration::from_secs(30),
            download(&job, &url, &origin, SEG_LIMIT, None),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(body, b"abc");
        assert_eq!(job.lock().unwrap().resource_retries, 0);
        server.await.unwrap();
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "uses an isolated HTTP fixture and temporarily disables the network guard"]
    async fn legacy_checkpoint_keeps_matching_fragments() {
        let root = std::env::temp_dir().join(format!("hg-hls-legacy-{}", std::process::id()));
        fs::create_dir(&root).await.unwrap();
        network_policy::bind_security(&root);
        network_policy::set_strict_security(false).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let lines = [
            PlaylistLine::Text("#EXTM3U".into()),
            PlaylistLine::Text("#EXTINF:1,".into()),
            PlaylistLine::Asset {
                init: false,
                index: 0,
            },
            PlaylistLine::Text("#EXT-X-ENDLIST".into()),
        ];
        let asset = Asset {
            url: format!("{origin}/old.ts").parse().unwrap(),
            index: 0,
            encryption: None,
            sequence: 0,
            signature: None,
        };
        let marker = checkpoint_signature(1, &origin, &lines, &[asset]);
        fs::write(root.join(HLS_CHECKPOINT), marker).await.unwrap();
        fs::write(root.join("0.ts"), [0x47; 188]).await.unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"GET /index.m3u8 "));
            let body = b"#EXTM3U\n#EXTINF:1,\nold.ts\n#EXT-X-ENDLIST\n";
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
            // A matching old checkpoint must not request the asset again.
            assert!(
                tokio::time::timeout(Duration::from_millis(300), listener.accept())
                    .await
                    .is_err()
            );
        });
        let job = Mutex::new(Job::default());
        let options = TransferOptions {
            resume_episode: Some(1),
            ..TransferOptions::default()
        };
        save_video(
            &job,
            &root,
            &format!("{origin}/index.m3u8"),
            &origin,
            options,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(job.lock().unwrap().reused_bytes, 188);
        assert!(root.join(HLS_ASSETS).join("0.digest").is_file());
        assert!(root.join(HLS_CHECKPOINT).is_file());
        assert_eq!(
            fs::read(root.join(HLS_PACKAGE).join("0.ts")).await.unwrap(),
            vec![0x47; 188]
        );
        fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn unrecognized_or_duplicate_query_parameters_remain_part_of_identity() {
        let identity = |value: &str| media_identity(&value.parse().unwrap()).to_string();
        let first = "https://cdn.example.com/part.ts?quality=high&txTime=71000000&txSecret=00000000000000000000000000000000";
        let second = "https://cdn.example.com/part.ts?quality=high&txTime=71000100&txSecret=11111111111111111111111111111111";
        assert_eq!(identity(first), identity(second));
        assert_ne!(
            identity(first),
            identity(&second.replace("quality=high", "quality=low"))
        );
        assert_eq!(
            identity("https://cdn.example.com/part.ts?token=opaque"),
            "https://cdn.example.com/part.ts?token=opaque"
        );
        let duplicate = format!("{first}&txTime");
        assert_eq!(identity(&duplicate), duplicate);
    }

    #[test]
    fn dns_failures_can_retry_but_address_policy_errors_cannot() {
        for reason in ["DNS 解析超时", "DNS 解析失败"] {
            assert!(TransferFailure::connect(reason.into())
                .retry_after
                .is_some());
        }
        let blocked =
            network_policy::check_addresses_with_mode(&["127.0.0.1:80".parse().unwrap()], true)
                .unwrap_err();
        assert!(TransferFailure::connect(blocked).retry_after.is_none());
    }

    #[tokio::test]
    #[ignore = "uses an isolated HTTP fixture and temporarily disables the network guard"]
    async fn retries_transient_media_response_but_not_missing_media() {
        let root = std::env::temp_dir().join(format!("hg-media-retry-{}", std::process::id()));
        fs::create_dir(&root).await.unwrap();
        network_policy::bind_security(&root);
        network_policy::set_strict_security(false).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (expected, status, body) in [
                ("/recover.ts", "503 Service Unavailable", ""),
                ("/recover.ts", "200 OK", "media"),
                ("/missing.ts", "404 Not Found", ""),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
                let request = String::from_utf8(request).unwrap();
                assert_eq!(request.split_whitespace().nth(1), Some(expected));
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let job = Mutex::new(Job::default());
        let recovered = format!("{origin}/recover.ts");
        let missing = format!("{origin}/missing.ts");
        let timeout = Duration::from_secs(3);
        let result = tokio::time::timeout(timeout, download(&job, &recovered, &origin, 128, None))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, b"media");
        let error = tokio::time::timeout(timeout, download(&job, &missing, &origin, 128, None))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.message, "媒体请求失败（HTTP 404）");
        assert!(error.retry_after.is_none());
        server.await.unwrap();
        fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "uses an isolated HTTP fixture and temporarily disables the network guard"]
    async fn hls_parallelism_preserves_playlist_order() {
        let root = std::env::temp_dir().join(format!("hg-hls-parallel-{}", std::process::id()));
        fs::create_dir(&root).await.unwrap();
        network_policy::bind_security(&root);
        network_policy::set_strict_security(false).unwrap();
        let mut timings = Vec::new();

        for limit in [1, 4] {
            let stage = root.join(limit.to_string());
            fs::create_dir(&stage).await.unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let barrier = Arc::new(Barrier::new(limit));
            let server = {
                let active = active.clone();
                let peak = peak.clone();
                tokio::spawn(async move {
                    let mut requests = Vec::new();
                    for _ in 0..5 {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let active = active.clone();
                        let peak = peak.clone();
                        let barrier = barrier.clone();
                        requests.push(tokio::spawn(async move {
                            let mut request = Vec::new();
                            while !request.ends_with(b"\r\n\r\n") {
                                request.push(socket.read_u8().await.unwrap());
                            }
                            let request = String::from_utf8(request).unwrap();
                            let path = request.split_whitespace().nth(1).unwrap();
                            let asset = path.strip_prefix("/part").and_then(|p| p.parse::<u8>().ok());
                            let body = if let Some(index) = asset {
                                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                                peak.fetch_max(count, Ordering::SeqCst);
                                barrier.wait().await;
                                let delay = if index == 0 { 170 } else { 100 };
                                tokio::time::sleep(Duration::from_millis(delay)).await;
                                let mut data = vec![index; 188];
                                data[0] = 0x47;
                                data
                            } else {
                                assert_eq!(path, "/index.m3u8");
                                b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\npart0\n#EXTINF:1,\npart1\n#EXTINF:1,\npart2\n#EXTINF:1,\npart3\n#EXT-X-ENDLIST\n".to_vec()
                            };
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                            if asset.is_some() {
                                active.fetch_sub(1, Ordering::SeqCst);
                            }
                            socket.write_all(&body).await.unwrap();
                        }));
                    }
                    for request in requests {
                        request.await.unwrap();
                    }
                })
            };
            let start = std::time::Instant::now();
            let job = Mutex::new(Job::default());
            let url = format!("{origin}/index.m3u8");
            tokio::time::timeout(
                Duration::from_secs(8),
                save_video(
                    &job,
                    &stage,
                    &url,
                    &origin,
                    TransferOptions {
                        capture: None,
                        segments: limit,
                        ..TransferOptions::default()
                    },
                ),
            )
            .await
            .unwrap()
            .unwrap();
            timings.push(start.elapsed().as_millis());
            server.await.unwrap();
            assert_eq!(peak.load(Ordering::SeqCst), limit);
            let playlist = fs::read_to_string(stage.join("index.m3u8")).await.unwrap();
            assert_eq!(
                playlist
                    .lines()
                    .filter(|line| line.ends_with(".ts"))
                    .collect::<Vec<_>>(),
                ["0.ts", "1.ts", "2.ts", "3.ts"]
            );
            for index in 0..4 {
                let data = fs::read(stage.join(format!("{index}.ts"))).await.unwrap();
                assert_eq!(data[0..2], [0x47, index]);
            }
        }
        println!(
            "Four delayed HLS fragments: 1 lane {} ms, 4 lanes {} ms",
            timings[0], timings[1]
        );
        fs::remove_dir_all(root).await.unwrap();
    }
}
