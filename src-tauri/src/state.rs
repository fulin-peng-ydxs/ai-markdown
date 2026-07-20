use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{
    native_path_identity, resolve_existing_workspace_path, WorkspaceDescriptor, WorkspaceId,
    WorkspaceRelativePath,
};

pub const STATE_SCHEMA_VERSION: u32 = 1;
pub const STATE_FILE_NAME: &str = "plainroot-state-v1.json";
pub const MAX_STATE_FILE_BYTES: usize = 8 * 1024 * 1024;

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAvailability {
    Unchecked,
    Available,
    Missing,
    PermissionDenied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub workspace_id: WorkspaceId,
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub canonical_root: PathBuf,
    pub display_name: String,
    pub last_opened_at: u64,
    pub availability: WorkspaceAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionRoot {
    pub workspace_id: WorkspaceId,
    pub window_label: String,
    pub window_state_ref: Option<String>,
    pub last_active_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainrootStateV1 {
    pub schema_version: u32,
    pub recent_workspaces: Vec<RecentWorkspace>,
    pub workspace_sessions: Vec<WorkspaceSessionRoot>,
}

impl Default for PlainrootStateV1 {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            recent_workspaces: Vec::new(),
            workspace_sessions: Vec::new(),
        }
    }
}

impl PlainrootStateV1 {
    fn validate(&self) -> Result<(), DesktopError> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(state_error(
                DesktopErrorCode::UnsupportedStateVersion,
                false,
            ));
        }

        let unique_recent_ids = self
            .recent_workspaces
            .iter()
            .map(|workspace| workspace.workspace_id.as_str())
            .collect::<HashSet<_>>();
        let unique_session_ids = self
            .workspace_sessions
            .iter()
            .map(|session| session.workspace_id.as_str())
            .collect::<HashSet<_>>();
        let unique_window_labels = self
            .workspace_sessions
            .iter()
            .map(|session| session.window_label.as_str())
            .collect::<HashSet<_>>();

        if unique_recent_ids.len() != self.recent_workspaces.len()
            || unique_session_ids.len() != self.workspace_sessions.len()
            || unique_window_labels.len() != self.workspace_sessions.len()
        {
            return Err(state_error(DesktopErrorCode::InvalidStateData, false));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateRepositoryStatus {
    Initialized,
    Ready,
    RecoveredCorrupt { backup_file_name: String },
    UnsupportedVersion { found_version: u64 },
    Unavailable { error: DesktopError },
}

#[derive(Debug)]
struct PersistentStateInner {
    state: PlainrootStateV1,
    status: StateRepositoryStatus,
}

#[derive(Debug)]
pub struct PersistentAppState {
    store: Option<JsonStateStore>,
    inner: RwLock<PersistentStateInner>,
}

impl PersistentAppState {
    pub fn initialize_for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        match app.path().app_data_dir() {
            Ok(app_data_dir) => Self::initialize_at(app_data_dir.join(STATE_FILE_NAME)),
            Err(_) => Self::unavailable(state_error(DesktopErrorCode::StateUnavailable, true)),
        }
    }

    pub fn initialize_at(path: impl Into<PathBuf>) -> Self {
        Self::initialize_with_store(JsonStateStore::new(path.into()))
    }

    fn initialize_with_store(store: JsonStateStore) -> Self {
        let (state, status) = match store.load_or_initialize() {
            Ok(StateLoadOutcome::Initialized(state)) => (state, StateRepositoryStatus::Initialized),
            Ok(StateLoadOutcome::Loaded(state)) => (state, StateRepositoryStatus::Ready),
            Ok(StateLoadOutcome::RecoveredCorrupt {
                state,
                backup_file_name,
            }) => (
                state,
                StateRepositoryStatus::RecoveredCorrupt { backup_file_name },
            ),
            Err(StateLoadFailure::UnsupportedVersion { found_version }) => (
                PlainrootStateV1::default(),
                StateRepositoryStatus::UnsupportedVersion { found_version },
            ),
            Err(StateLoadFailure::Unavailable(error)) => (
                PlainrootStateV1::default(),
                StateRepositoryStatus::Unavailable { error },
            ),
        };

        Self {
            store: Some(store),
            inner: RwLock::new(PersistentStateInner { state, status }),
        }
    }

    fn unavailable(error: DesktopError) -> Self {
        Self {
            store: None,
            inner: RwLock::new(PersistentStateInner {
                state: PlainrootStateV1::default(),
                status: StateRepositoryStatus::Unavailable { error },
            }),
        }
    }

    pub fn snapshot(&self) -> Result<PlainrootStateV1, DesktopError> {
        self.inner
            .read()
            .map(|inner| inner.state.clone())
            .map_err(|_| state_error(DesktopErrorCode::StateUnavailable, true))
    }

    pub fn status(&self) -> Result<StateRepositoryStatus, DesktopError> {
        self.inner
            .read()
            .map(|inner| inner.status.clone())
            .map_err(|_| state_error(DesktopErrorCode::StateUnavailable, true))
    }

    pub fn current_error(&self) -> Option<DesktopError> {
        match self.status() {
            Ok(StateRepositoryStatus::UnsupportedVersion { .. }) => Some(state_error(
                DesktopErrorCode::UnsupportedStateVersion,
                false,
            )),
            Ok(StateRepositoryStatus::Unavailable { error }) => Some(error),
            Err(error) => Some(error),
            _ => None,
        }
    }

    pub fn update(
        &self,
        mutate: impl FnOnce(&mut PlainrootStateV1),
    ) -> Result<PlainrootStateV1, DesktopError> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| state_error(DesktopErrorCode::StateUnavailable, true))?;
        let mut inner = self
            .inner
            .write()
            .map_err(|_| state_error(DesktopErrorCode::StateUnavailable, true))?;
        match &inner.status {
            StateRepositoryStatus::UnsupportedVersion { .. } => {
                return Err(state_error(
                    DesktopErrorCode::UnsupportedStateVersion,
                    false,
                ));
            }
            StateRepositoryStatus::Unavailable { error }
                if !matches!(error.code, DesktopErrorCode::StateWriteFailed) =>
            {
                return Err(error.clone());
            }
            _ => {}
        }
        let mut candidate = inner.state.clone();
        mutate(&mut candidate);
        candidate.validate()?;

        if let Err(error) = store.save(&candidate) {
            inner.status = StateRepositoryStatus::Unavailable {
                error: error.clone(),
            };
            return Err(error);
        }

        inner.state = candidate.clone();
        inner.status = StateRepositoryStatus::Ready;
        Ok(candidate)
    }
}

