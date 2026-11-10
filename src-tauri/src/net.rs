//! 网络层：与上游站点对话。
//!
//! 站点把全部 `/api/**` 调用收敛成 `POST /api/edge/request` 的信封，
//! 我们只实现这一个入口，其余接口都是「填 path」。
//!
//! # 代理（用户反馈「浏览器能开、HGhub 打不开」的根因就在这里）
//!
//! 客户端的流量**全部**走本文件的 reqwest，跟 WebView2 无关，所以它既不共享
//! 浏览器的代理设置，也不共享浏览器的证书库：
//!
//! * reqwest 只有开了 `system-proxy` feature 才会读 Windows 系统代理
//!   （`HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`/`ProxyOverride`）。
//!   本 crate 用 `default-features = false`，早先漏了这个 feature ⇒ 永远直连，
//!   只有 TUN/虚拟网卡这种网络层接管才「看起来能用」。
//! * 即使开了 `system-proxy`，PAC（`AutoConfigURL`）也不被支持，只认固定代理。
//! * Android 没有注册表可读，系统「Wi-Fi 代理」同样不被 reqwest 采用；
//!   安卓上只有 VPN/TUN 模式（VpnService 抓全流量）才有效。
//!
//! 排查手段：环境变量 `HGHUB_PROXY=http://127.0.0.1:7897` 可强制指定代理，
//! `net_diag` 命令会输出 DNS/HTTP/环境变量快照。

