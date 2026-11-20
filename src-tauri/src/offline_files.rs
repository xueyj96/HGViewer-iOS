//! Cache file identity and the atomic metadata switch. Never remove the old media first.
use super::Episode;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "ios")]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Access {
    pub readers: BTreeMap<(i64, u32), usize>,
    pub converting: BTreeSet<(i64, u32)>,
    #[cfg(target_os = "ios")]
    pub migration_running: bool,
    #[cfg(target_os = "ios")]
    pub restart_requested: bool,
}
pub(crate) struct ReadLease {
    state: Arc<Mutex<Access>>,
    key: (i64, u32),
}
impl ReadLease {
    pub(super) fn new(state: &Arc<Mutex<Access>>, id: i64, ep: u32) -> Self {
        *state.lock().unwrap().readers.entry((id, ep)).or_default() += 1;
        Self {
            state: state.clone(),
            key: (id, ep),
        }
    }
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        if let Some(count) = state.readers.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                state.readers.remove(&self.key);
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Ready {
    pub id: i64,
    pub ep: u32,
    pub title: String,
    pub bytes: u64,
    pub mp4: bool,
    pub filename: String,
    // Watch keys are process-local and reused after restart; never persist them.
    #[serde(skip)]
    pub watch_key: Option<u64>,
}
const READY: &str = ".single-file-ready.json";

pub(super) fn valid_basename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        && name.ends_with(".mp4")
}
pub(super) fn filename(title: &str, ep: u32, timestamp: u64) -> String {
    let title = title
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect::<String>();
    let title = title.trim().trim_matches('.');
    let mut safe = String::new();
    for c in title.chars() {
        if safe.len() + c.len_utf8() > 160 {
            break;
        }
        safe.push(c);
    }
    if safe.is_empty() {
        safe.push_str("未命名剧集");
    }
    format!("{safe}_第{ep}集_{timestamp}.mp4")
}
#[cfg(target_os = "ios")]
pub(super) fn timestamp(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or_else(|_| SystemTime::now())
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub(super) fn read_ready(stage: &Path, id: i64, ep: Option<u32>) -> Option<Ready> {
    let ready: Ready = serde_json::from_slice(&std::fs::read(stage.join(READY)).ok()?).ok()?;
    (ready.id == id
        && ready.ep > 0
        && ep.is_none_or(|ep| ep == ready.ep)
        && valid_basename(&ready.filename))
    .then_some(ready)
}
pub(super) fn persist_ready(stage: &Path, ready: &Ready) -> std::io::Result<()> {
    if !valid_basename(&ready.filename) {
        return Err(std::io::Error::other("Invalid cached filename"));
    }
    atomic_json(stage, READY, ready)
}
pub(super) fn atomic_json<T: Serialize>(
    directory: &Path,
    name: &str,
    value: &T,
) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = directory.join(format!("{name}.tmp"));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec(value)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, directory.join(name))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}
impl Episode {
    pub(super) fn media_path(&self, directory: &Path) -> Option<PathBuf> {
        let name = match self.media_file.as_deref() {
            Some(name) if self.mp4 && valid_basename(name) => name,
            Some(_) => return None,
            None if self.mp4 => "video.mp4",
            None => "index.m3u8",
        };
        Some(directory.join(name))
    }
}
/// Called only after new metadata points to a validated single file and no legacy reader exists.
pub(super) fn cleanup_legacy(directory: &Path, episode: &Episode) -> std::io::Result<()> {
    let Some(keep) = episode.media_file.as_deref().filter(|n| valid_basename(n)) else {
        return Ok(());
    };
    if !episode.mp4 || !directory.join(keep).is_file() {
        return Err(std::io::Error::other("No committed single file"));
    }
    cleanup_remux_temps(directory, keep)?;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let numeric = name.split_once('.').is_some_and(|(number, ext)| {
            number.parse::<u32>().is_ok() && matches!(ext, "ts" | "mp4")
        });
        if name != keep && (name == "index.m3u8" || name == "video.mp4" || name == READY || numeric)
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Caller holds this episode's conversion ownership; only remove this output's mkstemp remnants.
pub(super) fn cleanup_remux_temps(directory: &Path, filename: &str) -> std::io::Result<()> {
    if !valid_basename(filename) {
        return Err(std::io::Error::other("Invalid cached filename"));
    }
    let prefix = format!("{filename}.hgremux-");
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let owned = name.strip_prefix(&prefix).is_some_and(|suffix| {
            suffix.len() == 6 && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
        });
        if owned && entry.file_type()?.is_file() {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "hg-single-file-{}-{}",
            std::process::id(),
            super::super::diagnostics::worker_id()
        ));
        std::fs::create_dir(&d).unwrap();
        d
    }
    fn episode() -> Episode {
        Episode {
            id: 1,
            ep: 2,
            title: "测试剧".into(),
            bytes: 5,
            mp4: false,
            media_file: None,
        }
    }
    #[test]
    fn filename_is_safe_bounded_and_stable() {
        let name = filename("../../剧/集\\名:\n", 2, 123);
        assert_eq!(name, "剧集名_第2集_123.mp4");
        assert!(valid_basename(&filename(&"长".repeat(300), 2, 123)));
        for s in ["../a.mp4", "/a.mp4", "a\\b.mp4", "x\0.mp4", ".hidden.mp4"] {
            assert!(!valid_basename(s));
        }
    }
    #[test]
    fn old_metadata_uses_old_media_and_rejects_external_path() {
        let mut e = episode();
        let d = Path::new("/cache/1-2");
        assert_eq!(e.media_path(d).unwrap(), d.join("index.m3u8"));
        e.mp4 = true;
        assert_eq!(e.media_path(d).unwrap(), d.join("video.mp4"));
        e.media_file = Some("../escape.mp4".into());
        assert!(e.media_path(d).is_none());
    }
    #[test]
    fn ready_reopens_same_name_without_network_or_new_timestamp() {
        let d = dir();
        let r = Ready {
            id: 1,
            ep: 2,
            title: "测试".into(),
            bytes: 5,
            mp4: false,
            filename: filename("测试", 2, 99),
            watch_key: Some(1),
        };
        persist_ready(&d, &r).unwrap();
        assert_eq!(read_ready(&d, 1, Some(2)).unwrap().filename, r.filename);
        assert!(read_ready(&d, 1, Some(2)).unwrap().watch_key.is_none());
        assert!(read_ready(&d, 2, None).is_none());
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn source_cleanup_requires_metadata_switch_and_preserves_final_file() {
        let d = dir();
        std::fs::write(d.join("index.m3u8"), "original").unwrap();
        std::fs::write(d.join("0.ts"), "source").unwrap();
        let mut e = episode();
        cleanup_legacy(&d, &e).unwrap();
        assert!(d.join("0.ts").exists());
        e.mp4 = true;
        e.media_file = Some(filename("剧", 2, 1));
        assert!(cleanup_legacy(&d, &e).is_err());
        std::fs::write(e.media_path(&d).unwrap(), "complete").unwrap();
        atomic_json(&d, "info.json", &e).unwrap();
        cleanup_legacy(&d, &e).unwrap();
        assert!(!d.join("0.ts").exists() && !d.join("index.m3u8").exists());
        assert_eq!(
            std::fs::read(e.media_path(&d).unwrap()).unwrap(),
            b"complete"
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn read_leases_block_conversion_commit_until_last_reader_releases() {
        let state = Arc::new(Mutex::new(Access::default()));
        let a = ReadLease::new(&state, 1, 2);
        let b = ReadLease::new(&state, 1, 2);
        drop(a);
        assert_eq!(state.lock().unwrap().readers.get(&(1, 2)), Some(&1));
        drop(b);
        assert!(!state.lock().unwrap().readers.contains_key(&(1, 2)));
    }
    #[test]
    fn interrupted_private_output_cleanup_is_scoped_to_this_filename() {
        let d = dir();
        let name = filename("剧", 2, 1);
        let own = d.join(format!("{name}.hgremux-Ab12CD"));
        let other = d.join("other.mp4.hgremux-Ab12CD");
        std::fs::write(&own, b"partial").unwrap();
        std::fs::write(&other, b"keep").unwrap();
        cleanup_remux_temps(&d, &name).unwrap();
        assert!(!own.exists());
        assert!(other.exists());
        std::fs::remove_dir_all(d).unwrap();
    }
}
