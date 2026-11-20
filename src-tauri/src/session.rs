//! 会话持久化：token + 用户资料存到应用数据目录。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        assert!(store.begin("https://huangguoai.com").commit(
            "https://huangguoai.com",
            "fixture-token".into(),
            json!({"id": 1}),
        ));
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("fixture-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.snapshot("https://evil.example").user.is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        store.current.lock().unwrap().session =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.snapshot("https://huangguoai.com").user.is_null());
    }

    const ORIGIN: &str = "https://fixture.invalid";
    fn login(store: &SessionStore, id: u64) {
        assert!(store
            .begin(ORIGIN)
            .commit(ORIGIN, format!("fixture-{id}"), json!({"id": id})));
    }

    #[test]
    fn newer_attempt_rejects_older_commit_and_drop() {
        let store = SessionStore::new();
        let old = store.begin(ORIGIN);
        let new = store.begin(ORIGIN);
        assert!(!old.commit(ORIGIN, "old-fixture".into(), json!({"id": 1})));
        assert!(new.commit(ORIGIN, "new-fixture".into(), json!({"id": 2})));
        assert_eq!(store.snapshot(ORIGIN).user["id"], 2);
    }

    #[test]
    fn same_origin_after_line_round_trip_still_rejects_old_attempt() {
        let store = SessionStore::new();
        let old = store.begin(ORIGIN);
        store.clear();
        store.clear();
        assert!(!old.commit(ORIGIN, "old-fixture".into(), json!({"id": 1})));
        assert!(store.snapshot(ORIGIN).token.is_none());
    }

    #[test]
    fn failed_attempt_keeps_accepted_account_and_releases_pending() {
        let store = SessionStore::new();
        login(&store, 1);
        drop(store.begin(ORIGIN));
        let read = store.snapshot(ORIGIN);
        assert_eq!(read.user["id"], 1);
        assert!(store.refresh_user(read.revision, ORIGIN, json!({"id": 1, "refreshed": true})));
    }

    #[test]
    fn logout_revokes_before_network_and_retires_pending_authentication() {
        let store = SessionStore::new();
        login(&store, 1);
        let pending = store.begin(ORIGIN);
        let request = store.take_for_logout(ORIGIN);
        assert!(request.token.is_some());
        assert!(store.snapshot(ORIGIN).token.is_none());
        assert!(!pending.commit(ORIGIN, "retired-fixture".into(), json!({"id": 2})));
        login(&store, 3);
        drop(request); // The later network result has no credential write-back.
        assert_eq!(store.snapshot(ORIGIN).user["id"], 3);
    }

    #[test]
    fn old_origin_logout_does_not_clear_a_new_origin() {
        let store = SessionStore::new();
        let other = "https://other-fixture.invalid";
        assert!(store
            .begin(other)
            .commit(other, "other-fixture".into(), json!({"id": 2})));
        assert!(store.take_for_logout(ORIGIN).token.is_none());
        assert_eq!(store.snapshot(other).user["id"], 2);
    }

    #[test]
    fn target_logout_retires_its_pending_attempt_but_keeps_other_accepted_account() {
        let store = SessionStore::new();
        login(&store, 1);
        let other = "https://other-fixture.invalid";
        let pending = store.begin(other);
        store.take_for_logout(other);
        assert!(!pending.commit(other, "other-fixture".into(), json!({"id": 2})));
        assert_eq!(store.snapshot(ORIGIN).user["id"], 1);
    }

    #[test]
    fn logging_out_accepted_origin_does_not_retire_another_pending_origin() {
        let store = SessionStore::new();
        login(&store, 1);
        let other = "https://other-fixture.invalid";
        let pending = store.begin(other);
        store.take_for_logout(ORIGIN);
        assert!(store.snapshot(ORIGIN).token.is_none());
        assert!(pending.commit(other, "other-fixture".into(), json!({"id": 2})));
    }

    #[test]
    fn retired_me_response_cannot_pair_old_user_with_new_credentials() {
        let store = SessionStore::new();
        login(&store, 1);
        let old = store.snapshot(ORIGIN);
        login(&store, 2);
        assert!(!store.refresh_user(old.revision, ORIGIN, json!({"id": 1})));
        assert_eq!(store.snapshot(ORIGIN).user["id"], 2);
    }

    #[test]
    fn me_read_cannot_consume_pending_authentication() {
        let store = SessionStore::new();
        login(&store, 1);
        let authentication = store.begin(ORIGIN);
        let read = store.snapshot(ORIGIN);
        assert!(!store.refresh_user(read.revision, ORIGIN, json!({"id": 1})));
        assert!(authentication.commit(ORIGIN, "new-fixture".into(), json!({"id": 2})));
    }

    #[test]
    fn guest_read_revision_does_not_survive_authentication() {
        let store = SessionStore::new();
        let read = store.snapshot(ORIGIN);
        assert!(store.is_current(read.revision));
        let authentication = store.begin(ORIGIN);
        assert!(!store.is_current(read.revision));
        drop(authentication);
        assert!(!store.is_current(read.revision));
    }

    fn directory() -> PathBuf {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "hg-session-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn persisted_format_unchanged_and_logout_is_written_before_return() {
        let dir = directory();
        let store = SessionStore::new();
        store.bind(dir.clone());
        login(&store, 1);
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("session.json")).unwrap()).unwrap();
        assert_eq!(saved.as_object().unwrap().len(), 3);
        assert!(saved.get("revision").is_none());
        store.take_for_logout(ORIGIN);
        let reopened = SessionStore::new();
        reopened.bind(dir.clone());
        assert!(reopened.snapshot(ORIGIN).token.is_none());
        assert!(!dir.join("session.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_mutation_disk_matches_final_memory_and_no_temp_remains() {
        let dir = directory();
        let store = SessionStore::new();
        store.bind(dir.clone());
        std::thread::scope(|scope| {
            for id in 1..=32 {
                let store = &store;
                scope.spawn(move || {
                    let _ = store.begin(ORIGIN).commit(
                        ORIGIN,
                        format!("fixture-{id}"),
                        json!({"id": id}),
                    );
                    if id % 3 == 0 {
                        store.take_for_logout(ORIGIN);
                    }
                });
            }
        });
        let saved: Session =
            serde_json::from_slice(&std::fs::read(dir.join("session.json")).unwrap()).unwrap();
        let memory = store.current.lock().unwrap();
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::to_value(&memory.session).unwrap()
        );
        assert!(!dir.join("session.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

pub struct SessionStore {
    current: Mutex<Current>,
}

#[derive(Default)]
struct Current {
    session: Session,
    revision: u64,
    pending_origin: Option<String>,
    file: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SessionRevision(u64);

pub struct SessionSnapshot {
    pub revision: SessionRevision,
    pub token: Option<String>,
    pub user: serde_json::Value,
}

/// A native account attempt owns one revision, never the mutex across an await.
pub struct SessionOperation<'a> {
    store: &'a SessionStore,
    revision: SessionRevision,
}

impl SessionOperation<'_> {
    pub fn commit(self, origin: &str, token: String, user: serde_json::Value) -> bool {
        let mut current = self.store.current.lock().unwrap();
        if current.revision != self.revision.0 || current.pending_origin.as_deref() != Some(origin)
        {
            return false;
        }
        current.session = Session {
            origin: origin.into(),
            token,
            user,
        };
        current.revision += 1;
        current.pending_origin = None;
        SessionStore::persist(&current);
        true
    }
}

impl Drop for SessionOperation<'_> {
    fn drop(&mut self) {
        let mut current = self.store.current.lock().unwrap();
        if current.revision == self.revision.0 {
            // A failed or abandoned attempt keeps the last accepted account.
            current.revision += 1;
            current.pending_origin = None;
        }
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(Current::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let path = dir.join("session.json");
        let session = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let mut current = self.current.lock().unwrap();
        current.revision += 1;
        current.pending_origin = None;
        current.session = session;
        current.file = Some(path);
    }

    pub fn begin(&self, origin: &str) -> SessionOperation<'_> {
        let mut current = self.current.lock().unwrap();
        current.revision += 1;
        current.pending_origin = Some(origin.into());
        SessionOperation {
            store: self,
            revision: SessionRevision(current.revision),
        }
    }

    fn read(current: &Current, origin: &str) -> SessionSnapshot {
        let session = &current.session;
        let authenticated = session.origin == origin && !session.token.is_empty();
        SessionSnapshot {
            revision: SessionRevision(current.revision),
            token: authenticated.then(|| session.token.clone()),
            user: if authenticated {
                session.user.clone()
            } else {
                serde_json::Value::Null
            },
        }
    }

    pub fn snapshot(&self, origin: &str) -> SessionSnapshot {
        Self::read(&self.current.lock().unwrap(), origin)
    }

    pub fn is_current(&self, revision: SessionRevision) -> bool {
        let current = self.current.lock().unwrap();
        current.revision == revision.0 && current.pending_origin.is_none()
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let current = self.current.lock().unwrap();
        let session = &current.session;
        (session.origin == origin && !session.token.is_empty()).then(|| session.token.clone())
    }

    pub fn refresh_user(
        &self,
        revision: SessionRevision,
        origin: &str,
        user: serde_json::Value,
    ) -> bool {
        let mut current = self.current.lock().unwrap();
        if current.revision != revision.0
            || current.pending_origin.is_some()
            || current.session.origin != origin
            || current.session.token.is_empty()
        {
            return false;
        }
        current.revision += 1;
        current.session.user = user;
        Self::persist(&current);
        true
    }

    /// Revoke local credentials before remote best-effort logout. No write occurs after its await.
    pub fn take_for_logout(&self, origin: &str) -> SessionSnapshot {
        let mut current = self.current.lock().unwrap();
        let snapshot = Self::read(&current, origin);
        let owns_session = current.session.origin == origin;
        let owns_attempt = current.pending_origin.as_deref() == Some(origin);
        let idle = current.session.origin.is_empty() && current.pending_origin.is_none();
        if owns_session || owns_attempt || idle {
            // Accepted and pending accounts can belong to different origins.
            if owns_attempt || current.pending_origin.is_none() {
                current.revision += 1;
            }
            if owns_attempt {
                current.pending_origin = None;
            }
            if owns_session {
                current.session = Session::default();
            }
            Self::persist(&current);
        }
        snapshot
    }

    pub fn clear(&self) {
        let mut current = self.current.lock().unwrap();
        current.revision += 1;
        current.pending_origin = None;
        current.session = Session::default();
        Self::persist(&current);
    }

    fn persist(current: &Current) {
        let Some(path) = &current.file else {
            return;
        };
        // Serialize mutation and disk replacement under the same owner. Never replay an old snapshot.
        let temporary = path.with_extension("json.tmp");
        let result = serde_json::to_vec_pretty(&current.session)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&temporary, bytes))
            .and_then(|()| std::fs::rename(&temporary, path));
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            // Best-effort persistence remains distinct from an accepted in-memory account.
            eprintln!(
                "[account] session persistence unavailable: {:?}",
                error.kind()
            );
        }
    }
}
