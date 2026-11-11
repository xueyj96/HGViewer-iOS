mod api;
#[cfg(target_os = "ios")]
mod ios_cover_menu;
#[cfg(target_os = "ios")]
mod ios_download_background;
#[cfg(target_os = "ios")]
mod ios_media;
#[cfg(target_os = "ios")]
mod ios_orientation;
#[cfg(target_os = "ios")]
mod ios_player;
#[cfg(target_os = "ios")]
mod ios_symbols;
mod lines;
mod media;
mod net;
mod network_policy;
mod offline;
mod session;
mod watch;

use api::Api;
use tauri::Manager;

fn allowed_dev_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }
    if let Some(configured) = option_env!("TAURI_DEV_HOST") {
        if host.eq_ignore_ascii_case(configured.trim()) {
            return true;
        }
    }
    std::env::var("TAURI_DEV_HOST")
        .ok()
        .is_some_and(|v| host.eq_ignore_ascii_case(v.trim()))
}

fn allowed_frontend_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    // 移动端开发可能使用 TAURI_DEV_HOST；严格模式下仅放行本机或显式配置的 TAURI_DEV_HOST。
    cfg!(debug_assertions)
        && url::Url::parse(origin).is_ok_and(|u| {
            u.scheme() == "http"
                && u.port() == Some(1420)
                && (!network_policy::strict_security()
                    || u.host_str().is_some_and(allowed_dev_host))
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "ios")]
    ios_download_background::register_launch_handler();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Api::new())
        .manage(offline::Cache::default())
        .setup(|app| {
            #[cfg(target_os = "ios")]
            app.manage(ios_media::Sessions::default());
            #[cfg(target_os = "ios")]
            ios_download_background::bind(app.handle());
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                // 上次选择的线路（设置 → 线路）在启动时恢复
                net::bind_base(&dir);
                let state: tauri::State<Api> = app.state();
                state.session.bind(dir);
            }
            if let Ok(dir) = app.path().app_cache_dir() {
                watch::bind(dir.join("recent-playback"));
                let offline_root = dir.join("offline-videos");
                #[cfg(target_os = "ios")]
                let offline_root = match app.path().app_local_data_dir() {
                    Ok(data) => offline::saved_root(offline_root, &data),
                    Err(_) => offline_root,
                };
                app.state::<offline::Cache>().bind(offline_root);
                #[cfg(not(target_os = "ios"))]
                offline::fill_slots(app.handle());
            }
            Ok(())
        })
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-guard")
                .on_navigation(|_webview, url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || allowed_frontend_origin(&url.origin().ascii_serialization())
                        || (!network_policy::strict_security()
                            && matches!(url.scheme(), "http" | "https"))
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("hg", |context, request, responder| {
            let request_origin = request
                .headers()
                .get("Origin")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if network_policy::strict_security()
                && request_origin
                    .as_deref()
                    .is_some_and(|origin| !allowed_frontend_origin(origin))
            {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(b"origin denied".to_vec())
                        .unwrap(),
                );
                return;
            }
            let app = context.app_handle().clone();
            let range = request
                .headers()
                .get("Range")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let uri = request.uri().clone();
            let path = uri.path().to_string();
            let query = uri.query().unwrap_or("").to_string();
            // 自定义协议基址随平台不同，统一定义在 media::LOCAL_ORIGIN
            // （Windows/Android 是 http://<scheme>.localhost，macOS/iOS/Linux 是 <scheme>://localhost）。
            // 它同时是 m3u8 分片/key 改写用的前缀，必须与前端 src/api.ts 的 LOCAL 一致。
            tauri::async_runtime::spawn(async move {
                let mut resp = if path.starts_with("/offline/") {
                    offline::serve(&app.state::<offline::Cache>(), &path, range.as_deref()).await
                } else if path.starts_with("/watch/") {
                    watch::serve(&path, &query, media::LOCAL_ORIGIN).await
                } else {
                    media::handle(&path, &query, media::LOCAL_ORIGIN).await
                };
                if let Some(origin) =
                    request_origin.and_then(|s| tauri::http::HeaderValue::from_str(&s).ok())
                {
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", origin);
                    resp.headers_mut()
                        .insert("Vary", tauri::http::HeaderValue::from_static("Origin"));
                }
                responder.respond(resp);
            });
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "ios")]
            ios_orientation::set_ios_orientation,
            #[cfg(target_os = "ios")]
            ios_orientation::set_ios_status_bar_hidden,
            #[cfg(target_os = "ios")]
            ios_orientation::ios_horizontal_safe_area,
            #[cfg(target_os = "ios")]
            ios_cover_menu::ios_cover_menu_update,
            #[cfg(target_os = "ios")]
            ios_player::ios_player_open,
            #[cfg(target_os = "ios")]
            ios_player::ios_player_preload,
            #[cfg(target_os = "ios")]
            ios_player::ios_player_control,
            #[cfg(target_os = "ios")]
            ios_player::ios_player_frame,
            #[cfg(target_os = "ios")]
            ios_symbols::settings_symbols,
            api::app_boot,
            api::security_set,
            api::debug_log,
            api::net_diag,
            api::line_state,
            api::line_set,
            api::line_mirrors,
            api::line_probe,
            api::check_update,
            api::open_url,
            api::api_login,
            api::api_register,
            api::api_logout,
            api::api_me,
            api::api_feed,
            api::api_category,
            api::api_rank,
            api::api_search,
            api::cache_clear,
            watch::watch_begin,
            watch::watch_details,
            offline::watch_save,
            offline::watch_discard,
            offline::offline_status,
            offline::offline_episode,
            offline::offline_refresh_show,
            offline::offline_start,
            offline::offline_stop,
            offline::offline_pause,
            offline::offline_cancel,
            offline::offline_resume,
            offline::offline_delete,
            offline::offline_download_settings,
            offline::offline_background_start,
            api::api_posts,
            api::api_post,
            api::api_post_like,
            api::api_post_collect,
            api::api_post_comments,
            api::api_video,
            api::api_play,
            api::api_comments,
            api::api_comment_send,
            api::api_like,
            api::api_collect,
            api::api_follow,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
