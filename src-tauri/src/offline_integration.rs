//! Explicit simulator-only integration executable. No test-only copy of the storage implementation.
use super::*;
use crate::ios_media::Sessions;
fn directory() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hg-storage-integration-{}-{}",
        std::process::id(),
        diagnostics::worker_id()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn copy_fixture(source: &Path, dest: &Path) {
    std::fs::create_dir_all(dest).unwrap();
    for e in std::fs::read_dir(source).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let owned = name == "index.m3u8"
            || name
                .split_once('.')
                .is_some_and(|(n, ext)| n.parse::<u32>().is_ok() && matches!(ext, "ts" | "mp4"));
        if owned && e.file_type().unwrap().is_file() {
            std::fs::copy(e.path(), dest.join(e.file_name())).unwrap();
        }
    }
}
fn legacy(root: &Path, fixture: &Path) -> (Episode, PathBuf) {
    let d = path(root, 81, 1);
    copy_fixture(fixture, &d);
    let e = Episode {
        id: 81,
        ep: 1,
        title: "Fixture".into(),
        bytes: 1,
        mp4: false,
        media_file: None,
    };
    files::atomic_json(&d, "info.json", &e).unwrap();
    (e, d)
}
pub async fn run(fixture: &Path) -> serde_json::Value {
    assert!(fixture.is_absolute() && fixture.join("index.m3u8").is_file());
    let mut checks = Vec::new();
    let root = directory();
    let stage = stage_path(&root, 71);
    let package = stage.join(HLS_PACKAGE);
    copy_fixture(fixture, &package);
    let ready = files::Ready {
        id: 71,
        ep: 1,
        title: "Fixture".into(),
        bytes: 1,
        mp4: false,
        filename: files::filename("Fixture", 1, 123),
        watch_key: None,
    };
    files::persist_ready(&stage, &ready).unwrap();
    std::fs::write(stage.join(STAGED_EPISODE), "1").unwrap();
    Pending {
        entries: vec![Entry::new(
            71,
            "Fixture".into(),
            Some(BTreeSet::from([1])),
            None,
        )],
        ..Default::default()
    }
    .persist(&root)
    .unwrap();
    let cache = Cache::default();
    cache.bind(root.clone());
    assert!(package.join("index.m3u8").exists());
    checks.push("ready survives cold bind without network");
    let job = Mutex::new(Job::default());
    let e = finalize::package(&job, &stage, &ready).await.unwrap();
    assert!(e.mp4 && package.join("index.m3u8").exists());
    checks.push("verified MP4 publication retains source before commit");
    let cache = Cache::default();
    cache.bind(root.clone());
    assert!(package.join(&ready.filename).is_file());
    commit_ready(&job, &root, &stage, &ready).await.unwrap();
    let dest = path(&root, 71, 1);
    let e = read_episode(&root, &dest).unwrap();
    assert!(e.mp4 && e.media_file == Some(ready.filename.clone()));
    assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 2);
    assert!(!stage.exists());
    checks.push("output validation recovery then atomic commit cleans obsolete fragments");
    let response = serve(&cache, "/offline/71/1/video.mp4", Some("bytes=0-7")).await;
    assert_eq!(response.status(), 206);
    assert_eq!(response.body().get(4..8), Some(b"ftyp".as_slice()));
    checks.push("logical playback alias resolves renamed MP4");
    // Persistent session, stale token, replacement and close use the actual native session owner.
    let sessions = Sessions::default();
    assert!(sessions.reserve(1));
    {
        let (_, reader) = cache.open_episode(71, 1).unwrap();
        assert!(sessions.keep(1, None, Some(reader), None));
    }
    assert_eq!(cache.test_reader_count(71, 1), 1);
    assert!(delete_cached(&cache, 71, Some(1)).is_err());
    checks.push("open return retains reader and blocks deletion");
    assert!(sessions.reserve(2));
    assert_eq!(cache.test_reader_count(71, 1), 1);
    let (_, reader) = cache.open_episode(71, 1).unwrap();
    assert!(sessions.keep(2, None, Some(reader), None));
    sessions.opened(2);
    assert_eq!(cache.test_reader_count(71, 1), 1);
    sessions.close(1);
    assert_eq!(cache.test_reader_count(71, 1), 1);
    sessions.close(2);
    assert_eq!(cache.test_reader_count(71, 1), 0);
    checks.push("replacement and stale close respect native completion boundary");
    let (_, reader) = cache.open_episode(71, 1).unwrap();
    assert!(!sessions.keep(2, None, Some(reader), None));
    assert_eq!(cache.test_reader_count(71, 1), 0);
    checks.push("rejected native session releases reader");
    let (e, d) = legacy(&root, fixture);
    let (_, reader) = cache.open_episode(81, 1).unwrap();
    assert!(!finalize::migrate(&cache, &root, &e).await.unwrap());
    assert!(d.join("index.m3u8").exists());
    drop(reader);
    checks.push("playing legacy HLS defers migration");
    let r = files::Ready {
        id: 81,
        ep: 1,
        title: "Fixture".into(),
        bytes: 1,
        mp4: false,
        filename: files::filename("Fixture", 1, 124),
        watch_key: None,
    };
    files::persist_ready(&d, &r).unwrap();
    remux::convert(
        &d.join("index.m3u8"),
        &d.join(&r.filename),
        false,
        || false,
        |_| {},
    )
    .await
    .unwrap();
    assert!(!read_episode(&root, &d).unwrap().mp4);
    assert!(d.join("index.m3u8").exists());
    assert!(finalize::migrate(&cache, &root, &e).await.unwrap());
    let merged = read_episode(&root, &d).unwrap();
    assert!(merged.mp4);
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 2);
    checks.push("legacy migration recovers published output and commits before cleanup");
    std::fs::write(d.join("0.ts"), b"obsolete").unwrap();
    let before = std::fs::read(d.join(&r.filename)).unwrap();
    assert!(finalize::migrate(&cache, &root, &merged).await.unwrap());
    assert!(!d.join("0.ts").exists());
    assert_eq!(std::fs::read(d.join(&r.filename)).unwrap(), before);
    checks.push("post-commit crash recovery cleans source without changing final file");
    let plain = path(&root, 82, 1);
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::hard_link(dest.join(&ready.filename), plain.join("video.mp4")).unwrap();
    let old_mp4 = Episode {
        id: 82,
        ep: 1,
        title: "Fixture".into(),
        bytes: e.bytes,
        mp4: true,
        media_file: None,
    };
    files::atomic_json(&plain, "info.json", &old_mp4).unwrap();
    let original = std::fs::read(plain.join("video.mp4")).unwrap();
    assert!(finalize::migrate(&cache, &root, &old_mp4).await.unwrap());
    let renamed = read_episode(&root, &plain).unwrap();
    assert!(renamed.mp4 && renamed.media_file.is_some());
    assert!(!plain.join("video.mp4").exists());
    assert_eq!(
        std::fs::read(renamed.media_path(&plain).unwrap()).unwrap(),
        original
    );
    checks.push("legacy MP4 rename preserves exact bytes and switches its authoritative pointer");
    let invalid = directory();
    let (e, d) = legacy(&invalid, fixture);
    let cache2 = Cache::default();
    cache2.bind(invalid.clone());
    std::fs::write(
        d.join("index.m3u8"),
        "#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n0.ts\n#EXT-X-ENDLIST\n",
    )
    .unwrap();
    let old = std::fs::read(d.join("info.json")).unwrap();
    assert!(finalize::migrate(&cache2, &invalid, &e).await.is_err());
    assert_eq!(std::fs::read(d.join("info.json")).unwrap(), old);
    assert!(d.join("index.m3u8").is_file());
    checks.push("unsupported migration preserves metadata and source");
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(invalid).unwrap();
    serde_json::json!({"passed":checks.len(),"failed":0,"checks":checks,"scope":"actual iOS Rust storage/session owners + pinned HGRemux framework; simulator, no AVPlayer decoding or phone proof"})
}
