//! 线路（数据源）：固定线路 + 地址发布页上的镜像线路。
//!
//! 候选只用于用户手动发现、检测和切换；首页探测通过不代表账号或播放能力已验证。
//! 镜像地址来自 <https://huangguoai.pages.dev/>：那个页面本身是空壳，真正的清单在
//! `publish.js` 里（`var urls` 域名数组 + `var subdomains` 子域数组，页面自己随机拼）。

use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 固定线路：写死在客户端里，不依赖任何外部页面。
pub const FIXED: [(&str, &str); 2] = [
    ("固定线路 1", "https://huangguoai.com"),
    ("固定线路 2", "https://huangguoai.io"),
];

const PUBLISH_PAGE: &str = "https://huangguoai.pages.dev/";
/// 镜像列表上限（子域 × 域名是笛卡尔积，界面只展示这么多）
const MIRROR_MAX: usize = 60;
/// HTML 与 JS 解压后累计最多 512 KiB，不能靠截断生成部分候选。
const PUBLISH_BYTES_MAX: usize = 512 * 1024;
/// 发布页只需短域名列表；限制解析空间和笛卡尔积输入。
const JS_ARRAY_MAX: usize = 256;
const JS_STRING_BYTES_MAX: usize = 1024;
/// 单条线路探测超时
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

pub fn fixed() -> Value {
    json!(FIXED
        .iter()
        .map(|(name, url)| json!({ "name": name, "url": url, "supports_login": crate::net::trusted_auth_origin(url) }))
        .collect::<Vec<_>>())
}

/// 拉地址发布页 → 解析 publish.js → 拼出镜像地址。只在用户点开「线路」时调用。
pub async fn mirrors() -> Result<Value, String> {
    let mut remaining = PUBLISH_BYTES_MAX;
    let html = get_text(PUBLISH_PAGE, &mut remaining).await?;
    let js_rel = script_src(&html).unwrap_or_else(|| "publish.js".to_string());
    let js_url = publish_script_url(PUBLISH_PAGE, &js_rel).ok_or("地址发布页脚本地址无效")?;
    let js = get_text(&js_url, &mut remaining).await?;

    let domains = js_array(&js, "urls").ok_or("地址发布页的镜像域名数组格式异常或超过解析上限")?;
    let subs = js_array(&js, "subdomains").ok_or("地址发布页的子域名数组格式异常或超过解析上限")?;
    if domains.is_empty() {
        return Err("地址发布页格式有变化：没找到镜像域名".to_string());
    }

    let items = mirror_candidates(&domains, &subs);
    if items.is_empty() {
        return Err("地址发布页里没有可用的镜像地址".to_string());
    }

    Ok(json!({ "source": PUBLISH_PAGE, "script": js_url, "items": items }))
}

/// 可达性探测（并发 6 条一组）。只报结果，不做自动切换。
pub async fn probe(urls: Vec<String>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let urls = probe_candidates(urls);
    for chunk in urls.chunks(6) {
        let mut handles = Vec::new();
        for u in chunk {
            let u = u.clone();
            handles.push(tokio::spawn(async move { probe_one(u).await }));
        }
        for h in handles {
            if let Ok(v) = h.await {
                out.push(v);
            }
        }
    }
    json!(out)
}

async fn probe_one(url: String) -> Value {
    let started = Instant::now();
    let result = tokio::time::timeout(PROBE_TIMEOUT, crate::net::probe_feed(&url)).await;
    let ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(Ok(data)) if valid_feed(&data) => {
            json!({ "url": url, "ok": true, "ms": ms })
        }
        Ok(Err(e)) => {
            let status = e
                .strip_prefix("HTTP ")
                .and_then(|code| code.parse::<u16>().ok());
            json!({ "url": url, "ok": false, "status": status, "ms": ms, "error": "首页接口不可用" })
        }
        Ok(Ok(_)) => json!({ "url": url, "ok": false, "ms": ms, "error": "首页数据格式异常" }),
        Err(_) => json!({ "url": url, "ok": false, "ms": ms, "error": "首页接口检测超时" }),
    }
}

