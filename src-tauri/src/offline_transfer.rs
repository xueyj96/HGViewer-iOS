use super::{check_job, storage_error, Capture, Job};
use crate::{media, net, network_policy, watch};
use futures_util::{stream, StreamExt};
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
pub(super) enum FailureReason {
    Dns,
    Timeout,
    Connection,
    AddressRejected,
    Http(u16),
    BodyInterrupted,
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
        let mut response = net::get(url, Duration::from_secs(20), None, Some(&referer))
            .await
            .map_err(TransferFailure::connect)?;
        if response.status() != 200 {
            return Err(TransferFailure::status(&response));
        }
        if response.content_length().is_some_and(|len| len > limit) {
            return Err("媒体分片或清单过大".into());
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            TransferFailure::transient("媒体下载中断", Duration::ZERO)
                .with_reason(FailureReason::BodyInterrupted)
        })? {
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
        progress.transfer_done = 0;
        progress.transfer_total = response.content_length().unwrap_or(0);
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
        let mut progress = job.lock().unwrap();
        progress.transfer_done = bytes;
        progress.record_network_bytes(chunk.len());
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
    if base.path().to_ascii_lowercase().ends_with(".mp4") {
        if options.resume_episode.is_some() {
            reset_stage(stage).await?;
        }
        let bytes = save_mp4(job, &stage.join("video.mp4"), base.as_str(), origin).await?;
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
    if let Some(ep) = options.resume_episode {
        let signature = checkpoint_signature(ep, origin, &lines, &assets);
        if fs::read(stage.join(HLS_CHECKPOINT)).await.ok().as_deref() != Some(signature.as_slice())
        {
            reset_stage(stage).await?;
            fs::write(stage.join(HLS_CHECKPOINT), signature)
                .await
                .map_err(TransferFailure::storage)?;
        }
    }
    let parallelism = options
        .segments
        .clamp(1, super::queue::MAX_SEGMENTS)
        .min(assets.len());
    {
        let mut progress = job.lock().unwrap();
        progress.transfer_done = 0;
        progress.transfer_total = assets.len() as u64;
    }
    let reservation = SEGMENT_SLOTS.acquire_many(parallelism as u32);
    tokio::pin!(reservation);
    let _slots = loop {
        tokio::select! {
            slots = &mut reservation => break slots.map_err(|_| "媒体下载暂不可用")?,
            _ = tokio::time::sleep(Duration::from_millis(250)) => check_job(job)?,
        }
    };
    let mut names = vec![None; assets.len()];
    let mut completed = stream::iter(assets)
        .map(|asset| load_asset(asset, job, stage, origin, options))
        .buffer_unordered(parallelism);
    let mut bytes = 0;
    loop {
        let result = tokio::select! {
            result = completed.next() => result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                check_job(job)?;
                continue;
            }
        };
        let Some(result) = result else { break };
        let (index, name, data) = result.map_err(|error| {
            if error.stage == "media" {
                error.at("hls_asset")
            } else {
                error
            }
        })?;
        let size = match data {
            AssetData::Reused(size) => {
                job.lock().unwrap().reused_bytes += size;
                size
            }
            AssetData::Downloaded(data) => {
                let temporary = stage.join(format!(".{index}.part"));
                fs::write(&temporary, &data)
                    .await
                    .map_err(TransferFailure::storage)?;
                fs::rename(temporary, stage.join(&name))
                    .await
                    .map_err(TransferFailure::storage)?;
                if options.resume_episode.is_some() {
                    let other = if name.ends_with(".ts") { "mp4" } else { "ts" };
                    if let Err(error) =
                        fs::remove_file(stage.join(format!("{index}.{other}"))).await
                    {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            return Err(TransferFailure::storage(error));
                        }
                    }
                }
                data.len() as u64
            }
        };
        names[index] = Some(name);
        bytes += size;
        job.lock().unwrap().transfer_done += 1;
    }
    check_job(job)?;
    let mut out = String::new();
    for line in lines {
        match line {
            PlaylistLine::Text(line) => out.push_str(&line),
            PlaylistLine::Asset { init, index } => {
                let name = names[index].as_deref().ok_or("媒体分片不完整")?;
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
    fs::write(stage.join("index.m3u8"), out)
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

enum AssetData {
    Reused(u64),
    Downloaded(Vec<u8>),
}

async fn load_asset(
    asset: Asset,
    job: &Mutex<Job>,
    stage: &Path,
    origin: &str,
    options: TransferOptions,
) -> Result<(usize, String, AssetData), TransferFailure> {
    check_job(job)?;
    let index = asset.index;
    if options.resume_episode.is_some() {
        if let Some((name, bytes)) = staged_asset(stage, index).await? {
            return Ok((index, name, AssetData::Reused(bytes)));
        }
    }
    let (name, data) = fetch_asset(asset, job, origin, options.capture).await?;
    Ok((index, name, AssetData::Downloaded(data)))
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
}

async fn fetch_asset(
    Asset {
        url,
        index,
        encryption,
        sequence,
    }: Asset,
    job: &Mutex<Job>,
    origin: &str,
    capture: Option<Capture>,
) -> Result<(String, Vec<u8>), TransferFailure> {
    let mut data = download(job, url.as_str(), origin, SEG_LIMIT, capture).await?;
    if let Some(key) = encryption {
        let iv = key.iv.unwrap_or_else(|| u128::from(sequence).to_be_bytes());
        data = media::aes_cbc_decrypt(&data, &key.key, &iv)
            .map(media::strip_padding)
            .ok_or("无法解码视频分片")?;
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