#[derive(Debug)]
enum StateLoadOutcome {
    Initialized(PlainrootStateV1),
    Loaded(PlainrootStateV1),
    RecoveredCorrupt {
        state: PlainrootStateV1,
        backup_file_name: String,
    },
}

#[derive(Debug)]
enum StateLoadFailure {
    UnsupportedVersion { found_version: u64 },
    Unavailable(DesktopError),
}

#[derive(Debug)]
struct JsonStateStore {
    path: PathBuf,
    clock: fn() -> u128,
    #[cfg(test)]
    fail_before_replace: bool,
}

impl JsonStateStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            clock: unix_timestamp_millis,
            #[cfg(test)]
            fail_before_replace: false,
        }
    }

    #[cfg(test)]
    fn with_clock(mut self, clock: fn() -> u128) -> Self {
        self.clock = clock;
        self
    }

    #[cfg(test)]
    fn with_failure_before_replace(mut self) -> Self {
        self.fail_before_replace = true;
        self
    }

    fn load_or_initialize(&self) -> Result<StateLoadOutcome, StateLoadFailure> {
        let bytes = match File::open(&self.path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_STATE_FILE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| {
                        StateLoadFailure::Unavailable(
                            state_error(DesktopErrorCode::StateReadFailed, true)
                                .with_path_hint(&self.path),
                        )
                    })?;
                bytes
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let state = PlainrootStateV1::default();
                self.save(&state).map_err(StateLoadFailure::Unavailable)?;
                return Ok(StateLoadOutcome::Initialized(state));
            }
            Err(_) => {
                return Err(StateLoadFailure::Unavailable(
                    state_error(DesktopErrorCode::StateReadFailed, true).with_path_hint(&self.path),
                ));
            }
        };
        if bytes.len() > MAX_STATE_FILE_BYTES {
            return self.recover_corrupt();
        }

        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return self.recover_corrupt(),
        };
        let Some(found_version) = value.get("schemaVersion").and_then(Value::as_u64) else {
            return self.recover_corrupt();
        };
        if found_version != u64::from(STATE_SCHEMA_VERSION) {
            return Err(StateLoadFailure::UnsupportedVersion { found_version });
        }

        match serde_json::from_value::<PlainrootStateV1>(value) {
            Ok(state) if state.validate().is_ok() => Ok(StateLoadOutcome::Loaded(state)),
            _ => self.recover_corrupt(),
        }
    }

    fn recover_corrupt(&self) -> Result<StateLoadOutcome, StateLoadFailure> {
        let backup_path = self.next_corrupt_backup_path();
        fs::rename(&self.path, &backup_path).map_err(|_| {
            StateLoadFailure::Unavailable(
                state_error(DesktopErrorCode::StateBackupFailed, true).with_path_hint(&self.path),
            )
        })?;

        let state = PlainrootStateV1::default();
        self.save(&state).map_err(StateLoadFailure::Unavailable)?;
        let backup_file_name = backup_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "plainroot-state.corrupt".to_owned());
        Ok(StateLoadOutcome::RecoveredCorrupt {
            state,
            backup_file_name,
        })
    }

    fn next_corrupt_backup_path(&self) -> PathBuf {
        let file_name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| STATE_FILE_NAME.to_owned());
        let timestamp = (self.clock)();

        for collision_index in 0_u32.. {
            let suffix = if collision_index == 0 {
                format!(".corrupt-{timestamp}")
            } else {
                format!(".corrupt-{timestamp}-{collision_index}")
            };
            let candidate = self.path.with_file_name(format!("{file_name}{suffix}"));
            if !candidate.exists() {
                return candidate;
            }
        }

        unreachable!("corrupt backup name space should not be exhausted")
    }

    fn save(&self, state: &PlainrootStateV1) -> Result<(), DesktopError> {
        state.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| state_error(DesktopErrorCode::StateWriteFailed, true))?;
        fs::create_dir_all(parent).map_err(|_| {
            state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(&self.path)
        })?;

        let mut bytes = serde_json::to_vec_pretty(state)
            .map_err(|_| state_error(DesktopErrorCode::InvalidStateData, false))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_STATE_FILE_BYTES {
            return Err(state_error(DesktopErrorCode::InvalidStateData, false));
        }

        let (mut file, temp_path) = create_temp_file(&self.path)?;
        let mut temp_guard = TempFileGuard::new(temp_path.clone());
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(&self.path)
            })?;
        drop(file);

        #[cfg(test)]
        if self.fail_before_replace {
            return Err(
                state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(&self.path)
            );
        }

        crate::fs::atomic::replace_existing(&temp_path, &self.path).map_err(|_| {
            state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(&self.path)
        })?;
        temp_guard.disarm();
        Ok(())
    }
}

