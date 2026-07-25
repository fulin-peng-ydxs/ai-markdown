use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{
    native_path_identity, resolve_existing_workspace_path, WorkspaceId, WorkspaceRelativePath,
};

pub const WINDOW_SESSION_DIRECTORY_NAME: &str = "plainroot-window-sessions-v1";
pub const WINDOW_SESSION_MANIFEST_FILE_NAME: &str = "manifest-v1.json";
pub const WINDOW_SESSION_SCHEMA_VERSION: u32 = 1;
pub const MAX_WINDOW_SESSION_MANIFEST_BYTES: usize = 1024 * 1024;
pub const MAX_WINDOW_SESSION_BYTES: usize = 1024 * 1024;
pub const MAX_WINDOW_SESSION_WORKSPACES: usize = 1000;
pub const MAX_RECENTLY_CLOSED_TABS: usize = 50;

const SESSION_DIRECTORY_NAME: &str = "sessions";
const WINDOW_STATE_REF_PREFIX: &str = "window-session-v1-";
const PATH_IDENTITY_PREFIX: &str = "workspace-path-v1-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowTabEditorMode {
    Visual,
    Source,
}

impl WindowTabEditorMode {
    pub const ALL: &'static [Self] = &[Self::Visual, Self::Source];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WindowTabSelection {
    Visual { from: u64, to: u64 },
    Source { anchor: u64, head: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WindowTabAnchor {
    Semantic {
        block_id: Option<String>,
        fallback_offset: u64,
        scroll_top: u64,
    },
    Source {
        offset: u64,
        scroll_top: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowTabViewState {
    pub mode: WindowTabEditorMode,
    pub selection: WindowTabSelection,
    pub anchor: WindowTabAnchor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedWindowTab {
    pub relative_path: WorkspaceRelativePath,
    pub view: WindowTabViewState,
    pub last_activated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedRecentlyClosedTab {
    pub relative_path: WorkspaceRelativePath,
    pub view: WindowTabViewState,
    pub closed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowTabSessionSnapshot {
    pub tabs: Vec<PersistedWindowTab>,
    pub active_relative_path: Option<WorkspaceRelativePath>,
    pub recently_closed: Vec<PersistedRecentlyClosedTab>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabPathContract {
    pub relative_path: WorkspaceRelativePath,
    pub identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWindowTab {
    pub path: WorkspaceTabPathContract,
    pub view: WindowTabViewState,
    pub last_activated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRecentlyClosedTab {
    pub path: WorkspaceTabPathContract,
    pub view: WindowTabViewState,
    pub closed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabSessionPathIssue {
    pub relative_path: WorkspaceRelativePath,
    pub error: DesktopError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabSession {
    pub schema_version: u32,
    pub workspace_id: WorkspaceId,
    pub window_state_ref: String,
    pub revision: u64,
    pub tabs: Vec<ResolvedWindowTab>,
    pub active_relative_path: Option<WorkspaceRelativePath>,
    pub recently_closed: Vec<ResolvedRecentlyClosedTab>,
    pub updated_at: u64,
    pub issues: Vec<WindowTabSessionPathIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabSessionSaveResult {
    pub workspace_id: WorkspaceId,
    pub window_state_ref: String,
    pub revision: u64,
    pub tab_count: u32,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTabSessionSummary {
    pub workspace_id: WorkspaceId,
    pub window_state_ref: String,
    pub revision: u64,
    pub tab_count: u32,
    pub updated_at: u64,
    pub issue: Option<DesktopError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredWindowTabSessionV1 {
    schema_version: u32,
    workspace_id: WorkspaceId,
    window_state_ref: String,
    revision: u64,
    tabs: Vec<PersistedWindowTab>,
    active_relative_path: Option<WorkspaceRelativePath>,
    recently_closed: Vec<PersistedRecentlyClosedTab>,
    updated_at: u64,
}

impl StoredWindowTabSessionV1 {
    fn validate(&self) -> Result<(), DesktopError> {
        if self.schema_version != WINDOW_SESSION_SCHEMA_VERSION {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionUnsupportedVersion,
                false,
            ));
        }
        if !valid_window_state_ref(&self.window_state_ref)
            || self.recently_closed.len() > MAX_RECENTLY_CLOSED_TABS
        {
            return Err(window_session_corrupt());
        }
        validate_paths(
            self.tabs.iter().map(|tab| &tab.relative_path),
            self.active_relative_path.as_ref(),
            self.recently_closed.iter().map(|tab| &tab.relative_path),
        )?;
        for tab in &self.tabs {
            validate_view(&tab.view)?;
        }
        for tab in &self.recently_closed {
            validate_view(&tab.view)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowSessionManifestEntry {
    workspace_id: WorkspaceId,
    window_state_ref: String,
    revision: u64,
    tab_count: u32,
    updated_at: u64,
}

impl WindowSessionManifestEntry {
    fn validate(&self) -> bool {
        valid_window_state_ref(&self.window_state_ref)
    }

    fn summary(&self, issue: Option<DesktopError>) -> WindowTabSessionSummary {
        WindowTabSessionSummary {
            workspace_id: self.workspace_id.clone(),
            window_state_ref: self.window_state_ref.clone(),
            revision: self.revision,
            tab_count: self.tab_count,
            updated_at: self.updated_at,
            issue,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowSessionManifestV1 {
    schema_version: u32,
    entries: Vec<WindowSessionManifestEntry>,
}

impl Default for WindowSessionManifestV1 {
    fn default() -> Self {
        Self {
            schema_version: WINDOW_SESSION_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

impl WindowSessionManifestV1 {
    fn validate(&self) -> Result<(), DesktopError> {
        if self.schema_version != WINDOW_SESSION_SCHEMA_VERSION {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionUnsupportedVersion,
                false,
            ));
        }
        if self.entries.len() > MAX_WINDOW_SESSION_WORKSPACES {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionCapacityExceeded,
                false,
            ));
        }
        let mut workspace_ids = HashSet::new();
        let mut references = HashSet::new();
        if self.entries.iter().any(|entry| {
            !entry.validate()
                || !workspace_ids.insert(entry.workspace_id.clone())
                || !references.insert(entry.window_state_ref.clone())
        }) {
            return Err(window_session_corrupt());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowSessionRepositoryStatus {
    Ready,
    RecoveredCorrupt,
    UnsupportedVersion,
    Unavailable(DesktopError),
}

#[derive(Debug)]
struct WindowSessionInner {
    manifest: WindowSessionManifestV1,
    status: WindowSessionRepositoryStatus,
    issues: HashMap<WorkspaceId, DesktopError>,
}

#[derive(Debug, Clone)]
pub struct WindowSessionRepository {
    store: Option<Arc<WindowSessionStore>>,
    inner: Arc<Mutex<WindowSessionInner>>,
}

impl WindowSessionRepository {
    pub fn initialize_for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        match crate::app_data_directory(app) {
            Ok(app_data) => Self::initialize_at(app_data),
            Err(_) => Self::unavailable(window_session_error(
                DesktopErrorCode::WindowSessionUnavailable,
                true,
            )),
        }
    }

    pub fn initialize_at(app_data: impl Into<PathBuf>) -> Self {
        Self::initialize_with_fault(app_data.into(), WindowSessionFault::None)
    }

    fn initialize_with_fault(app_data: PathBuf, fault: WindowSessionFault) -> Self {
        let store = Arc::new(WindowSessionStore::new(
            app_data.join(WINDOW_SESSION_DIRECTORY_NAME),
            fault,
        ));
        let (mut manifest, mut status) = match store.load_or_initialize_manifest() {
            Ok(WindowSessionLoadOutcome::Ready(manifest)) => {
                (manifest, WindowSessionRepositoryStatus::Ready)
            }
            Ok(WindowSessionLoadOutcome::RecoveredCorrupt(manifest)) => {
                (manifest, WindowSessionRepositoryStatus::RecoveredCorrupt)
            }
            Err(WindowSessionLoadFailure::UnsupportedVersion) => (
                WindowSessionManifestV1::default(),
                WindowSessionRepositoryStatus::UnsupportedVersion,
            ),
            Err(WindowSessionLoadFailure::Unavailable(error)) => (
                WindowSessionManifestV1::default(),
                WindowSessionRepositoryStatus::Unavailable(error),
            ),
        };
        if matches!(
            status,
            WindowSessionRepositoryStatus::Ready | WindowSessionRepositoryStatus::RecoveredCorrupt
        ) {
            match store.reconcile_pending_session_commit(&mut manifest) {
                Ok(true) => status = WindowSessionRepositoryStatus::Ready,
                Ok(false) => {}
                Err(error) => status = WindowSessionRepositoryStatus::Unavailable(error),
            }
        }
        let repository = Self {
            store: Some(store),
            inner: Arc::new(Mutex::new(WindowSessionInner {
                manifest,
                status,
                issues: HashMap::new(),
            })),
        };
        repository.cleanup_orphans();
        repository
    }

    fn unavailable(error: DesktopError) -> Self {
        Self {
            store: None,
            inner: Arc::new(Mutex::new(WindowSessionInner {
                manifest: WindowSessionManifestV1::default(),
                status: WindowSessionRepositoryStatus::Unavailable(error),
                issues: HashMap::new(),
            })),
        }
    }

    pub fn current_error(&self) -> Option<DesktopError> {
        let inner = self.inner.lock().ok()?;
        match &inner.status {
            WindowSessionRepositoryStatus::UnsupportedVersion => Some(window_session_error(
                DesktopErrorCode::WindowSessionUnsupportedVersion,
                false,
            )),
            WindowSessionRepositoryStatus::Unavailable(error) => Some(error.clone()),
            _ => None,
        }
    }

    pub fn ensure_reference(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Result<WindowTabSessionSummary, DesktopError> {
        let store = self.store()?;
        let mut inner = self.lock_inner()?;
        ensure_writable(&inner.status)?;
        if let Some(entry) = inner
            .manifest
            .entries
            .iter()
            .find(|entry| &entry.workspace_id == workspace_id)
        {
            return Ok(entry.summary(None));
        }
        if inner.manifest.entries.len() >= MAX_WINDOW_SESSION_WORKSPACES {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionCapacityExceeded,
                false,
            ));
        }
        let entry = WindowSessionManifestEntry {
            workspace_id: workspace_id.clone(),
            window_state_ref: secure_window_state_ref()?,
            revision: 0,
            tab_count: 0,
            updated_at: 0,
        };
        let mut candidate = inner.manifest.clone();
        candidate.entries.push(entry.clone());
        candidate.validate()?;
        store.save_manifest(&candidate)?;
        inner.manifest = candidate;
        inner.status = WindowSessionRepositoryStatus::Ready;
        Ok(entry.summary(None))
    }

    pub fn summaries(&self) -> Result<Vec<WindowTabSessionSummary>, DesktopError> {
        self.store()?;
        let inner = self.lock_inner()?;
        ensure_readable(&inner.status)?;
        let mut summaries = inner
            .manifest
            .entries
            .iter()
            .map(|entry| entry.summary(inner.issues.get(&entry.workspace_id).cloned()))
            .collect::<Vec<_>>();
        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
        Ok(summaries)
    }

    pub(crate) fn stored_session(
        &self,
        workspace_id: &WorkspaceId,
        requested_ref: Option<&str>,
    ) -> Result<StoredWindowTabSessionV1, DesktopError> {
        let store = self.store()?;
        let inner = self.lock_inner()?;
        ensure_readable(&inner.status)?;
        let entry = find_entry(&inner.manifest, workspace_id, requested_ref)?.clone();
        drop(inner);
        if entry.revision == 0 {
            self.lock_inner()?.issues.remove(workspace_id);
            return Ok(StoredWindowTabSessionV1 {
                schema_version: WINDOW_SESSION_SCHEMA_VERSION,
                workspace_id: entry.workspace_id,
                window_state_ref: entry.window_state_ref,
                revision: 0,
                tabs: Vec::new(),
                active_relative_path: None,
                recently_closed: Vec::new(),
                updated_at: 0,
            });
        }
        match store.read_session(&entry) {
            Ok(session) => {
                self.lock_inner()?.issues.remove(workspace_id);
                Ok(session)
            }
            Err(error) => {
                if error.code == DesktopErrorCode::WindowSessionCorrupt {
                    let _ = store.backup_corrupt_session(&entry);
                }
                self.lock_inner()?
                    .issues
                    .insert(workspace_id.clone(), error.clone());
                Err(error)
            }
        }
    }

    pub fn save(
        &self,
        workspace_id: &WorkspaceId,
        requested_ref: Option<&str>,
        expected_revision: u64,
        snapshot: WindowTabSessionSnapshot,
    ) -> Result<WindowTabSessionSaveResult, DesktopError> {
        validate_snapshot(&snapshot)?;
        let store = self.store()?;
        let mut inner = self.lock_inner()?;
        ensure_writable(&inner.status)?;
        let entry_index = find_entry_index(&inner.manifest, workspace_id, requested_ref)?;
        let current_entry = inner.manifest.entries[entry_index].clone();
        if current_entry.revision != expected_revision {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionRevisionConflict,
                true,
            ));
        }
        let next_revision = expected_revision.checked_add(1).ok_or_else(|| {
            window_session_error(DesktopErrorCode::WindowSessionCapacityExceeded, false)
        })?;
        let stored = StoredWindowTabSessionV1 {
            schema_version: WINDOW_SESSION_SCHEMA_VERSION,
            workspace_id: workspace_id.clone(),
            window_state_ref: current_entry.window_state_ref.clone(),
            revision: next_revision,
            tabs: snapshot.tabs,
            active_relative_path: snapshot.active_relative_path,
            recently_closed: snapshot.recently_closed,
            updated_at: snapshot.updated_at,
        };
        stored.validate()?;
        let session_bytes = serialize_bounded(
            &stored,
            MAX_WINDOW_SESSION_BYTES,
            DesktopErrorCode::WindowSessionCapacityExceeded,
        )?;
        let previous_bytes = store.read_session_bytes_optional(&current_entry)?;
        if previous_bytes.is_some() {
            if let Err(error) = store.read_session(&current_entry) {
                if error.code == DesktopErrorCode::WindowSessionCorrupt {
                    let _ = store.backup_corrupt_session(&current_entry);
                }
                return Err(error);
            }
        } else if current_entry.revision != 0 {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionNotFound,
                true,
            ));
        }
        store.write_session_bytes(&current_entry, &session_bytes)?;
        if store.fault == WindowSessionFault::AfterSessionReplaceBeforeManifest {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionWriteFailed,
                true,
            ));
        }

        let tab_count = u32::try_from(stored.tabs.len()).map_err(|_| {
            window_session_error(DesktopErrorCode::WindowSessionCapacityExceeded, false)
        })?;
        let mut candidate = inner.manifest.clone();
        candidate.entries[entry_index].revision = next_revision;
        candidate.entries[entry_index].tab_count = tab_count;
        candidate.entries[entry_index].updated_at = stored.updated_at;
        if let Err(error) = store.save_manifest(&candidate) {
            let rollback = match previous_bytes {
                Some(bytes) => store.write_session_bytes_unchecked(&current_entry, &bytes),
                None => store.remove_session_file(&current_entry),
            };
            if rollback.is_err() {
                inner.status = WindowSessionRepositoryStatus::Unavailable(window_session_error(
                    DesktopErrorCode::WindowSessionUnavailable,
                    true,
                ));
            }
            return Err(error);
        }
        inner.manifest = candidate;
        inner.status = WindowSessionRepositoryStatus::Ready;
        inner.issues.remove(workspace_id);
        Ok(WindowTabSessionSaveResult {
            workspace_id: workspace_id.clone(),
            window_state_ref: current_entry.window_state_ref,
            revision: next_revision,
            tab_count,
            updated_at: stored.updated_at,
        })
    }

    pub fn remove(&self, workspace_id: &WorkspaceId) -> Result<bool, DesktopError> {
        let store = self.store()?;
        let mut inner = self.lock_inner()?;
        ensure_writable(&inner.status)?;
        let Some(entry) = inner
            .manifest
            .entries
            .iter()
            .find(|entry| &entry.workspace_id == workspace_id)
            .cloned()
        else {
            return Ok(false);
        };
        let mut candidate = inner.manifest.clone();
        candidate
            .entries
            .retain(|item| item.workspace_id != *workspace_id);
        store.save_manifest(&candidate)?;
        inner.manifest = candidate;
        inner.status = WindowSessionRepositoryStatus::Ready;
        inner.issues.remove(workspace_id);
        drop(inner);
        let _ = store.remove_session_file(&entry);
        Ok(true)
    }

    fn cleanup_orphans(&self) {
        let (store, referenced) = {
            let Ok(inner) = self.inner.lock() else {
                return;
            };
            if ensure_readable(&inner.status).is_err() {
                return;
            }
            let Some(store) = self.store.clone() else {
                return;
            };
            let referenced = inner
                .manifest
                .entries
                .iter()
                .map(|entry| session_file_name(&entry.window_state_ref))
                .collect::<HashSet<_>>();
            (store, referenced)
        };
        let Ok(entries) = fs::read_dir(&store.sessions_path) else {
            return;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if referenced.contains(&file_name) || !valid_session_file_name(&file_name) {
                continue;
            }
            if entry
                .file_type()
                .is_ok_and(|file_type| file_type.is_file() && !file_type.is_symlink())
                && store.known_v1_session_file(&entry.path())
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    fn store(&self) -> Result<Arc<WindowSessionStore>, DesktopError> {
        self.store
            .clone()
            .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionUnavailable, true))
    }

    fn lock_inner(&self) -> Result<MutexGuard<'_, WindowSessionInner>, DesktopError> {
        self.inner
            .lock()
            .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionUnavailable, true))
    }
}

pub fn resolve_window_tab_path(
    workspace_id: &WorkspaceId,
    canonical_root: &Path,
    relative_path: &WorkspaceRelativePath,
) -> Result<WorkspaceTabPathContract, DesktopError> {
    if !is_markdown_path(relative_path.as_str()) {
        return Err(DesktopError::new(
            DesktopErrorCode::UnsupportedMarkdownFile,
            true,
            false,
        ));
    }
    let resolved = resolve_existing_workspace_path(canonical_root, relative_path)?;
    let native_identity = native_path_identity(&resolved)?;
    let mut digest = Sha256::new();
    digest.update(workspace_id.as_str().as_bytes());
    digest.update([0]);
    digest.update(native_identity.as_bytes());
    let digest = digest.finalize();
    let mut identity = String::from(PATH_IDENTITY_PREFIX);
    for byte in digest {
        write!(&mut identity, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(WorkspaceTabPathContract {
        relative_path: relative_path.clone(),
        identity,
    })
}

pub(crate) fn resolve_window_tab_session(
    stored: StoredWindowTabSessionV1,
    canonical_root: &Path,
) -> WindowTabSession {
    let mut issues = Vec::new();
    let mut resolved_identities = HashSet::new();
    let tabs = stored
        .tabs
        .into_iter()
        .filter_map(|tab| {
            match resolve_window_tab_path(&stored.workspace_id, canonical_root, &tab.relative_path)
            {
                Ok(path) if resolved_identities.insert(path.identity.clone()) => {
                    Some(ResolvedWindowTab {
                        path,
                        view: tab.view,
                        last_activated_at: tab.last_activated_at,
                    })
                }
                Ok(_) => {
                    issues.push(WindowTabSessionPathIssue {
                        relative_path: tab.relative_path,
                        error: window_session_corrupt(),
                    });
                    None
                }
                Err(error) => {
                    issues.push(WindowTabSessionPathIssue {
                        relative_path: tab.relative_path,
                        error,
                    });
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    let recently_closed = stored
        .recently_closed
        .into_iter()
        .filter_map(|tab| {
            match resolve_window_tab_path(&stored.workspace_id, canonical_root, &tab.relative_path)
            {
                Ok(path) if resolved_identities.insert(path.identity.clone()) => {
                    Some(ResolvedRecentlyClosedTab {
                        path,
                        view: tab.view,
                        closed_at: tab.closed_at,
                    })
                }
                Ok(_) => {
                    issues.push(WindowTabSessionPathIssue {
                        relative_path: tab.relative_path,
                        error: window_session_corrupt(),
                    });
                    None
                }
                Err(error) => {
                    issues.push(WindowTabSessionPathIssue {
                        relative_path: tab.relative_path,
                        error,
                    });
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    let active_relative_path = stored
        .active_relative_path
        .filter(|active| tabs.iter().any(|tab| tab.path.relative_path == *active));
    WindowTabSession {
        schema_version: stored.schema_version,
        workspace_id: stored.workspace_id,
        window_state_ref: stored.window_state_ref,
        revision: stored.revision,
        tabs,
        active_relative_path,
        recently_closed,
        updated_at: stored.updated_at,
        issues,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowSessionFault {
    None,
    BeforeSessionReplace,
    AfterSessionReplaceBeforeManifest,
    BeforeManifestReplace,
}

#[derive(Debug)]
struct WindowSessionStore {
    root: PathBuf,
    manifest_path: PathBuf,
    sessions_path: PathBuf,
    fault: WindowSessionFault,
}

impl WindowSessionStore {
    fn new(root: PathBuf, fault: WindowSessionFault) -> Self {
        Self {
            manifest_path: root.join(WINDOW_SESSION_MANIFEST_FILE_NAME),
            sessions_path: root.join(SESSION_DIRECTORY_NAME),
            root,
            fault,
        }
    }

    fn load_or_initialize_manifest(
        &self,
    ) -> Result<WindowSessionLoadOutcome, WindowSessionLoadFailure> {
        self.create_directories()
            .map_err(WindowSessionLoadFailure::Unavailable)?;
        let bytes =
            match read_bounded_optional(&self.manifest_path, MAX_WINDOW_SESSION_MANIFEST_BYTES) {
                Ok(Some(bytes)) => bytes,
                Ok(None) => {
                    let manifest = WindowSessionManifestV1::default();
                    self.save_manifest(&manifest)
                        .map_err(WindowSessionLoadFailure::Unavailable)?;
                    return Ok(WindowSessionLoadOutcome::Ready(manifest));
                }
                Err(error) => return Err(WindowSessionLoadFailure::Unavailable(error)),
            };
        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return self.recover_corrupt_manifest(),
        };
        let Some(version) = value.get("schemaVersion").and_then(Value::as_u64) else {
            return self.recover_corrupt_manifest();
        };
        if version != u64::from(WINDOW_SESSION_SCHEMA_VERSION) {
            return Err(WindowSessionLoadFailure::UnsupportedVersion);
        }
        let manifest = match serde_json::from_value::<WindowSessionManifestV1>(value) {
            Ok(manifest) if manifest.validate().is_ok() => manifest,
            _ => return self.recover_corrupt_manifest(),
        };
        Ok(WindowSessionLoadOutcome::Ready(manifest))
    }

    fn create_directories(&self) -> Result<(), DesktopError> {
        fs::create_dir_all(&self.sessions_path)
            .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .and_then(|_| {
                    fs::set_permissions(&self.sessions_path, fs::Permissions::from_mode(0o700))
                })
                .map_err(|_| {
                    window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true)
                })?;
        }
        Ok(())
    }

    fn recover_corrupt_manifest(
        &self,
    ) -> Result<WindowSessionLoadOutcome, WindowSessionLoadFailure> {
        let backup = next_corrupt_backup_path(&self.manifest_path);
        fs::rename(&self.manifest_path, &backup).map_err(|_| {
            WindowSessionLoadFailure::Unavailable(window_session_error(
                DesktopErrorCode::WindowSessionWriteFailed,
                true,
            ))
        })?;
        let manifest = self.rebuild_manifest_from_sessions();
        self.save_manifest(&manifest)
            .map_err(WindowSessionLoadFailure::Unavailable)?;
        Ok(WindowSessionLoadOutcome::RecoveredCorrupt(manifest))
    }

    fn rebuild_manifest_from_sessions(&self) -> WindowSessionManifestV1 {
        let mut manifest = WindowSessionManifestV1::default();
        let mut workspace_ids = HashSet::new();
        let mut references = HashSet::new();
        let Ok(entries) = fs::read_dir(&self.sessions_path) else {
            return manifest;
        };
        for entry in entries.flatten() {
            if manifest.entries.len() >= MAX_WINDOW_SESSION_WORKSPACES
                || !entry
                    .file_type()
                    .is_ok_and(|file_type| file_type.is_file() && !file_type.is_symlink())
            {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !valid_session_file_name(&file_name) {
                continue;
            }
            let Ok(bytes) = read_bounded_required(&entry.path(), MAX_WINDOW_SESSION_BYTES) else {
                continue;
            };
            let Ok(session) = decode_session_bytes(&bytes) else {
                continue;
            };
            if session_file_name(&session.window_state_ref) != file_name
                || !workspace_ids.insert(session.workspace_id.clone())
                || !references.insert(session.window_state_ref.clone())
            {
                continue;
            }
            let Ok(tab_count) = u32::try_from(session.tabs.len()) else {
                continue;
            };
            manifest.entries.push(WindowSessionManifestEntry {
                workspace_id: session.workspace_id,
                window_state_ref: session.window_state_ref,
                revision: session.revision,
                tab_count,
                updated_at: session.updated_at,
            });
        }
        manifest
    }

    fn save_manifest(&self, manifest: &WindowSessionManifestV1) -> Result<(), DesktopError> {
        manifest.validate()?;
        let bytes = serialize_bounded(
            manifest,
            MAX_WINDOW_SESSION_MANIFEST_BYTES,
            DesktopErrorCode::WindowSessionCapacityExceeded,
        )?;
        write_private_atomic(
            &self.manifest_path,
            &bytes,
            self.fault == WindowSessionFault::BeforeManifestReplace,
        )
    }

    fn reconcile_pending_session_commit(
        &self,
        manifest: &mut WindowSessionManifestV1,
    ) -> Result<bool, DesktopError> {
        let mut candidate = manifest.clone();
        let mut changed = false;
        for entry in &mut candidate.entries {
            let Some(bytes) =
                read_bounded_optional(&self.session_path(entry), MAX_WINDOW_SESSION_BYTES)
                    .ok()
                    .flatten()
            else {
                continue;
            };
            let session = match decode_session_bytes(&bytes) {
                Ok(session) => session,
                Err(_) => continue,
            };
            let Some(pending_revision) = entry.revision.checked_add(1) else {
                continue;
            };
            if session.workspace_id != entry.workspace_id
                || session.window_state_ref != entry.window_state_ref
                || session.revision != pending_revision
            {
                continue;
            }
            entry.revision = session.revision;
            entry.tab_count = u32::try_from(session.tabs.len()).map_err(|_| {
                window_session_error(DesktopErrorCode::WindowSessionCapacityExceeded, false)
            })?;
            entry.updated_at = session.updated_at;
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        candidate.validate()?;
        self.save_manifest(&candidate)?;
        *manifest = candidate;
        Ok(true)
    }

    fn session_path(&self, entry: &WindowSessionManifestEntry) -> PathBuf {
        self.sessions_path
            .join(session_file_name(&entry.window_state_ref))
    }

    fn read_session(
        &self,
        entry: &WindowSessionManifestEntry,
    ) -> Result<StoredWindowTabSessionV1, DesktopError> {
        let path = self.session_path(entry);
        let bytes = read_bounded_required(&path, MAX_WINDOW_SESSION_BYTES)?;
        let session = decode_session_bytes(&bytes)?;
        if session.workspace_id != entry.workspace_id
            || session.window_state_ref != entry.window_state_ref
            || session.revision != entry.revision
            || session.tabs.len() != entry.tab_count as usize
            || session.updated_at != entry.updated_at
        {
            return Err(window_session_corrupt());
        }
        Ok(session)
    }

    fn read_session_bytes_optional(
        &self,
        entry: &WindowSessionManifestEntry,
    ) -> Result<Option<Vec<u8>>, DesktopError> {
        read_bounded_optional(&self.session_path(entry), MAX_WINDOW_SESSION_BYTES)
    }

    fn write_session_bytes(
        &self,
        entry: &WindowSessionManifestEntry,
        bytes: &[u8],
    ) -> Result<(), DesktopError> {
        write_private_atomic(
            &self.session_path(entry),
            bytes,
            self.fault == WindowSessionFault::BeforeSessionReplace,
        )
    }

    fn write_session_bytes_unchecked(
        &self,
        entry: &WindowSessionManifestEntry,
        bytes: &[u8],
    ) -> Result<(), DesktopError> {
        write_private_atomic(&self.session_path(entry), bytes, false)
    }

    fn remove_session_file(&self, entry: &WindowSessionManifestEntry) -> Result<(), DesktopError> {
        let path = self.session_path(entry);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(window_session_error(
                DesktopErrorCode::WindowSessionWriteFailed,
                true,
            )),
        }
    }

    fn backup_corrupt_session(
        &self,
        entry: &WindowSessionManifestEntry,
    ) -> Result<(), DesktopError> {
        let path = self.session_path(entry);
        if !path.exists() {
            return Ok(());
        }
        fs::rename(&path, next_corrupt_backup_path(&path))
            .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))
    }

    fn known_v1_session_file(&self, path: &Path) -> bool {
        read_bounded_required(path, MAX_WINDOW_SESSION_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("schemaVersion").and_then(Value::as_u64))
            == Some(u64::from(WINDOW_SESSION_SCHEMA_VERSION))
    }
}

enum WindowSessionLoadOutcome {
    Ready(WindowSessionManifestV1),
    RecoveredCorrupt(WindowSessionManifestV1),
}

enum WindowSessionLoadFailure {
    UnsupportedVersion,
    Unavailable(DesktopError),
}

fn decode_session_bytes(bytes: &[u8]) -> Result<StoredWindowTabSessionV1, DesktopError> {
    let value = serde_json::from_slice::<Value>(bytes).map_err(|_| window_session_corrupt())?;
    let Some(version) = value.get("schemaVersion").and_then(Value::as_u64) else {
        return Err(window_session_corrupt());
    };
    if version != u64::from(WINDOW_SESSION_SCHEMA_VERSION) {
        return Err(window_session_error(
            DesktopErrorCode::WindowSessionUnsupportedVersion,
            false,
        ));
    }
    let session = serde_json::from_value::<StoredWindowTabSessionV1>(value)
        .map_err(|_| window_session_corrupt())?;
    session.validate()?;
    Ok(session)
}

fn find_entry<'a>(
    manifest: &'a WindowSessionManifestV1,
    workspace_id: &WorkspaceId,
    requested_ref: Option<&str>,
) -> Result<&'a WindowSessionManifestEntry, DesktopError> {
    manifest
        .entries
        .iter()
        .find(|entry| {
            &entry.workspace_id == workspace_id
                && requested_ref.is_none_or(|value| value == entry.window_state_ref)
        })
        .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionNotFound, true))
}

fn find_entry_index(
    manifest: &WindowSessionManifestV1,
    workspace_id: &WorkspaceId,
    requested_ref: Option<&str>,
) -> Result<usize, DesktopError> {
    manifest
        .entries
        .iter()
        .position(|entry| {
            &entry.workspace_id == workspace_id
                && requested_ref.is_none_or(|value| value == entry.window_state_ref)
        })
        .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionNotFound, true))
}

fn validate_snapshot(snapshot: &WindowTabSessionSnapshot) -> Result<(), DesktopError> {
    if snapshot.recently_closed.len() > MAX_RECENTLY_CLOSED_TABS {
        return Err(window_session_error(
            DesktopErrorCode::WindowSessionCapacityExceeded,
            false,
        ));
    }
    validate_paths(
        snapshot.tabs.iter().map(|tab| &tab.relative_path),
        snapshot.active_relative_path.as_ref(),
        snapshot
            .recently_closed
            .iter()
            .map(|tab| &tab.relative_path),
    )?;
    for tab in &snapshot.tabs {
        validate_view(&tab.view)?;
    }
    for tab in &snapshot.recently_closed {
        validate_view(&tab.view)?;
    }
    Ok(())
}

fn validate_paths<'a>(
    tabs: impl Iterator<Item = &'a WorkspaceRelativePath>,
    active: Option<&WorkspaceRelativePath>,
    mut recently_closed: impl Iterator<Item = &'a WorkspaceRelativePath>,
) -> Result<(), DesktopError> {
    let tab_paths = tabs.map(WorkspaceRelativePath::as_str).collect::<Vec<_>>();
    let mut tab_identities = HashSet::new();
    if tab_paths
        .iter()
        .any(|path| !is_markdown_path(path) || !tab_identities.insert(platform_relative_key(path)))
    {
        return Err(window_session_corrupt());
    }
    if active.is_some_and(|path| !tab_paths.contains(&path.as_str())) {
        return Err(window_session_corrupt());
    }
    let mut recent_identities = HashSet::new();
    if recently_closed.any(|path| {
        !is_markdown_path(path.as_str())
            || !recent_identities.insert(platform_relative_key(path.as_str()))
            || tab_identities.contains(&platform_relative_key(path.as_str()))
    }) {
        return Err(window_session_corrupt());
    }
    Ok(())
}

fn validate_view(view: &WindowTabViewState) -> Result<(), DesktopError> {
    const MAX_POSITION: u64 = u32::MAX as u64;
    const MAX_SCROLL_TOP: u64 = 1_000_000_000;
    let valid_selection = match view.selection {
        WindowTabSelection::Visual { from, to } => {
            view.mode == WindowTabEditorMode::Visual && from <= to && to <= MAX_POSITION
        }
        WindowTabSelection::Source { anchor, head } => {
            view.mode == WindowTabEditorMode::Source
                && anchor <= MAX_POSITION
                && head <= MAX_POSITION
        }
    };
    let valid_anchor = match &view.anchor {
        WindowTabAnchor::Semantic {
            block_id,
            fallback_offset,
            scroll_top,
        } => {
            view.mode == WindowTabEditorMode::Visual
                && block_id.as_ref().is_none_or(|value| value.len() <= 512)
                && *fallback_offset <= MAX_POSITION
                && *scroll_top <= MAX_SCROLL_TOP
        }
        WindowTabAnchor::Source { offset, scroll_top } => {
            view.mode == WindowTabEditorMode::Source
                && *offset <= MAX_POSITION
                && *scroll_top <= MAX_SCROLL_TOP
        }
    };
    if valid_selection && valid_anchor {
        Ok(())
    } else {
        Err(window_session_corrupt())
    }
}

fn is_markdown_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

#[cfg(windows)]
fn platform_relative_key(path: &str) -> String {
    path.to_lowercase()
}

#[cfg(not(windows))]
fn platform_relative_key(path: &str) -> String {
    path.to_owned()
}

fn secure_window_state_ref() -> Result<String, DesktopError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionUnavailable, true))?;
    let mut value = String::from(WINDOW_STATE_REF_PREFIX);
    for byte in random {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

fn valid_window_state_ref(value: &str) -> bool {
    value
        .strip_prefix(WINDOW_STATE_REF_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn session_file_name(window_state_ref: &str) -> String {
    format!("{window_state_ref}.json")
}

fn valid_session_file_name(value: &str) -> bool {
    value
        .strip_suffix(".json")
        .is_some_and(valid_window_state_ref)
}

fn serialize_bounded(
    value: &impl Serialize,
    max_bytes: usize,
    capacity_code: DesktopErrorCode,
) -> Result<Vec<u8>, DesktopError> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        return Err(window_session_error(capacity_code, false));
    }
    Ok(bytes)
}

fn read_bounded_optional(path: &Path, max_bytes: usize) -> Result<Option<Vec<u8>>, DesktopError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(window_session_error(
                DesktopErrorCode::WindowSessionReadFailed,
                true,
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionReadFailed, true))?;
    if bytes.len() > max_bytes {
        return Err(window_session_corrupt());
    }
    Ok(Some(bytes))
}

fn read_bounded_required(path: &Path, max_bytes: usize) -> Result<Vec<u8>, DesktopError> {
    read_bounded_optional(path, max_bytes)?
        .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionNotFound, true))
}

fn write_private_atomic(
    target: &Path,
    bytes: &[u8],
    fail_before_replace: bool,
) -> Result<(), DesktopError> {
    let parent = target
        .parent()
        .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    fs::create_dir_all(parent)
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    let (mut file, temp_path) = create_private_temp_file(target)?;
    let mut guard = WindowSessionTempGuard::new(temp_path.clone());
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    drop(file);
    if fail_before_replace {
        return Err(window_session_error(
            DesktopErrorCode::WindowSessionWriteFailed,
            true,
        ));
    }
    crate::fs::atomic::replace_existing(&temp_path, target)
        .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    guard.disarm();
    let _ = crate::fs::atomic::sync_parent_directory(target);
    Ok(())
}

fn create_private_temp_file(target: &Path) -> Result<(File, PathBuf), DesktopError> {
    let parent = target
        .parent()
        .ok_or_else(|| window_session_error(DesktopErrorCode::WindowSessionWriteFailed, true))?;
    for _ in 0..100 {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random)
            .map_err(|_| window_session_error(DesktopErrorCode::WindowSessionUnavailable, true))?;
        let mut suffix = String::with_capacity(16);
        for byte in random {
            write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
        }
        let temp_path = parent.join(format!(
            ".plainroot-window-session.tmp-{}-{suffix}",
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
                return Err(window_session_error(
                    DesktopErrorCode::WindowSessionWriteFailed,
                    true,
                ))
            }
        }
    }
    Err(window_session_error(
        DesktopErrorCode::WindowSessionWriteFailed,
        true,
    ))
}

struct WindowSessionTempGuard {
    path: Option<PathBuf>,
}

impl WindowSessionTempGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for WindowSessionTempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn next_corrupt_backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "window-session.json".to_owned());
    let timestamp = unix_timestamp_millis();
    for collision in 0_u32.. {
        let suffix = if collision == 0 {
            format!(".corrupt-{timestamp}")
        } else {
            format!(".corrupt-{timestamp}-{collision}")
        };
        let candidate = path.with_file_name(format!("{file_name}{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("window session corrupt backup namespace should not be exhausted")
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn ensure_readable(status: &WindowSessionRepositoryStatus) -> Result<(), DesktopError> {
    match status {
        WindowSessionRepositoryStatus::Ready | WindowSessionRepositoryStatus::RecoveredCorrupt => {
            Ok(())
        }
        WindowSessionRepositoryStatus::UnsupportedVersion => Err(window_session_error(
            DesktopErrorCode::WindowSessionUnsupportedVersion,
            false,
        )),
        WindowSessionRepositoryStatus::Unavailable(error) => Err(error.clone()),
    }
}

fn ensure_writable(status: &WindowSessionRepositoryStatus) -> Result<(), DesktopError> {
    ensure_readable(status)
}

fn window_session_corrupt() -> DesktopError {
    window_session_error(DesktopErrorCode::WindowSessionCorrupt, true)
}

fn window_session_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Barrier};
    use std::thread;

    use crate::contract_test::{
        assert_interface_matches, assert_type_alias_matches_variants,
        typescript_string_constant_values,
    };
    use crate::error::DesktopErrorCode;
    use crate::fs::{WorkspaceId, WorkspaceRelativePath};
    use crate::test_support::TestDirectory;

    use super::{
        resolve_window_tab_path, resolve_window_tab_session, PersistedRecentlyClosedTab,
        PersistedWindowTab, ResolvedRecentlyClosedTab, ResolvedWindowTab, WindowSessionFault,
        WindowSessionRepository, WindowTabAnchor, WindowTabEditorMode, WindowTabSelection,
        WindowTabSession, WindowTabSessionPathIssue, WindowTabSessionSaveResult,
        WindowTabSessionSnapshot, WindowTabSessionSummary, WindowTabViewState,
        WorkspaceTabPathContract, WINDOW_SESSION_DIRECTORY_NAME, WINDOW_SESSION_MANIFEST_FILE_NAME,
    };

    fn workspace_id(value: &str) -> WorkspaceId {
        WorkspaceId::parse(value).unwrap()
    }

    fn path(value: &str) -> WorkspaceRelativePath {
        WorkspaceRelativePath::parse(value).unwrap()
    }

    fn view(mode: WindowTabEditorMode) -> WindowTabViewState {
        match mode {
            WindowTabEditorMode::Visual => WindowTabViewState {
                mode,
                selection: WindowTabSelection::Visual { from: 1, to: 2 },
                anchor: WindowTabAnchor::Semantic {
                    block_id: Some("heading:intro".to_owned()),
                    fallback_offset: 1,
                    scroll_top: 20,
                },
            },
            WindowTabEditorMode::Source => WindowTabViewState {
                mode,
                selection: WindowTabSelection::Source { anchor: 2, head: 2 },
                anchor: WindowTabAnchor::Source {
                    offset: 2,
                    scroll_top: 30,
                },
            },
        }
    }

    fn snapshot() -> WindowTabSessionSnapshot {
        WindowTabSessionSnapshot {
            tabs: vec![
                PersistedWindowTab {
                    relative_path: path("notes/a.md"),
                    view: view(WindowTabEditorMode::Visual),
                    last_activated_at: 20,
                },
                PersistedWindowTab {
                    relative_path: path("b.md"),
                    view: view(WindowTabEditorMode::Source),
                    last_activated_at: 10,
                },
            ],
            active_relative_path: Some(path("notes/a.md")),
            recently_closed: vec![PersistedRecentlyClosedTab {
                relative_path: path("closed.md"),
                view: view(WindowTabEditorMode::Source),
                closed_at: 5,
            }],
            updated_at: 30,
        }
    }

    fn create_workspace(root: &TestDirectory) {
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# A").unwrap();
        fs::write(root.path().join("b.md"), "# B").unwrap();
        fs::write(root.path().join("closed.md"), "# Closed").unwrap();
    }

    #[test]
    fn repository_round_trips_metadata_and_resolves_opaque_paths() {
        let app_data = TestDirectory::create("window-session-roundtrip");
        let workspace = TestDirectory::create("window-session-workspace");
        create_workspace(&workspace);
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        let summary = repository.ensure_reference(&workspace_id).unwrap();

        let saved = repository
            .save(
                &workspace_id,
                Some(&summary.window_state_ref),
                0,
                snapshot(),
            )
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.tab_count, 2);

        let stored = repository
            .stored_session(&workspace_id, Some(&summary.window_state_ref))
            .unwrap();
        let canonical_workspace = fs::canonicalize(workspace.path()).unwrap();
        let resolved = resolve_window_tab_session(stored, &canonical_workspace);
        assert_eq!(resolved.tabs.len(), 2);
        assert_eq!(resolved.recently_closed.len(), 1);
        assert!(resolved.issues.is_empty());
        assert!(resolved
            .tabs
            .iter()
            .all(|tab| tab.path.identity.starts_with("workspace-path-v1-")));

        let session_path = app_data
            .path()
            .join(WINDOW_SESSION_DIRECTORY_NAME)
            .join("sessions")
            .join(format!("{}.json", summary.window_state_ref));
        let json = fs::read_to_string(session_path).unwrap();
        assert!(!json.contains("# A"));
        assert!(!json.contains(&workspace.path().to_string_lossy().to_string()));
        assert!(!json.contains("markdown"));
        assert!(!json.contains("history"));
    }

    #[test]
    fn stale_revision_and_cross_workspace_reference_are_rejected() {
        let app_data = TestDirectory::create("window-session-cas");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_a = workspace_id("workspace-a");
        let workspace_b = workspace_id("workspace-b");
        let a = repository.ensure_reference(&workspace_a).unwrap();
        let b = repository.ensure_reference(&workspace_b).unwrap();
        repository
            .save(&workspace_a, Some(&a.window_state_ref), 0, snapshot())
            .unwrap();

        let stale = repository
            .save(&workspace_a, Some(&a.window_state_ref), 0, snapshot())
            .unwrap_err();
        assert_eq!(stale.code, DesktopErrorCode::WindowSessionRevisionConflict);
        let crossed = repository
            .stored_session(&workspace_a, Some(&b.window_state_ref))
            .unwrap_err();
        assert_eq!(crossed.code, DesktopErrorCode::WindowSessionNotFound);
    }

    #[test]
    fn concurrent_saves_with_one_revision_commit_exactly_once() {
        let app_data = TestDirectory::create("window-session-concurrent-cas");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        repository.ensure_reference(&workspace_id).unwrap();
        let barrier = Arc::new(Barrier::new(2));

        let handles = [40, 50].map(|updated_at| {
            let repository = repository.clone();
            let workspace_id = workspace_id.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let mut candidate = snapshot();
                candidate.updated_at = updated_at;
                barrier.wait();
                repository.save(&workspace_id, None, 0, candidate)
            })
        });
        let results = handles.map(|handle| handle.join().unwrap());

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(|error| error.code)
                .collect::<Vec<_>>(),
            vec![DesktopErrorCode::WindowSessionRevisionConflict]
        );
        assert_eq!(
            repository
                .stored_session(&workspace_id, None)
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn newly_created_reference_reads_as_an_empty_revision_zero_session() {
        let app_data = TestDirectory::create("window-session-empty");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        let stored = repository
            .stored_session(&workspace_id, Some(&summary.window_state_ref))
            .unwrap();
        assert_eq!(stored.revision, 0);
        assert!(stored.tabs.is_empty());
        assert!(stored.recently_closed.is_empty());
    }

    #[test]
    fn session_replace_failure_preserves_previous_revision() {
        let app_data = TestDirectory::create("window-session-fault");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository
            .save(&workspace_id, None, 0, snapshot())
            .expect("baseline should save");
        drop(repository);

        let failing = WindowSessionRepository::initialize_with_fault(
            app_data.path().to_path_buf(),
            WindowSessionFault::BeforeSessionReplace,
        );
        let mut changed = snapshot();
        changed.updated_at = 99;
        let error = failing
            .save(&workspace_id, Some(&summary.window_state_ref), 1, changed)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WindowSessionWriteFailed);
        drop(failing);

        let reloaded = WindowSessionRepository::initialize_at(app_data.path());
        let stored = reloaded
            .stored_session(&workspace_id, Some(&summary.window_state_ref))
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.updated_at, 30);
    }

    #[test]
    fn manifest_failure_rolls_back_new_session_bytes() {
        let app_data = TestDirectory::create("window-session-manifest-fault");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository
            .save(&workspace_id, None, 0, snapshot())
            .expect("baseline should save");
        drop(repository);

        let failing = WindowSessionRepository::initialize_with_fault(
            app_data.path().to_path_buf(),
            WindowSessionFault::BeforeManifestReplace,
        );
        let mut changed = snapshot();
        changed.updated_at = 99;
        let error = failing
            .save(&workspace_id, Some(&summary.window_state_ref), 1, changed)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WindowSessionWriteFailed);
        drop(failing);

        let reloaded = WindowSessionRepository::initialize_at(app_data.path());
        let stored = reloaded
            .stored_session(&workspace_id, Some(&summary.window_state_ref))
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.updated_at, 30);
    }