use crate::network_policy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 默认上游（固定线路 1）。
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 当前上游基址（不带结尾斜杠）。可在设置里切到固定线路 2 或镜像线路，运行时立即生效。
static BASE: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new(DEFAULT_BASE.to_string()));
/// 线路配置落盘位置（应用数据目录/line.json），由 [`bind_base`] 在启动时绑定。
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前上游基址。
pub fn base() -> String {
    BASE.read()
        .map(|b| b.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

/// 线路必须是纯 HTTPS origin，不允许路径、认证、查询串或片段。
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target(raw.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// 远端发布页只提供游客镜像，不能扩展账号密码的信任范围。
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
}

/// 启动时读回上次选择的线路（文件不存在 / 内容坏了就保持默认）。
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    let path = dir.join("line.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(next) = v
                .get("base")
                .and_then(|x| x.as_str())
                .and_then(normalize_base)
            {
                if let Ok(mut cur) = BASE.write() {
                    *cur = next;
                }
            }
        }
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
}

/// 切换线路并落盘，返回规整后的地址。
pub fn set_base(url: &str) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    if let Ok(mut cur) = BASE.write() {
        *cur = next.clone();
    }
    if let Some(path) = BASE_FILE.read().ok().and_then(|p| p.clone()) {
        let _ = std::fs::write(path, json!({ "base": next }).to_string());
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 手动指定代理（排查 / 公司内网用）：`HGHUB_PROXY=http://127.0.0.1:7897`。
/// 不设时交给 reqwest 的 `system-proxy` 探测（注册表 + 环境变量）。
fn proxy_override() -> Option<String> {
    std::env::var("HGHUB_PROXY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 按**当前**系统代理设置新建一个客户端。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，症状是满屏 `tunnel error: failed to create
/// underlying connection`（浏览器却是通的，因为它每次都重读系统代理）。所以这里允许重建。
fn build_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .read_timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if let Some(p) = proxy_override() {
        // 错误信息不能含原始代理 URL（其中可能有用户名/密码）。
        let proxy = reqwest::Proxy::all(&p).map_err(|_| "HGHUB_PROXY 配置无效（已隐藏原始值）")?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "无法创建 HTTP 客户端".to_string())
}

const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// 缓存按模式、主机和端口隔离；有效期内仅复用已经检查并固定地址的客户端。
/// 到期后重新检查全部 DNS 答案，不使用旧连接绕过新的目标检查。
async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("目标缺少主机名")?;
    let port = target.port_or_known_default().ok_or("目标端口无效")?;
    let key = format!("{strict}:{host}:{port}");
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let addrs = if strict {
        network_policy::resolve_target(&target, strict).await?
    } else {
        Vec::new()
    };
    let http = Arc::new(build_client(host, &addrs)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
    // 同时到达的请求可能已完成解析；不延长已有结果的有效期。
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + CLIENT_TTL, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_inner(raw, timeout, Some(timeout), accept, referer, None).await
}

pub async fn get_stream(raw: &str, referer: &str) -> Result<reqwest::Response, String> {
    get_inner(
        raw,
        Duration::from_secs(20),
        None,
        None,
        Some(referer),
        None,
    )
    .await
}

#[cfg(target_os = "ios")]
pub async fn get_playback_stream(
    raw: &str,
    referer: &str,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_inner(
        raw,
        Duration::from_secs(20),
        None,
        None,
        Some(referer),
        range,
    )
    .await
}

async fn get_inner(
    raw: &str,
    timeout: Duration,
    request_timeout: Option<Duration>,
    accept: Option<&str>,
    referer: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let mut next = network_policy::parse_target(raw)?;
        for hop in 0..=5 {
            let (target, http) = client_for(next.as_str()).await?;
            let mut request = http.get(target.clone());
            if let Some(timeout) = request_timeout {
                request = request.timeout(timeout);
            }
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            if let Some(value) = range {
                request = request
                    .header("Range", value)
                    .header("Accept-Encoding", "identity");
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location)?;
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 只返回代理的协议/主机/端口；解析失败时隐藏整个值，绝不回传认证或查询参数。
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap());
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[已配置，原始值已隐藏]".into(),
    }
}

/// 看起来像代理 / 隧道问题（而不是目标站点本身不可达）。
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// 请求失败后按需重建客户端：代理隧道错误、连接被拒 / 超时都算「网络环境可能变了」。
/// 3 秒内只重建一次，批量探测不会反复重建。
pub fn heal_client(reason: &str) {
    let connectish = reason.contains("Connect")
        || reason.contains("timed out")
        || reason.contains("refused")
        || reason.contains("dns");
    if !is_proxy_error(reason) && !connectish {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

/// reqwest 的 `Display` 只有「error sending request for url (...)」，
/// 真正的原因（dns error / connection refused / invalid peer certificate）
/// 藏在 `source()` 链里。展开成一行，界面和 debug.log 才有排查价值。
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    out
}

fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// 网络自检：DNS / HTTP / 代理相关环境变量，用于远程定位「打不开」。
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // fake-ip（198.18.0.0/15）说明 DNS 被 TUN 接管：关掉 TUN 后这个地址根本不可路由。
    let dns = {
        let host = host.clone();
        tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            match (host.as_str(), 443u16).to_socket_addrs() {
                Ok(iter) => dns_summary(iter),
                Err(_) => json!({ "error": "DNS 解析失败" }),
            }
        })
        .await
        .unwrap_or(Value::Null)
    };

    let started = Instant::now();
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "error": e,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    json!({
        "base": cur,
        "host": host,
        "dns": dns,
        "http": http,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[已配置，列表已隐藏]"),
            "HGHUB_PROXY": proxy_override().map(|p| redact_proxy(&p)),
        },
    })
}

/// 站点偶发 TLS 抖动（实测），统一重试；碰上代理隧道错误就先重建客户端再试
/// （代理软件开关后旧客户端会一直卡在 tunnel error 上）。
async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

pub(crate) fn retryable_edge_error(error: &str) -> bool {
    if let Some(code) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(code, 408 | 500 | 502 | 503 | 504);
    }
    error == "请求超时"
        || error.starts_with("error sending request")
        || error.starts_with("error decoding response body")
}

/// Keep a read failure visible within a bounded time. Writes never go through this helper.
async fn edge_read<F, Fut, T>(request: F) -> Result<T, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let attempt = || async {
        tokio::time::timeout(Duration::from_secs(7), request())
            .await
            .map_err(|_| "请求超时".to_string())?
    };
    match attempt().await {
        Err(error) if retryable_edge_error(&error) => {
            heal_client(&error);
            tokio::time::sleep(Duration::from_millis(400)).await;
            attempt().await
        }
        result => result,
    }
}