fn create_temp_file(target: &Path) -> Result<(File, PathBuf), DesktopError> {
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| STATE_FILE_NAME.to_owned());

    for _ in 0..100 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp_path = target.with_file_name(format!(
            ".{file_name}.tmp-{}-{sequence}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp_path) {
            Ok(file) => return Ok((file, temp_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(
                    state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(target)
                );
            }
        }
    }

    Err(state_error(DesktopErrorCode::StateWriteFailed, true).with_path_hint(target))
}

#[derive(Debug)]
struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn state_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

#[derive(Debug, Default)]
pub struct WorkspaceRegistry {
    state: RwLock<RegistryState>,
}

#[derive(Debug, Default)]
struct RegistryState {
    by_id: HashMap<WorkspaceId, WorkspaceDescriptor>,
    by_canonical_root: HashMap<String, WorkspaceId>,
}

impl WorkspaceRegistry {
    pub fn register(&self, workspace: WorkspaceDescriptor) -> Result<(), DesktopError> {
        let root_identity = native_path_identity(workspace.canonical_root())?;
        let mut state = self.state.write().map_err(|_| registry_unavailable())?;
        if state.by_id.contains_key(workspace.id())
            || state.by_canonical_root.contains_key(&root_identity)
        {
            return Err(DesktopError::new(
                DesktopErrorCode::WorkspaceAlreadyRegistered,
                true,
                false,
            ));
        }

        state
            .by_canonical_root
            .insert(root_identity, workspace.id().clone());
        state.by_id.insert(workspace.id().clone(), workspace);
        Ok(())
    }

    pub fn workspace(&self, id: &WorkspaceId) -> Result<WorkspaceDescriptor, DesktopError> {
        let state = self.state.read().map_err(|_| registry_unavailable())?;
        state
            .by_id
            .get(id)
            .cloned()
            .ok_or_else(|| DesktopError::new(DesktopErrorCode::WorkspaceNotRegistered, true, false))
    }

