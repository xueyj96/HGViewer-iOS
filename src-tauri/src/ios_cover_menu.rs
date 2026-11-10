use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void, CString};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DownloadAction {
    PauseDownload,
    ResumeDownload,
    DownloadRemaining,
    StopSaving,
    ViewEpisodes,
    AllCached,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BrowseKind {
    Video,
    Post,
}

#[derive(Deserialize, Serialize)]
struct Preview {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
}

#[derive(Deserialize, Serialize)]
pub struct Cover {
    id: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    can_cache: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<Preview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browse_kind: Option<BrowseKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ep: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_action: Option<DownloadAction>,
    #[serde(default)]
    download_blocked: bool,
}

extern "C" {
    fn hg_cover_menu_update(web: *mut c_void, revision: u64, history: bool, covers: *const c_char);
}

#[tauri::command]
pub fn ios_cover_menu_update(
    webview: tauri::Webview,
    revision: u64,
    history: bool,
    covers: Vec<Cover>,
) -> Result<(), String> {
    let limit = if covers
        .iter()
        .all(|cover| cover.ep.is_some() || cover.download_action.is_some() || cover.browse_kind.is_some())
    {
        128
    } else {
        12
    };
    if covers.len() > limit
        || covers.iter().any(|cover| {
            cover.id == 0
                || cover.id > 9_007_199_254_740_991
                || ![cover.x, cover.y, cover.width, cover.height]
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 10_000.0)
                || cover.width <= 0.0
                || cover.height <= 0.0
                || cover.preview.as_ref().is_some_and(|preview| {
                    ![preview.x, preview.y, preview.width, preview.height, preview.radius]
                        .iter()
                        .all(|value| value.is_finite() && value.abs() <= 10_000.0)
                        || preview.width <= 0.0
                        || preview.height <= 0.0
                        || preview.radius < 0.0
                })
        })
    {
        return Err("无效的剧集菜单位置".into());
    }
    let covers = CString::new(serde_json::to_vec(&covers).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    webview
        .with_webview(move |view| unsafe {
            hg_cover_menu_update(view.inner(), revision, history, covers.as_ptr());
        })
        .map_err(|_| "剧集菜单不可用".into())
}