/// 仅无请求体、无凭据的逻辑 GET 可以迁移网关；信封本身仍使用 POST。
fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301 | 302 | 303) {
        return Err("业务接口重定向已拒绝".into());
    }
    network_policy::redirect_target(current, location)
}

/// 业务请求：走边缘信封。
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    edge_request(origin, method, path, body, token, true).await
}

fn playback_url(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
}

fn normalize_episode_playback(mut value: Value) -> Value {
    if let Some(fields) = value.as_object_mut() {
        if let Some(streams) = fields.remove("streams") {
            for (stream, field) in [("main", "video_url"), ("hevc", "video_url_hevc")] {
                if let Some(url) = playback_url(&streams, stream) {
                    fields.insert(field.into(), Value::String(url));
                }
            }
        }
        fields.remove("cdn");
    }
    value
}

/// Use the current playback endpoint, with a fallback for older mirror implementations.
pub async fn episode_playback(
    origin: &str,
    id: i64,
    ep: u32,
    token: Option<&str>,
) -> Result<Value, String> {
    let path = format!("/api/videos/{id}/episodes/{ep}/playback");
    match edge(origin, "POST", &path, Some(json!({})), token).await {
        Ok(response) => {
            let playback = normalize_episode_playback(response);
            if playback_url(&playback, "video_url").is_some()
                || playback_url(&playback, "video_url_hevc").is_some()
            {
                return Ok(playback);
            }
        }
        Err(reason) if reason == "HTTP 404" || reason == "HTTP 405" => {}
        Err(reason) => return Err(reason),
    }

    let legacy_path = format!("/api/videos/{id}/play?ep={ep}&page_texts=0");
    edge(origin, "GET", &legacy_path, None, token).await
}

/// A user-initiated line test checks the same guest endpoint without retries.
pub async fn probe_feed(origin: &str) -> Result<Value, String> {
    edge_request(
        origin,
        "GET",
        "/api/videos?page=1&size=1",
        None,
        None,
        false,
    )
    .await
}

async fn edge_request(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
    allow_retry: bool,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("业务请求必须使用安全 HTTPS 线路")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        return Err("镜像线路仅供游客浏览；登录/注册请切换到固定线路".into());
    }
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}/api/edge/request");
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    let request = || {
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        async move {
            let mut next = network_policy::parse_target(&url)?;
            for hop in 0..=5 {
                let (target, client) = client_for(next.as_str()).await?;
                let mut req = client
                    .post(target.clone())
                    .timeout(Duration::from_secs(20))
                    .header("Accept", "application/json")
                    .header("Referer", &referer)
                    .json(&envelope);
                if let Some(t) = token.as_deref() {
                    if !t.is_empty() {
                        req = req.header("Authorization", format!("Bearer {t}"));
                    }
                }
                let resp = req.send().await.map_err(|e| err_text(&e))?;
                let status = resp.status();
                // 逐跳重建并检查客户端；不自动把信封 POST 改成无信封 GET。
                if status.is_redirection() {
                    if hop == 5 {
                        return Err("重定向次数超过限制".into());
                    }
                    let location = resp
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|h| h.to_str().ok())
                        .ok_or("重定向缺少有效 Location")?;
                    next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
                    continue;
                }
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Err("401".to_string());
                }
                if !status.is_success() {
                    return Err(format!("HTTP {}", status.as_u16()));
                }
                let text = resp.text().await.map_err(|e| err_text(&e))?;
                if text.trim().is_empty() {
                    return Ok(Value::Null);
                }
                return serde_json::from_str::<Value>(&text)
                    .map_err(|_| "服务返回的数据格式异常，请稍后重试".to_string());
            }
            Err("重定向次数超过限制".into())
        }
    };
    let value = if allow_retry && method.eq_ignore_ascii_case("GET") && body.is_none() {
        edge_read(request).await?
    } else {
        request().await?
    };

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败")
            .to_string())
    }
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let (kind, bytes, _, _) = fetch_media(url, &base()).await?;
    Ok((kind, bytes))
}