    pub fn workspace_id_for_root(
        &self,
        canonical_root: &Path,
    ) -> Result<Option<WorkspaceId>, DesktopError> {
        let root_identity = native_path_identity(canonical_root)?;
        let state = self.state.read().map_err(|_| registry_unavailable())?;
        Ok(state.by_canonical_root.get(&root_identity).cloned())
    }

    pub fn unregister(&self, id: &WorkspaceId) -> Result<bool, DesktopError> {
        let mut state = self.state.write().map_err(|_| registry_unavailable())?;
        let Some(workspace) = state.by_id.remove(id) else {
            return Ok(false);
        };
        let root_identity = native_path_identity(workspace.canonical_root())?;
        state.by_canonical_root.remove(&root_identity);
        Ok(true)
    }

    pub fn resolve_existing(
        &self,
        id: &WorkspaceId,
        relative_path: &str,
    ) -> Result<PathBuf, DesktopError> {
        let workspace = self.workspace(id)?;
        let relative_path = WorkspaceRelativePath::parse(relative_path)?;
        resolve_existing_workspace_path(workspace.canonical_root(), &relative_path)
    }
}

fn registry_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::RegistryUnavailable, true, true)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::contract_test::assert_interface_matches;
    use crate::error::DesktopErrorCode;
    use crate::fs::{inspect_workspace_root, WorkspaceDescriptor, WorkspaceId};

    use super::{
        JsonStateStore, PersistentAppState, PlainrootStateV1, RecentWorkspace,
        StateRepositoryStatus, WorkspaceAvailability, WorkspaceRegistry, WorkspaceSessionRoot,
        MAX_STATE_FILE_BYTES, STATE_FILE_NAME,
    };

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_root() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let sequence = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "plainroot-registry-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("root should be created");
        path
    }

    fn state_path(root: &Path) -> std::path::PathBuf {
        root.join("app-data").join(STATE_FILE_NAME)
    }

    fn recent_workspace(id: &str, opened_at: u64) -> RecentWorkspace {
        RecentWorkspace {
            workspace_id: WorkspaceId::parse(id).unwrap(),
            canonical_root: format!("/canonical/{id}").into(),
            display_name: id.to_owned(),
            last_opened_at: opened_at,
            availability: WorkspaceAvailability::Unchecked,
        }
    }

    fn session_root(id: &str, label: &str, active_at: u64) -> WorkspaceSessionRoot {
        WorkspaceSessionRoot {
            workspace_id: WorkspaceId::parse(id).unwrap(),
            window_label: label.to_owned(),
            window_state_ref: None,
            last_active_at: active_at,
        }
    }

    fn fixed_timestamp() -> u128 {
        1_700_000_000_123
    }

    #[test]
    fn registry_requires_registered_id_and_relative_path() {
        let root = test_root();
        fs::write(root.join("README.md"), "# Plainroot").expect("fixture should be created");
        let id = WorkspaceId::parse("workspace-1").expect("id should be valid");
        let resolution = inspect_workspace_root(&root).expect("root should be valid");
        let descriptor =
            WorkspaceDescriptor::from_resolution(id.clone(), resolution, true, None, false)
                .expect("descriptor should be created");
        let registry = WorkspaceRegistry::default();
        registry
            .register(descriptor)
            .expect("workspace should register");

        assert_eq!(
            registry
                .resolve_existing(&id, "README.md")
                .expect("registered path should resolve"),
            fs::canonicalize(root.join("README.md")).unwrap()
        );
        assert_eq!(
            registry
                .resolve_existing(&id, "../secret.md")
                .expect_err("traversal must fail")
                .code,
            DesktopErrorCode::InvalidRelativePath
        );
        assert_eq!(
            registry
                .resolve_existing(&WorkspaceId::parse("workspace-2").unwrap(), "README.md")
                .expect_err("unregistered id must fail")
                .code,
            DesktopErrorCode::WorkspaceNotRegistered
        );

        fs::remove_dir_all(root).expect("fixture should be removed");
    }

    #[test]
    fn registry_rejects_duplicate_canonical_root() {
        let root = test_root();
        let resolution = inspect_workspace_root(&root).expect("root should be valid");
        let first = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-1").unwrap(),
            resolution.clone(),
            true,
            None,
            false,
        )
        .unwrap();
        let second = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-2").unwrap(),
            resolution,
            true,
            None,
            false,
        )
        .unwrap();
        let registry = WorkspaceRegistry::default();
        registry.register(first).unwrap();

        let error = registry
            .register(second)
            .expect_err("same canonical root must not register twice");
        assert_eq!(error.code, DesktopErrorCode::WorkspaceAlreadyRegistered);

        fs::remove_dir_all(root).expect("fixture should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn registry_deduplicates_selected_symlink_and_real_root() {
        use std::os::unix::fs::symlink;

        let parent = test_root();
        let real_root = parent.join("real-root");
        let linked_root = parent.join("linked-root");
        fs::create_dir(&real_root).expect("real root should be created");
        symlink(&real_root, &linked_root).expect("linked root should be created");
        let real = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-real").unwrap(),
            inspect_workspace_root(&real_root).unwrap(),
            true,
            None,
            false,
        )
        .unwrap();
        let linked = WorkspaceDescriptor::from_resolution(
            WorkspaceId::parse("workspace-linked").unwrap(),
            inspect_workspace_root(&linked_root).unwrap(),
            true,
            None,
            true,
        )
        .unwrap();
        let registry = WorkspaceRegistry::default();
        registry.register(real).unwrap();

        let error = registry
            .register(linked)
            .expect_err("link and real root must share one identity");
        assert_eq!(error.code, DesktopErrorCode::WorkspaceAlreadyRegistered);

        fs::remove_dir_all(parent).expect("fixture should be removed");
    }

    #[test]
    fn persisted_state_serialization_matches_typescript_interfaces() {
        let workspace_id = WorkspaceId::parse("workspace-1").unwrap();
        let recent = super::RecentWorkspace {
            workspace_id: workspace_id.clone(),
            canonical_root: "/canonical/root".into(),
            display_name: "root".to_owned(),
            last_opened_at: 1_700_000_000_000,
            availability: super::WorkspaceAvailability::Available,
        };
        assert_interface_matches("RecentWorkspace", &recent);

        let session = super::WorkspaceSessionRoot {
            workspace_id,
            window_label: "workspace-window".to_owned(),
            window_state_ref: Some("window-state-1".to_owned()),
            last_active_at: 1_700_000_000_001,
        };
        assert_interface_matches("WorkspaceSessionRoot", &session);

        let state = PlainrootStateV1 {
            schema_version: 1,
            recent_workspaces: vec![recent],
            workspace_sessions: vec![session],
        };
        assert_interface_matches("PlainrootStateV1", &state);
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(!json.contains("openDisposition"));
        assert!(!json.contains("openPreference"));
    }

    #[test]
    fn first_start_creates_empty_versioned_state() {
        let root = test_root();
        let path = state_path(&root);

        let repository = PersistentAppState::initialize_at(&path);

        assert_eq!(
            repository.status().unwrap(),
            StateRepositoryStatus::Initialized
        );
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());
        assert!(path.is_file());
        let json = fs::read_to_string(&path).unwrap();
        assert!(json.contains("\"schemaVersion\": 1"));
        assert!(json.contains("\"recentWorkspaces\": []"));
        assert!(json.contains("\"workspaceSessions\": []"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_round_trips_recent_workspaces_and_root_sessions() {
        let root = test_root();
        let path = state_path(&root);
        let repository = PersistentAppState::initialize_at(&path);

        let expected = repository
            .update(|state| {
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-1", 10));
                state
                    .workspace_sessions
                    .push(session_root("workspace-1", "workspace-1", 11));
            })
            .unwrap();
        let reloaded = PersistentAppState::initialize_at(&path);

        assert_eq!(reloaded.status().unwrap(), StateRepositoryStatus::Ready);
        assert_eq!(reloaded.snapshot().unwrap(), expected);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_state_is_backed_up_before_default_recovery() {
        let root = test_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not-json").unwrap();
        let store = JsonStateStore::new(path.clone()).with_clock(fixed_timestamp);

        let repository = PersistentAppState::initialize_with_store(store);

        let backup_file_name = format!("{STATE_FILE_NAME}.corrupt-{}", fixed_timestamp());
        assert_eq!(
            repository.status().unwrap(),
            StateRepositoryStatus::RecoveredCorrupt {
                backup_file_name: backup_file_name.clone()
            }
        );
        assert_eq!(
            fs::read(path.with_file_name(backup_file_name)).unwrap(),
            b"{not-json"
        );
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());
        assert!(serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_state_is_backed_up_without_an_unbounded_read() {
        let root = test_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let oversized = vec![b'x'; MAX_STATE_FILE_BYTES + 1];
        fs::write(&path, &oversized).unwrap();
        let store = JsonStateStore::new(path.clone()).with_clock(fixed_timestamp);

        let repository = PersistentAppState::initialize_with_store(store);

        let backup_file_name = format!("{STATE_FILE_NAME}.corrupt-{}", fixed_timestamp());
        assert_eq!(
            repository.status().unwrap(),
            StateRepositoryStatus::RecoveredCorrupt {
                backup_file_name: backup_file_name.clone()
            }
        );
        assert_eq!(
            fs::metadata(path.with_file_name(backup_file_name))
                .unwrap()
                .len(),
            (MAX_STATE_FILE_BYTES + 1) as u64
        );
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_schema_version_is_preserved_for_future_migration() {
        let root = test_root();
        let path = state_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let future_state =
            b"{\"schemaVersion\":2,\"recentWorkspaces\":[],\"workspaceSessions\":[]}";
        fs::write(&path, future_state).unwrap();

        let repository = PersistentAppState::initialize_at(&path);

        assert_eq!(
            repository.status().unwrap(),
            StateRepositoryStatus::UnsupportedVersion { found_version: 2 }
        );
        assert_eq!(
            repository.current_error().unwrap().code,
            DesktopErrorCode::UnsupportedStateVersion
        );
        assert_eq!(fs::read(&path).unwrap(), future_state);
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());

        let update_error = repository
            .update(|state| {
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-1", 10));
            })
            .unwrap_err();
        assert_eq!(update_error.code, DesktopErrorCode::UnsupportedStateVersion);
        assert_eq!(fs::read(&path).unwrap(), future_state);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_app_data_path_degrades_to_in_memory_default() {
        let root = test_root();
        let app_data_file = root.join("app-data");
        fs::write(&app_data_file, b"not-a-directory").unwrap();
        let path = app_data_file.join(STATE_FILE_NAME);

        let repository = PersistentAppState::initialize_at(path);

        let StateRepositoryStatus::Unavailable { error } = repository.status().unwrap() else {
            panic!("unusable path should mark the repository unavailable");
        };
        assert_eq!(error.code, DesktopErrorCode::StateReadFailed);
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_atomic_replace_preserves_disk_and_memory_state() {
        let root = test_root();
        let path = state_path(&root);
        let repository = PersistentAppState::initialize_at(&path);
        repository
            .update(|state| {
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-1", 10));
            })
            .unwrap();
        let before = fs::read(&path).unwrap();
        let failing_repository = PersistentAppState::initialize_with_store(
            JsonStateStore::new(path.clone()).with_failure_before_replace(),
        );

        let error = failing_repository
            .update(|state| {
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-2", 20));
            })
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::StateWriteFailed);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            failing_repository
                .snapshot()
                .unwrap()
                .recent_workspaces
                .len(),
            1
        );
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_duplicate_state_is_rejected_without_writing() {
        let root = test_root();
        let path = state_path(&root);
        let repository = PersistentAppState::initialize_at(&path);
        let before = fs::read(&path).unwrap();

        let error = repository
            .update(|state| {
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-1", 10));
                state
                    .recent_workspaces
                    .push(recent_workspace("workspace-1", 20));
            })
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::InvalidStateData);
        assert_eq!(fs::read(path).unwrap(), before);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_update_is_rejected_without_changing_disk_or_memory() {
        let root = test_root();
        let path = state_path(&root);
        let repository = PersistentAppState::initialize_at(&path);
        let before = fs::read(&path).unwrap();

        let error = repository
            .update(|state| {
                state.recent_workspaces.push(RecentWorkspace {
                    workspace_id: WorkspaceId::parse("workspace-large").unwrap(),
                    canonical_root: "/canonical/large".into(),
                    display_name: "x".repeat(MAX_STATE_FILE_BYTES),
                    last_opened_at: 10,
                    availability: WorkspaceAvailability::Unchecked,
                });
            })
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::InvalidStateData);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(repository.snapshot().unwrap(), PlainrootStateV1::default());

        fs::remove_dir_all(root).unwrap();
    }
}