async fn get_text(url: &str, remaining: &mut usize) -> Result<String, String> {
    let mut resp = crate::net::get(url, Duration::from_secs(12), None, None).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    if resp
        .content_length()
        .is_some_and(|length| length > *remaining as u64)
    {
        return Err("地址发布页格式异常：资源累计超过 512 KiB".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| crate::net::err_text(&e))? {
        append_publish_chunk(&mut body, &chunk, remaining)?;
    }
    String::from_utf8(body).map_err(|_| "地址发布页格式异常：资源不是 UTF-8 文本".into())
}

fn append_publish_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    remaining: &mut usize,
) -> Result<(), String> {
    if chunk.len() > *remaining {
        return Err("地址发布页格式异常：资源累计超过 512 KiB".into());
    }
    *remaining -= chunk.len();
    body.extend_from_slice(chunk);
    Ok(())
}

/// 首页探测只验证最低可消费结构；空站点仍可返回合法空列表。
fn valid_feed(data: &Value) -> bool {
    data.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().all(|item| {
                item.get("id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id > 0)
                    && item
                        .get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|title| !title.trim().is_empty())
            })
        })
}

/// 不接收脚本、路径、端口、IP 或凭据，只把 DNS 域名作为游客候选。
fn domain_host(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/');
    let host = raw
        .strip_prefix("https://")
        .unwrap_or(raw)
        .to_ascii_lowercase();
    if host.len() > 253 || !host.contains('.') || !host.split('.').all(valid_label) {
        return None;
    }
    let origin = format!("https://{host}");
    if !matches!(
        url::Url::parse(&origin).ok()?.host(),
        Some(url::Host::Domain(_))
    ) {
        return None;
    }
    crate::net::normalize_base(&origin)?;
    Some(host)
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn mirror_candidates(domains: &[String], subs: &[String]) -> Vec<Value> {
    let domains: Vec<_> = domains
        .iter()
        .filter_map(|domain| domain_host(domain))
        .collect();
    let subdomains: Vec<Option<&str>> = if subs.is_empty() {
        vec![None]
    } else {
        subs.iter()
            .map(String::as_str)
            .filter(|sub| valid_label(sub))
            .map(Some)
            .collect()
    };
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // 先覆盖各域名，再扩展子域；无效子域不能使候选退回到未发布的裸域名。
    'outer: for subdomain in subdomains {
        for domain in &domains {
            let host = match subdomain {
                Some(sub) => format!("{}.{}", sub.to_ascii_lowercase(), domain),
                None => domain.clone(),
            };
            if domain_host(&host).is_none() || !seen.insert(host.clone()) {
                continue;
            }
            items.push(json!({ "url": format!("https://{host}"), "host": host }));
            if items.len() == MIRROR_MAX {
                break 'outer;
            }
        }
    }
    items
}

fn probe_candidates(urls: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    urls.into_iter()
        .filter(|url| seen.insert(url.clone()))
        .take(MIRROR_MAX)
        .collect()
}

/// 只读发布页同源的 publish.js；不执行脚本，也不跟随第三方脚本声明。
fn publish_script_url(base: &str, rel: &str) -> Option<String> {
    let base = url::Url::parse(base).ok()?;
    let target = base.join(rel).ok()?;
    if target.origin() != base.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || target.path().rsplit('/').next()? != "publish.js"
    {
        return None;
    }
    Some(target.to_string())
}

/// 支持单/双引号、空格和属性顺序变化，只选 publish.js，跳过统计等其他脚本。
fn script_src(html: &str) -> Option<String> {
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        if rest.starts_with("!--") {
            let end = rest.find("-->")?;
            rest = &rest[end + 3..];
            continue;
        }
        let (tag, consumed) = html_tag(rest)?;
        rest = &rest[consumed..];
        let mut attrs = tag.trim().splitn(2, char::is_whitespace);
        if !attrs.next()?.eq_ignore_ascii_case("script") {
            continue;
        }
        let mut attrs = attrs.next().unwrap_or_default().trim();
        while !attrs.is_empty() {
            let end = attrs
                .find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(attrs.len());
            let name = &attrs[..end];
            attrs = attrs[end..].trim_start();
            if !attrs.starts_with('=') {
                if attrs.is_empty() {
                    break;
                }
                continue;
            }
            attrs = attrs[1..].trim_start();
            let (value, after) = if attrs.starts_with(['\'', '"']) {
                let quote = attrs.as_bytes()[0] as char;
                let end = attrs[1..].find(quote)? + 1;
                (&attrs[1..end], &attrs[end + 1..])
            } else {
                let end = attrs.find(char::is_whitespace).unwrap_or(attrs.len());
                (&attrs[..end], &attrs[end..])
            };
            attrs = after.trim_start();
            let value = value.replace("&amp;", "&");
            if name.eq_ignore_ascii_case("src")
                && publish_script_url(PUBLISH_PAGE, &value).is_some()
            {
                return Some(value);
            }
        }
    }
    None
}

