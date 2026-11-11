use crate::offline::BackgroundSnapshot;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
    fn hg_register_download_launch();
    fn hg_request_background_download();
    fn hg_refresh_download_background_policy();
    fn hg_observe_download_foreground();
    fn hg_download_status() -> std::ffi::c_int;
}

pub fn register_launch_handler() {
    unsafe { hg_register_download_launch() };
}

pub fn bind(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        unsafe { hg_observe_download_foreground() };
    }
}

pub fn request() {
    unsafe { hg_request_background_download() };
}

pub fn refresh_policy() {
    unsafe { hg_refresh_download_background_policy() };
}

#[no_mangle]
extern "C" fn hg_download_background_allowed() -> std::ffi::c_int {
    i32::from(APP.get().is_some_and(|app| {
        crate::offline::background_allowed(&app.state::<crate::offline::Cache>())
    }))
}

#[no_mangle]
extern "C" fn hg_download_enter_background() {
    if let Some(app) = APP.get() {
        crate::offline::enter_background(&app.state::<crate::offline::Cache>());
    }
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
extern "C" fn hg_download_expired(recover: std::ffi::c_int) {
    if let Some(app) = APP.get() {
        crate::offline::pause_background(&app.state::<crate::offline::Cache>(), recover != 0);
    }
}

#[no_mangle]
extern "C" fn hg_download_foreground() {
    if let Some(app) = APP.get() {
        crate::offline::resume_foreground(app);
    }
}

#[no_mangle]
extern "C" fn hg_download_has_background_work() -> std::ffi::c_int {
    i32::from(APP.get().is_some_and(|app| {
        crate::offline::has_background_work(&app.state::<crate::offline::Cache>())
    }))
}

#[no_mangle]
extern "C" fn hg_download_resume_background() -> std::ffi::c_int {
    i32::from(APP.get().is_some_and(crate::offline::resume_background))
}

#[no_mangle]
extern "C" fn hg_download_log(event: std::ffi::c_int, code: i64) {
    let (name, detail) = match event {
        1 => ("background_registered", None),
        2 => ("background_registration_failed", None),
        3 => ("background_submission_failed", Some(code)),
        4 => ("background_running", None),
        5 => ("background_expired_active", None),
        6 => ("background_expired_inactive", None),
        7 if code == 1 => ("background_finished", None),
        7 => ("background_failed", None),
        8 => ("background_recovery_scheduled", None),
        9 => ("background_recovery_submission_failed", Some(code)),
        10 => ("background_recovery_expired", None),
        11 => ("background_recovery_finished", None),
        12 => ("background_paused", None),
        _ => return,
    };
    if let Some(app) = APP.get() {
        crate::offline::log_background(&app.state::<crate::offline::Cache>(), name, detail);
    }
}