    #[test]
    fn restart_rolls_forward_a_session_committed_before_its_manifest() {
        let app_data = TestDirectory::create("window-session-crash-recovery");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository
            .save(&workspace_id, None, 0, snapshot())
            .expect("baseline should save");
        drop(repository);

        let interrupted = WindowSessionRepository::initialize_with_fault(
            app_data.path().to_path_buf(),
            WindowSessionFault::AfterSessionReplaceBeforeManifest,
        );
        let mut changed = snapshot();
        changed.updated_at = 99;
        let error = interrupted
            .save(&workspace_id, Some(&summary.window_state_ref), 1, changed)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WindowSessionWriteFailed);
        drop(interrupted);

        let recovered = WindowSessionRepository::initialize_at(app_data.path());
        let stored = recovered
            .stored_session(&workspace_id, Some(&summary.window_state_ref))
            .unwrap();
        assert_eq!(stored.revision, 2);
        assert_eq!(stored.updated_at, 99);
        assert_eq!(recovered.summaries().unwrap()[0].revision, 2);
    }

    #[test]
    fn unknown_versions_are_preserved_and_corrupt_sessions_are_backed_up() {
        let app_data = TestDirectory::create("window-session-version");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository
            .save(&workspace_id, None, 0, snapshot())
            .expect("baseline should save");
        let path = app_data
            .path()
            .join(WINDOW_SESSION_DIRECTORY_NAME)
            .join("sessions")
            .join(format!("{}.json", summary.window_state_ref));
        fs::write(
            &path,
            format!(
                "{{\"schemaVersion\":2,\"workspaceId\":\"{}\"}}",
                workspace_id.as_str()
            ),
        )
        .unwrap();
        let unknown = repository.stored_session(&workspace_id, None).unwrap_err();
        assert_eq!(
            unknown.code,
            DesktopErrorCode::WindowSessionUnsupportedVersion
        );
        assert_eq!(
            repository.summaries().unwrap()[0]
                .issue
                .as_ref()
                .map(|issue| issue.code),
            Some(DesktopErrorCode::WindowSessionUnsupportedVersion)
        );
        assert!(path.exists());
        let original_unknown = fs::read(&path).unwrap();
        let save_error = repository
            .save(&workspace_id, None, 1, snapshot())
            .unwrap_err();
        assert_eq!(
            save_error.code,
            DesktopErrorCode::WindowSessionUnsupportedVersion
        );
        assert_eq!(fs::read(&path).unwrap(), original_unknown);

        fs::write(&path, "{invalid").unwrap();
        drop(repository);
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        assert!(repository.current_error().is_none());
        let corrupt = repository.stored_session(&workspace_id, None).unwrap_err();
        assert_eq!(corrupt.code, DesktopErrorCode::WindowSessionCorrupt);
        assert!(!path.exists());
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn invalid_or_missing_paths_are_isolated_during_resolution() {
        let workspace = TestDirectory::create("window-session-isolation");
        create_workspace(&workspace);
        let app_data = TestDirectory::create("window-session-isolation-data");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        repository.ensure_reference(&workspace_id).unwrap();
        let mut value = snapshot();
        value.tabs.push(PersistedWindowTab {
            relative_path: path("missing.md"),
            view: view(WindowTabEditorMode::Visual),
            last_activated_at: 1,
        });
        repository.save(&workspace_id, None, 0, value).unwrap();
        let stored = repository.stored_session(&workspace_id, None).unwrap();
        let canonical_workspace = fs::canonicalize(workspace.path()).unwrap();
        let resolved = resolve_window_tab_session(stored, &canonical_workspace);
        assert_eq!(resolved.tabs.len(), 2);
        assert_eq!(resolved.issues.len(), 1);
        assert_eq!(resolved.issues[0].relative_path.as_str(), "missing.md");
        assert_eq!(
            resolved.issues[0].error.code,
            DesktopErrorCode::PathNotFound
        );
    }

    #[test]
    fn capacity_and_recent_closed_limits_fail_without_overwriting() {
        let app_data = TestDirectory::create("window-session-capacity");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        repository.ensure_reference(&workspace_id).unwrap();
        let mut too_many_recent = snapshot();
        too_many_recent.recently_closed = (0..51)
            .map(|index| PersistedRecentlyClosedTab {
                relative_path: path(&format!("closed-{index}.md")),
                view: view(WindowTabEditorMode::Source),
                closed_at: index,
            })
            .collect();
        let error = repository
            .save(&workspace_id, None, 0, too_many_recent)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WindowSessionCapacityExceeded);

        let mut oversized = snapshot();
        oversized.active_relative_path = None;
        oversized.tabs = (0..10_000)
            .map(|index| PersistedWindowTab {
                relative_path: path(&format!("very-long-directory-name/{index:05}.md")),
                view: view(WindowTabEditorMode::Visual),
                last_activated_at: index,
            })
            .collect();
        let error = repository
            .save(&workspace_id, None, 0, oversized)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WindowSessionCapacityExceeded);
        assert_eq!(repository.summaries().unwrap()[0].revision, 0);
    }

    #[test]
    fn removal_drops_only_metadata_and_session_file() {
        let app_data = TestDirectory::create("window-session-remove");
        let workspace = TestDirectory::create("window-session-remove-workspace");
        create_workspace(&workspace);
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let workspace_id = workspace_id("workspace-a");
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository.save(&workspace_id, None, 0, snapshot()).unwrap();

        assert!(repository.remove(&workspace_id).unwrap());
        assert!(!repository.remove(&workspace_id).unwrap());
        assert!(workspace.path().join("notes/a.md").exists());
        assert!(repository.summaries().unwrap().is_empty());
        assert!(!app_data
            .path()
            .join(WINDOW_SESSION_DIRECTORY_NAME)
            .join("sessions")
            .join(format!("{}.json", summary.window_state_ref))
            .exists());
    }

    #[test]
    fn failed_metadata_removal_can_be_retried_after_the_recent_record_is_gone() {
        let app_data = TestDirectory::create("window-session-remove-retry");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        repository.ensure_reference(&workspace_id).unwrap();
        repository.save(&workspace_id, None, 0, snapshot()).unwrap();
        drop(repository);

        let failing = WindowSessionRepository::initialize_with_fault(
            app_data.path().to_path_buf(),
            WindowSessionFault::BeforeManifestReplace,
        );
        assert_eq!(
            failing.remove(&workspace_id).unwrap_err().code,
            DesktopErrorCode::WindowSessionWriteFailed
        );
        drop(failing);

        let retry = WindowSessionRepository::initialize_at(app_data.path());
        assert!(retry.remove(&workspace_id).unwrap());
        assert!(retry.summaries().unwrap().is_empty());
    }

    #[test]
    fn orphan_cleanup_only_removes_plainroot_regular_session_files() {
        let app_data = TestDirectory::create("window-session-orphans");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        drop(repository);
        let sessions = app_data
            .path()
            .join(WINDOW_SESSION_DIRECTORY_NAME)
            .join("sessions");
        let orphan = sessions.join(format!(
            "{}{}.json",
            super::WINDOW_STATE_REF_PREFIX,
            "a".repeat(32)
        ));
        let unrelated = sessions.join("keep-me.json");
        fs::write(&orphan, "{\"schemaVersion\":1}").unwrap();
        fs::write(&unrelated, "{}").unwrap();

        let repository = WindowSessionRepository::initialize_at(app_data.path());
        drop(repository);
        assert!(!orphan.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn corrupt_manifest_rebuilds_valid_sessions_without_deleting_unknown_versions() {
        let app_data = TestDirectory::create("window-session-manifest-rebuild");
        let workspace_id = workspace_id("workspace-a");
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        let summary = repository.ensure_reference(&workspace_id).unwrap();
        repository.save(&workspace_id, None, 0, snapshot()).unwrap();
        drop(repository);

        let root = app_data.path().join(WINDOW_SESSION_DIRECTORY_NAME);
        let unknown = root.join("sessions").join(format!(
            "{}{}.json",
            super::WINDOW_STATE_REF_PREFIX,
            "b".repeat(32)
        ));
        fs::write(&unknown, "{\"schemaVersion\":2}").unwrap();
        fs::write(root.join(WINDOW_SESSION_MANIFEST_FILE_NAME), "{broken").unwrap();

        let recovered = WindowSessionRepository::initialize_at(app_data.path());
        let summaries = recovered.summaries().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].window_state_ref, summary.window_state_ref);
        assert_eq!(summaries[0].revision, 1);
        assert!(unknown.exists());
        assert!(root
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn path_identity_is_stable_and_does_not_expose_absolute_root() {
        let workspace = TestDirectory::create("window-session-path-identity");
        create_workspace(&workspace);
        let workspace_id = workspace_id("workspace-a");
        let canonical_workspace = fs::canonicalize(workspace.path()).unwrap();
        let first =
            resolve_window_tab_path(&workspace_id, &canonical_workspace, &path("notes/a.md"))
                .unwrap();
        let second =
            resolve_window_tab_path(&workspace_id, &canonical_workspace, &path("notes/a.md"))
                .unwrap();
        assert_eq!(first, second);
        assert!(!first
            .identity
            .contains(&workspace.path().to_string_lossy().to_string()));

        fs::write(
            workspace.path().join("notes/not-markdown.txt"),
            "plain text",
        )
        .unwrap();
        let unsupported = resolve_window_tab_path(
            &workspace_id,
            &canonical_workspace,
            &path("notes/not-markdown.txt"),
        )
        .unwrap_err();
        assert_eq!(unsupported.code, DesktopErrorCode::UnsupportedMarkdownFile);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn resolution_isolates_case_aliases_with_the_same_native_identity() {
        let workspace = TestDirectory::create("window-session-case-alias");
        create_workspace(&workspace);
        let workspace_id = workspace_id("workspace-a");
        let stored = super::StoredWindowTabSessionV1 {
            schema_version: super::WINDOW_SESSION_SCHEMA_VERSION,
            workspace_id,
            window_state_ref: format!("{}{}", super::WINDOW_STATE_REF_PREFIX, "a".repeat(32)),
            revision: 1,
            tabs: vec![
                PersistedWindowTab {
                    relative_path: path("notes/a.md"),
                    view: view(WindowTabEditorMode::Visual),
                    last_activated_at: 2,
                },
                PersistedWindowTab {
                    relative_path: path("notes/A.md"),
                    view: view(WindowTabEditorMode::Source),
                    last_activated_at: 1,
                },
            ],
            active_relative_path: Some(path("notes/a.md")),
            recently_closed: Vec::new(),
            updated_at: 3,
        };
        let resolved =
            resolve_window_tab_session(stored, &fs::canonicalize(workspace.path()).unwrap());

        assert_eq!(resolved.tabs.len(), 1);
        assert_eq!(resolved.issues.len(), 1);
        assert_eq!(
            resolved.issues[0].error.code,
            DesktopErrorCode::WindowSessionCorrupt
        );
    }

    #[test]
    fn contracts_match_typescript_and_enum_values() {
        let workspace_id = workspace_id("workspace-a");
        let path_contract = WorkspaceTabPathContract {
            relative_path: path("a.md"),
            identity: "workspace-path-v1-test".to_owned(),
        };
        let view = view(WindowTabEditorMode::Visual);
        let persisted = PersistedWindowTab {
            relative_path: path("a.md"),
            view: view.clone(),
            last_activated_at: 1,
        };
        let recent = PersistedRecentlyClosedTab {
            relative_path: path("closed.md"),
            view: view.clone(),
            closed_at: 2,
        };
        let resolved = ResolvedWindowTab {
            path: path_contract.clone(),
            view: view.clone(),
            last_activated_at: 1,
        };
        let resolved_recent = ResolvedRecentlyClosedTab {
            path: path_contract.clone(),
            view: view.clone(),
            closed_at: 2,
        };
        let issue = WindowTabSessionPathIssue {
            relative_path: path("missing.md"),
            error: super::window_session_corrupt(),
        };
        let session = WindowTabSession {
            schema_version: 1,
            workspace_id: workspace_id.clone(),
            window_state_ref: format!("{}{}", super::WINDOW_STATE_REF_PREFIX, "a".repeat(32)),
            revision: 1,
            tabs: vec![resolved.clone()],
            active_relative_path: Some(path("a.md")),
            recently_closed: vec![resolved_recent.clone()],
            updated_at: 3,
            issues: vec![issue.clone()],
        };
        let saved = WindowTabSessionSaveResult {
            workspace_id: workspace_id.clone(),
            window_state_ref: session.window_state_ref.clone(),
            revision: 1,
            tab_count: 1,
            updated_at: 3,
        };
        let summary = WindowTabSessionSummary {
            workspace_id,
            window_state_ref: session.window_state_ref.clone(),
            revision: 1,
            tab_count: 1,
            updated_at: 3,
            issue: None,
        };
        let snapshot = WindowTabSessionSnapshot {
            tabs: vec![persisted.clone()],
            active_relative_path: Some(path("a.md")),
            recently_closed: vec![recent.clone()],
            updated_at: 3,
        };

        assert_interface_matches("WindowTabViewState", &view);
        assert_interface_matches("PersistedWindowTab", &persisted);
        assert_interface_matches("PersistedRecentlyClosedTab", &recent);
        assert_interface_matches("WindowTabSessionSnapshot", &snapshot);
        assert_interface_matches("WorkspaceTabPathContract", &path_contract);
        assert_interface_matches("ResolvedWindowTab", &resolved);
        assert_interface_matches("ResolvedRecentlyClosedTab", &resolved_recent);
        assert_interface_matches("WindowTabSessionPathIssue", &issue);
        assert_interface_matches("WindowTabSession", &session);
        assert_interface_matches("WindowTabSessionSaveResult", &saved);
        assert_interface_matches("WindowTabSessionSummary", &summary);
        assert_type_alias_matches_variants(
            "WindowTabSelection",
            &[
                WindowTabSelection::Visual { from: 1, to: 2 },
                WindowTabSelection::Source { anchor: 3, head: 4 },
            ],
        );
        assert_type_alias_matches_variants(
            "WindowTabAnchor",
            &[
                WindowTabAnchor::Semantic {
                    block_id: Some("heading:intro".to_owned()),
                    fallback_offset: 5,
                    scroll_top: 6,
                },
                WindowTabAnchor::Source {
                    offset: 7,
                    scroll_top: 8,
                },
            ],
        );

        let rust_modes = WindowTabEditorMode::ALL
            .iter()
            .map(|mode| {
                serde_json::to_value(mode)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rust_modes,
            typescript_string_constant_values("WINDOW_TAB_EDITOR_MODES")
        );
        assert_eq!(
            vec!["visual".to_owned(), "source".to_owned()],
            typescript_string_constant_values("WINDOW_TAB_SELECTION_KINDS")
        );
        assert_eq!(
            vec!["semantic".to_owned(), "source".to_owned()],
            typescript_string_constant_values("WINDOW_TAB_ANCHOR_KINDS")
        );
    }

    #[test]
    fn manifest_unknown_version_is_not_overwritten() {
        let app_data = TestDirectory::create("window-session-manifest-version");
        let root = app_data.path().join(WINDOW_SESSION_DIRECTORY_NAME);
        fs::create_dir_all(root.join("sessions")).unwrap();
        let manifest = root.join(WINDOW_SESSION_MANIFEST_FILE_NAME);
        fs::write(&manifest, "{\"schemaVersion\":2,\"entries\":[]}").unwrap();
        let repository = WindowSessionRepository::initialize_at(app_data.path());
        assert_eq!(
            repository.current_error().unwrap().code,
            DesktopErrorCode::WindowSessionUnsupportedVersion
        );
        assert_eq!(
            fs::read_to_string(manifest).unwrap(),
            "{\"schemaVersion\":2,\"entries\":[]}"
        );
    }
}