fn html_tag(rest: &str) -> Option<(&str, usize)> {
    let mut quote = None;
    for (i, c) in rest.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
        } else if c == '>' {
            return Some((&rest[..i], i + 1));
        }
    }
    None
}

#[derive(Debug, PartialEq)]
enum JsToken<'a> {
    Word(&'a str),
    Text(String),
    Punct(char),
}

/// 小型词法读取器：只识别字符串字面量，不求值变量、调用或其他远端代码。
fn js_token<'a>(rest: &mut &'a str) -> Option<JsToken<'a>> {
    loop {
        *rest = rest.trim_start();
        if rest.starts_with("//") {
            *rest = rest.find('\n').map(|at| &rest[at + 1..]).unwrap_or("");
        } else if rest.starts_with("/*") {
            *rest = &rest[rest.find("*/")? + 2..];
        } else {
            break;
        }
    }
    let first = rest.chars().next()?;
    if first == '\'' || first == '"' {
        let mut text = String::new();
        let mut escaped = false;
        for (i, c) in rest[1..].char_indices() {
            if escaped {
                if !matches!(c, '\\' | '\'' | '"' | '/') {
                    return None;
                }
                text.push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == first {
                *rest = &rest[i + 2..];
                return Some(JsToken::Text(text));
            } else {
                text.push(c);
            }
            if text.len() > JS_STRING_BYTES_MAX {
                return None;
            }
        }
        return None;
    }
    if first.is_ascii_alphabetic() || first == '_' || first == '$' {
        let end = rest
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$')
            .unwrap_or(rest.len());
        let word = &rest[..end];
        *rest = &rest[end..];
        return Some(JsToken::Word(word));
    }
    *rest = &rest[first.len_utf8()..];
    Some(JsToken::Punct(first))
}

