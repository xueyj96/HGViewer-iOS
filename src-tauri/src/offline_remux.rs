//! One local, lossless remux at a time. The native worker retains its handle and permit until joined.
use std::{
    ffi::{c_char, c_int, c_void, CString},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
static REMUX: Semaphore = Semaphore::const_new(1);
unsafe extern "C" {
    fn hg_remux_job_create() -> *mut c_void;
    fn hg_remux_job_cancel(job: *mut c_void);
    fn hg_remux_job_destroy(job: *mut c_void);
    fn hg_remux_run(job: *mut c_void, input: *const c_char, output: *const c_char) -> c_int;
    fn hg_remux_validate(job: *mut c_void, input: *const c_char) -> c_int;
    fn hg_remux_job_progress(job: *const c_void) -> u32;
}
struct Engine(*mut c_void);
// C job permits one run thread, atomic cancel/progress from another; lifetime is retained by Arc.
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { hg_remux_job_destroy(self.0) }
    }
}
struct CancelOnDrop(Arc<Engine>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        unsafe { hg_remux_job_cancel(self.0 .0) }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Error {
    Cancelled,
    Unsupported,
    Storage,
    Invalid,
    Internal,
}
impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::Cancelled => "合成已暂停",
            Self::Unsupported => "这集暂不支持合成，原分片已保留",
            Self::Storage => "合成存储失败，原分片已保留",
            Self::Invalid => "合成校验失败，原分片已保留",
            Self::Internal => "合成未完成，原分片已保留",
        }
    }
}
pub(super) async fn convert(
    input: &Path,
    output: &Path,
    validate: bool,
    stop: impl Fn() -> bool,
    progress: impl Fn(u32),
) -> Result<(), Error> {
    let permit = loop {
        tokio::select! {p=REMUX.acquire()=>break p.map_err(|_|Error::Internal)?,_=tokio::time::sleep(Duration::from_millis(100))=>if stop(){return Err(Error::Cancelled)}}
    };
    if stop() {
        return Err(Error::Cancelled);
    }
    let input = CString::new(input.to_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)?;
    let output =
        CString::new(output.to_str().ok_or(Error::Storage)?).map_err(|_| Error::Storage)?;
    let pointer = unsafe { hg_remux_job_create() };
    if pointer.is_null() {
        return Err(Error::Internal);
    }
    let engine = Arc::new(Engine(pointer));
    let _cancel = CancelOnDrop(engine.clone());
    let worker = engine.clone();
    let mut task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        unsafe {
            if validate {
                hg_remux_validate(worker.0, input.as_ptr())
            } else {
                hg_remux_run(worker.0, input.as_ptr(), output.as_ptr())
            }
        }
    });
    let result = loop {
        tokio::select! {r=&mut task=>break r.map_err(|_|Error::Internal)?,_=tokio::time::sleep(Duration::from_millis(100))=>{if stop(){unsafe{hg_remux_job_cancel(engine.0)}}progress(unsafe{hg_remux_job_progress(engine.0)});}}
    };
    match result {
        0 => {
            progress(10000);
            Ok(())
        }
        1 => Err(Error::Cancelled),
        2 => Err(Error::Unsupported),
        3 => Err(Error::Storage),
        4 | 6 => Err(Error::Invalid),
        _ => Err(Error::Internal),
    }
}
