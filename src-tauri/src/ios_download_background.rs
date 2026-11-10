use crate::offline::BackgroundSnapshot;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
    fn hg_request_background_download();
    fn hg_observe_download_foreground();
    fn hg_download_status() -> std::ffi::c_int;
}

pub fn bind(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        unsafe { hg_observe_download_foreground() };
    }
}

pub fn request() {
    unsafe { hg_request_background_download() };
}

pub fn status() -> &'static str {
    match unsafe { hg_download_status() } {
        1 => "idle",
        2 => "waiting",
        3 => "running",
        4 => "unavailable",
        5 => "expired",
        _ => "unsupported",
    }
}

#[no_mangle]
extern "C" fn hg_download_snapshot(out: *mut BackgroundSnapshot) {
    if let Some(out) = unsafe { out.as_mut() } {
        *out = APP.get().map_or_else(BackgroundSnapshot::default, |app| {
            crate::offline::background_snapshot(&app.state::<crate::offline::Cache>())
        });
    }
}

#[no_mangle]
extern "C" fn hg_download_expired() {
    if let Some(app) = APP.get() {
        crate::offline::pause_background(&app.state::<crate::offline::Cache>());
    }
}

#[no_mangle]
extern "C" fn hg_download_foreground() {
    if let Some(app) = APP.get() {
        crate::offline::resume_foreground(app);
    }
}