/// 支持 var/let/const 和注释；数组只接受字符串，不执行发布页 JS。
fn js_array(src: &str, name: &str) -> Option<Vec<String>> {
    // 先检查完整词法流，不能把反引号模板里的声明当成真实数组。
    // 模板、正则和除法不在发布格式内，整体报错；字符串和注释里的符号无影响。
    let mut checked = src;
    while !checked.trim().is_empty() {
        match js_token(&mut checked) {
            Some(JsToken::Punct('`' | '/')) => return None,
            Some(_) => {}
            None if checked.trim().is_empty() => break,
            None => return None,
        }
    }
    let mut rest = src;
    while let Some(token) = js_token(&mut rest) {
        if !matches!(token, JsToken::Word("var" | "let" | "const")) {
            continue;
        }
        if js_token(&mut rest) != Some(JsToken::Word(name))
            || js_token(&mut rest) != Some(JsToken::Punct('='))
            || js_token(&mut rest) != Some(JsToken::Punct('['))
        {
            continue;
        }
        let mut items = Vec::new();
        loop {
            match js_token(&mut rest) {
                Some(JsToken::Punct(']')) => return Some(items),
                Some(JsToken::Text(value)) => {
                    if items.len() == JS_ARRAY_MAX {
                        return None;
                    }
                    items.push(value);
                    match js_token(&mut rest) {
                        Some(JsToken::Punct(']')) => return Some(items),
                        Some(JsToken::Punct(',')) => {}
                        _ => return None,
                    }
                }
                _ => return None,
            }
        }
    }
    Some(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_use_current_guest_candidates() {
        let fixed = fixed();
        assert_eq!(fixed[0]["supports_login"], true);
        assert_eq!(fixed[1]["supports_login"], false);
        assert_eq!(
            FIXED.map(|(_, url)| url),
            ["https://huangguoai.com", "https://huangguoai.io"]
        );
    }

    #[test]
    fn parses_only_literal_arrays_without_executing_js() {
        let src = r#"// var urls = ['wrong.example'];
            const urls = ["a.example/", /* comment */ 'b.example',];
            let subdomains = ['thu', 'pku'];"#;
        assert_eq!(js_array(src, "urls").unwrap(), ["a.example/", "b.example"]);
        assert_eq!(js_array(src, "subdomains").unwrap(), ["thu", "pku"]);
        assert!(js_array("var urls = [location.host, 'a.example'];", "urls").is_none());
        assert!(js_array("var urls = ['a.example' + '.invalid'];", "urls").is_none());
        assert_eq!(
            js_array(r#"var urls = ['https:\/\/a.example'];"#, "urls").unwrap(),
            ["https://a.example"]
        );
    }

    #[test]
    fn shares_publish_byte_budget_without_partial_success() {
        let mut remaining = PUBLISH_BYTES_MAX;
        let mut html = Vec::new();
        append_publish_chunk(&mut html, b"<html></html>", &mut remaining).unwrap();
        let mut js = Vec::new();
        let last = vec![b' '; remaining];
        append_publish_chunk(&mut js, &last, &mut remaining).unwrap();
        assert_eq!(remaining, 0);
        let before = js.len();
        let error = append_publish_chunk(&mut js, b"x", &mut remaining).unwrap_err();
        assert!(error.contains("512 KiB"));
        assert_eq!(js.len(), before);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn rejects_oversized_arrays_and_strings_without_truncating() {
        let at_limit = format!(
            "var urls = [{}];",
            vec!["'a.example'"; JS_ARRAY_MAX].join(",")
        );
        assert_eq!(js_array(&at_limit, "urls").unwrap().len(), JS_ARRAY_MAX);
        let over_limit = format!(
            "var urls = [{}];",
            vec!["'a.example'"; JS_ARRAY_MAX + 1].join(",")
        );
        assert!(js_array(&over_limit, "urls").is_none());
        let at_string_limit = format!("var urls = ['{}'];", "a".repeat(JS_STRING_BYTES_MAX));
        assert_eq!(
            js_array(&at_string_limit, "urls").unwrap()[0].len(),
            JS_STRING_BYTES_MAX
        );
        let over_string_limit = format!("var urls = ['{}'];", "a".repeat(JS_STRING_BYTES_MAX + 1));
        assert!(js_array(&over_string_limit, "urls").is_none());
        let multibyte = format!(
            "var urls = ['{}'];",
            "中".repeat(JS_STRING_BYTES_MAX / 3 + 1)
        );
        assert!(js_array(&multibyte, "urls").is_none());
    }

    #[test]
    fn rejects_templates_instead_of_reading_their_fake_declarations() {
        for src in [
            "const text = `var urls = ['wrong.example'];`;",
            r"const text = `escaped \` var urls = ['wrong.example'];`;",
            "const text = `${(() => { var urls = ['wrong.example']; })()}`;",
            "var urls = ['real.example']; const text = `unsupported`;",
            "const text = `unterminated var urls = ['wrong.example'];",
        ] {
            assert!(js_array(src, "urls").is_none());
        }
        assert_eq!(
            js_array("/* `template` */ var urls = ['a.example']; // `", "urls").unwrap(),
            ["a.example"]
        );
        assert_eq!(
            js_array("const text = '`'; var urls = ['a.example'];", "urls").unwrap(),
            ["a.example"]
        );
    }

    #[test]
    fn rejects_bare_slashes_without_reading_regexp_contents() {
        assert!(js_array(
            "var banner=/var urls=['wrong.example']/; const urls=['right.example'];",
            "urls"
        )
        .is_none());
        assert!(js_array("const ratio=4/2; const urls=['right.example'];", "urls").is_none());
        assert_eq!(
            js_array(
                "/* / */ const urls=['https://right.example/']; // /",
                "urls"
            )
            .unwrap(),
            ["https://right.example/"]
        );
    }

    #[test]
    fn selects_only_same_origin_publish_script() {
        let html = r#"<!-- <script src='publish.js?ignored'></script> -->
            <script src="analytics.js"></script><SCRIPT defer SRC = 'scripts/publish.js?v=1&amp;x=2'></SCRIPT>"#;
        assert_eq!(
            script_src(html).as_deref(),
            Some("scripts/publish.js?v=1&x=2")
        );
        assert_eq!(
            publish_script_url(PUBLISH_PAGE, "scripts/publish.js").as_deref(),
            Some("https://huangguoai.pages.dev/scripts/publish.js")
        );
        for target in [
            "//other.example/publish.js",
            "http://huangguoai.pages.dev/publish.js",
            "https://user@huangguoai.pages.dev/publish.js",
            "publish.js#fragment",
            "other.js",
        ] {
            assert!(publish_script_url(PUBLISH_PAGE, target).is_none());
        }
    }

    #[test]
    fn validates_candidates_and_preserves_domain_coverage() {
        let domains = vec![
            "A.example/",
            "https://b.example",
            "a.example",
            "https://user@bad.example",
            "a.example/path",
            "a.example?x=1",
            "127.0.0.1",
            "localhost",
            "x..example",
        ];
        let domains: Vec<_> = domains.into_iter().map(str::to_string).collect();
        let subs = vec!["thu".into(), "pku".into(), "bad/path".into()];
        let items = mirror_candidates(&domains, &subs);
        assert_eq!(
            items
                .iter()
                .map(|v| v["host"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "thu.a.example",
                "thu.b.example",
                "pku.a.example",
                "pku.b.example"
            ]
        );
        assert!(mirror_candidates(&["a.example".into()], &["bad/path".into()]).is_empty());
        assert_eq!(
            mirror_candidates(&["a.example/".into()], &[])[0]["host"],
            "a.example"
        );
    }

    #[test]
    fn bounds_candidates_and_manual_probe_work() {
        let domains: Vec<_> = (0..80).map(|n| format!("d{n}.example")).collect();
        let items = mirror_candidates(&domains, &["one".into(), "two".into()]);
        assert_eq!(items.len(), MIRROR_MAX);
        assert_eq!(items[59]["host"], "one.d59.example");
        let mut urls: Vec<_> = (0..80).map(|n| format!("https://d{n}.example")).collect();
        urls.insert(1, urls[0].clone());
        let candidates = probe_candidates(urls);
        assert_eq!(candidates.len(), MIRROR_MAX);
        assert_eq!(candidates[59], "https://d59.example");
    }

    #[test]
    fn accepts_empty_feed_but_rejects_unusable_items() {
        assert!(valid_feed(&json!({"items": []})));
        assert!(valid_feed(&json!({"items": [{"id": 1, "title": "测试"}]})));
        for bad in [
            json!({}),
            json!({"items": {}}),
            json!({"items": [null]}),
            json!({"items": [{}]}),
            json!({"items": [{"id": 0, "title": "测试"}]}),
            json!({"items": [{"id": 1, "title": " "}]}),
            json!({"items": [{"id": "1", "title": "测试"}]}),
        ] {
            assert!(!valid_feed(&bad));
        }
    }
    #[tokio::test]
    #[ignore = "联网测试：手动验证当前发布页解析"]
    async fn mirrors_live() {
        let value = mirrors().await.expect("published mirror catalog");
        let items = value["items"].as_array().expect("items");
        assert!(!items.is_empty() && items.len() <= MIRROR_MAX);
        println!("published mirror candidates: {}", items.len());
    }

    #[tokio::test]
    #[ignore = "联网测试：手动验证两个内置游客首页接口"]
    async fn probe_live() {
        let value = probe(FIXED.iter().map(|(_, origin)| origin.to_string()).collect()).await;
        let results = value.as_array().expect("results");
        assert_eq!(results.len(), FIXED.len());
        for result in results {
            println!(
                "builtin guest probe: ok={}, status={}",
                result["ok"], result["status"]
            );
            assert_eq!(result["ok"], true);
        }
    }
}