pub async fn fetch_media(
    url: &str,
    origin: &str,
) -> Result<(Option<String>, Vec<u8>, url::Url, bool), String> {
    let url = url.to_string();
    let referer = format!("{origin}/");
    with_retry(true, || {
        let url = url.clone();
        let referer = referer.clone();
        async move {
            let resp = get(&url, Duration::from_secs(20), None, Some(&referer)).await?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let ctype = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let complete = resp.status() == 200
                && !resp.headers().contains_key(reqwest::header::CONTENT_RANGE);
            let final_url = resp.url().clone();
            let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
            Ok((ctype, bytes, final_url, complete))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edge_read_retries_transient_failure_but_not_a_missing_route() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        let result = edge_read(|| {
            let n = calls.get() + 1;
            calls.set(n);
            std::future::ready(if n == 1 {
                Err("HTTP 503".into())
            } else {
                Ok(17)
            })
        })
        .await;
        assert_eq!(result, Ok(17));
        assert_eq!(calls.get(), 2);

        calls.set(0);
        let result = edge_read(|| {
            calls.set(calls.get() + 1);
            std::future::ready(Err::<(), _>("HTTP 404".into()))
        })
        .await;
        assert_eq!(result, Err("HTTP 404".into()));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let client = Arc::new(reqwest::Client::new());
        let mut cache = ClientCache::new();
        cache.insert(
            "true:example.com:443".into(),
            (now + CLIENT_TTL, client.clone()),
        );
        assert!(Arc::ptr_eq(
            &cached_client(
                &cache,
                "true:example.com:443",
                now + Duration::from_secs(29)
            )
            .unwrap(),
            &client
        ));
        assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
        assert!(cached_client(&cache, "false:example.com:443", now).is_none());
        assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
    }

    #[test]
    fn edge_redirects_only_replay_anonymous_reads() {
        let current = url::Url::parse("https://huangguoai.ai/api/edge/request").unwrap();
        assert_eq!(
            edge_redirect_target(
                &current,
                301,
                "https://huangguoai.com/api/edge/request",
                true
            )
            .unwrap()
            .host_str(),
            Some("huangguoai.com")
        );
        assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
        for status in [301, 302, 303, 307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", false).is_err());
        }
        for status in [307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", true).is_err());
        }
        assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
        assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
    }

    #[test]
    fn episode_playback_normalizes_main_and_hevc_without_using_preview() {
        let data = normalize_episode_playback(json!({
            "streams": {
                "main": " https://media.example/main.m3u8 ",
                "hevc": "https://media.example/hevc.m3u8",
                "preview": "https://media.example/preview.m3u8"
            },
            "cdn": {"app": "fixture"}
        }));
        assert_eq!(data["video_url"], "https://media.example/main.m3u8");
        assert_eq!(data["video_url_hevc"], "https://media.example/hevc.m3u8");
        assert!(data.get("streams").is_none());
        assert!(data.get("cdn").is_none());

        let data = normalize_episode_playback(json!({
            "video_url": "https://media.example/legacy.m3u8",
            "streams": {"main": "", "preview": "https://media.example/preview.m3u8"}
        }));
        assert_eq!(data["video_url"], "https://media.example/legacy.m3u8");
        assert!(data.get("video_url_hevc").is_none());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[已配置，原始值已隐藏]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(err.contains("镜像线路仅供游客浏览"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("禁止访问"));
    }

    /// 手动跑：`cargo test --lib -- --ignored net::tests::diag -- --nocapture`
    /// 关掉 TUN、只留系统代理时跑一遍，能直接看出客户端有没有走代理。
    #[tokio::test]
    #[ignore = "联网测试：请求上游做网络自检，手动用 --ignored 运行"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }
}
