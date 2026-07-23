use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::read::MAX_INLINE_MARKDOWN_BYTES;
use crate::fs::{FileRevision, TextEncoding, WorkspaceId, WorkspaceRelativePath};

pub const RECOVERY_DIRECTORY_NAME: &str = "plainroot-recovery-v1";
pub const RECOVERY_MANIFEST_FILE_NAME: &str = "manifest-v1.json";
pub const RECOVERY_SCHEMA_VERSION: u32 = 1;
pub const MAX_RECOVERY_ENTRIES: usize = 32;
pub const MAX_RECOVERY_BYTES: u64 = 128 * 1024 * 1024;
pub const RECOVERY_RETENTION_MILLIS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const SNAPSHOT_DIRECTORY_NAME: &str = "snapshots";
const SNAPSHOT_ID_PREFIX: &str = "recovery-v1-";
const SNAPSHOT_FILE_PREFIX: &str = "snapshot-v1-";

#[derive(Debug, Clone, Copy)]
struct RecoveryPolicy {
    max_entries: usize,
    max_bytes: u64,
    retention_millis: u64,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            max_entries: MAX_RECOVERY_ENTRIES,
            max_bytes: MAX_RECOVERY_BYTES,
            retention_millis: RECOVERY_RETENTION_MILLIS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RecoveryDocumentKey {
    workspace_id: WorkspaceId,
    relative_path: WorkspaceRelativePath,
}

impl RecoveryDocumentKey {
    fn new(workspace_id: WorkspaceId, relative_path: WorkspaceRelativePath) -> Self {
        Self {
            workspace_id,
            relative_path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverySnapshotMetadata {
    pub snapshot_id: String,
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub base_revision: FileRevision,
    pub content_hash: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub expires_at: u64,
    pub size_bytes: u64,
}

impl RecoverySnapshotMetadata {
    fn key(&self) -> RecoveryDocumentKey {
        RecoveryDocumentKey::new(self.workspace_id.clone(), self.relative_path.clone())
    }

    fn validate(&self) -> bool {
        valid_snapshot_id(&self.snapshot_id)
            && is_markdown_relative_path(&self.relative_path)
            && valid_sha256_digest(&self.content_hash)
            && valid_revision_content_hash(&self.base_revision.content_hash)
            && self.base_revision.encoding != TextEncoding::Unsupported
            && self.base_revision.size <= MAX_INLINE_MARKDOWN_BYTES
            && self.size_bytes <= MAX_INLINE_MARKDOWN_BYTES
            && self.created_at <= self.updated_at
            && self.updated_at <= self.expires_at
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub metadata: RecoverySnapshotMetadata,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPersistStatus {
    Persisted,
    MemoryOnly,
}

impl RecoveryPersistStatus {
    pub const ALL: &'static [Self] = &[Self::Persisted, Self::MemoryOnly];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryUpsertResult {
    pub status: RecoveryPersistStatus,
    pub snapshot: Option<RecoverySnapshotMetadata>,
    pub issue: Option<DesktopError>,
}

impl RecoveryUpsertResult {
    fn persisted(snapshot: RecoverySnapshotMetadata) -> Self {
        Self {
            status: RecoveryPersistStatus::Persisted,
            snapshot: Some(snapshot),
            issue: None,
        }
    }

    fn memory_only(issue: DesktopError) -> Self {
        Self {
            status: RecoveryPersistStatus::MemoryOnly,
            snapshot: None,
            issue: Some(issue),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCleanupResult {
    pub removed: u32,
    pub remaining: u32,
    pub total_bytes: u64,
    pub limits_satisfied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryManifestEntry {
    #[serde(flatten)]
    metadata: RecoverySnapshotMetadata,
    snapshot_file_name: String,
}

impl RecoveryManifestEntry {
    fn validate(&self) -> bool {
        self.metadata.validate()
            && snapshot_file_name(&self.metadata.snapshot_id)
                .is_some_and(|expected| expected == self.snapshot_file_name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifestV1 {
    schema_version: u32,
    entries: Vec<RecoveryManifestEntry>,
}

impl Default for RecoveryManifestV1 {
    fn default() -> Self {
        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RecoveryRepositoryStatus {
    Ready,
    RecoveredCorrupt,
    UnsupportedVersion,
    Unavailable(DesktopError),
}

#[derive(Debug)]
struct RecoveryInner {
    manifest: RecoveryManifestV1,
    active_dirty: HashSet<RecoveryDocumentKey>,
    snapshot_reads: HashMap<String, usize>,
    status: RecoveryRepositoryStatus,
}

#[derive(Debug, Clone)]
pub struct RecoveryRepository {
    store: Option<Arc<RecoveryStore>>,
    inner: Arc<Mutex<RecoveryInner>>,
    policy: RecoveryPolicy,
}

impl RecoveryRepository {
    pub fn initialize_for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        match crate::app_data_directory(app) {
            Ok(app_data) => Self::initialize_at(app_data),
            Err(_) => {
                Self::unavailable(recovery_error(DesktopErrorCode::RecoveryUnavailable, true))
            }
        }
    }

    pub fn initialize_at(app_data: impl Into<PathBuf>) -> Self {
        Self::initialize_with_policy(
            app_data.into(),
            RecoveryPolicy::default(),
            RecoveryFault::None,
        )
    }

    fn initialize_with_policy(
        app_data: PathBuf,
        policy: RecoveryPolicy,
        fault: RecoveryFault,
    ) -> Self {
        let store = Arc::new(RecoveryStore::new(
            app_data.join(RECOVERY_DIRECTORY_NAME),
            fault,
        ));
        let (manifest, status) = match store.load_or_initialize() {
            Ok(RecoveryLoadOutcome::Initialized(manifest))
            | Ok(RecoveryLoadOutcome::Loaded(manifest)) => {
                (manifest, RecoveryRepositoryStatus::Ready)
            }
            Ok(RecoveryLoadOutcome::RecoveredCorrupt(manifest)) => {
                (manifest, RecoveryRepositoryStatus::RecoveredCorrupt)
            }
            Err(RecoveryLoadFailure::UnsupportedVersion) => (
                RecoveryManifestV1::default(),
                RecoveryRepositoryStatus::UnsupportedVersion,
            ),
            Err(RecoveryLoadFailure::Unavailable(error)) => (
                RecoveryManifestV1::default(),
                RecoveryRepositoryStatus::Unavailable(error),
            ),
        };
        let repository = Self {
            store: Some(store),
            inner: Arc::new(Mutex::new(RecoveryInner {
                manifest,
                active_dirty: HashSet::new(),
                snapshot_reads: HashMap::new(),
                status,
            })),
            policy,
        };
        repository.repair_startup();
        repository
    }

    fn unavailable(error: DesktopError) -> Self {
        Self {
            store: None,
            inner: Arc::new(Mutex::new(RecoveryInner {
                manifest: RecoveryManifestV1::default(),
                active_dirty: HashSet::new(),
                snapshot_reads: HashMap::new(),
                status: RecoveryRepositoryStatus::Unavailable(error),
            })),
            policy: RecoveryPolicy::default(),
        }
    }

    pub fn current_error(&self) -> Option<DesktopError> {
        let inner = self.inner.lock().ok()?;
        match &inner.status {
            RecoveryRepositoryStatus::UnsupportedVersion => Some(recovery_error(
                DesktopErrorCode::RecoveryUnsupportedVersion,
                false,
            )),
            RecoveryRepositoryStatus::Unavailable(error) => Some(error.clone()),
            _ => None,
        }
    }

    pub fn list(&self) -> Result<Vec<RecoverySnapshotMetadata>, DesktopError> {
        let inner = self.lock_inner()?;
        ensure_readable(&inner.status)?;
        let mut snapshots = inner
            .manifest
            .entries
            .iter()
            .map(|entry| entry.metadata.clone())
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.updated_at));
        Ok(snapshots)
    }

    pub fn get(
        &self,
        snapshot_id: &str,
        workspace_id: &WorkspaceId,
        relative_path: &WorkspaceRelativePath,
    ) -> Result<RecoverySnapshot, DesktopError> {
        let store = self.store()?;
        let entry = {
            let mut inner = self.lock_inner()?;
            ensure_readable(&inner.status)?;
            let entry = inner
                .manifest
                .entries
                .iter()
                .find(|entry| entry.metadata.snapshot_id == snapshot_id)
                .filter(|entry| {
                    &entry.metadata.workspace_id == workspace_id
                        && &entry.metadata.relative_path == relative_path
                })
                .cloned()
                .ok_or_else(snapshot_not_found)?;
            *inner
                .snapshot_reads
                .entry(entry.metadata.snapshot_id.clone())
                .or_insert(0) += 1;
            entry
        };
        let content = store.read_snapshot(&entry);
        let release = self.finish_snapshot_read(&entry, &store);
        let content = match (content, release) {
            (Err(error), _) => return Err(error),
            (Ok(_), Err(error)) => return Err(error),
            (Ok(content), Ok(())) => content,
        };
        Ok(RecoverySnapshot {
            metadata: entry.metadata,
            content,
        })
    }

    pub fn register_active(
        &self,
        workspace_id: WorkspaceId,
        relative_path: WorkspaceRelativePath,
    ) -> Result<bool, DesktopError> {
        let mut inner = self.lock_inner()?;
        Ok(inner
            .active_dirty
            .insert(RecoveryDocumentKey::new(workspace_id, relative_path)))
    }

    pub fn release_active(
        &self,
        workspace_id: WorkspaceId,
        relative_path: WorkspaceRelativePath,
    ) -> Result<bool, DesktopError> {
        let mut inner = self.lock_inner()?;
        Ok(inner
            .active_dirty
            .remove(&RecoveryDocumentKey::new(workspace_id, relative_path)))
    }

    pub fn upsert(
        &self,
        workspace_id: WorkspaceId,
        relative_path: WorkspaceRelativePath,
        content: String,
        base_revision: FileRevision,
    ) -> Result<RecoveryUpsertResult, DesktopError> {
        let size_bytes = u64::try_from(content.len()).unwrap_or(u64::MAX);
        validate_snapshot_input(&relative_path, &base_revision, size_bytes)?;
        let key = RecoveryDocumentKey::new(workspace_id.clone(), relative_path.clone());
        let store = self.store()?;
        {
            let inner = self.lock_inner()?;
            if !inner.active_dirty.contains(&key) {
                return Err(recovery_error(
                    DesktopErrorCode::RecoverySessionNotActive,
                    true,
                ));
            }
            if let Err(error) = ensure_writable(&inner.status) {
                return Ok(RecoveryUpsertResult::memory_only(error));
            }
        }

        let now = unix_timestamp_millis();
        let snapshot_id = secure_snapshot_id()?;
        let file_name = snapshot_file_name(&snapshot_id).ok_or_else(recovery_unavailable)?;
        let mut metadata = RecoverySnapshotMetadata {
            snapshot_id,
            workspace_id,
            relative_path,
            base_revision,
            content_hash: sha256_hex(content.as_bytes()),
            created_at: now,
            updated_at: now,
            expires_at: now.saturating_add(self.policy.retention_millis),
            size_bytes,
        };
        let new_entry = RecoveryManifestEntry {
            metadata: metadata.clone(),
            snapshot_file_name: file_name,
        };

        {
            let inner = self.lock_inner()?;
            if !inner.active_dirty.contains(&key) {
                return Err(recovery_error(
                    DesktopErrorCode::RecoverySessionNotActive,
                    true,
                ));
            }
            if let Err(error) = ensure_writable(&inner.status) {
                return Ok(RecoveryUpsertResult::memory_only(error));
            }
            let mut candidate = inner.manifest.clone();
            candidate
                .entries
                .retain(|entry| entry.metadata.key() != key);
            candidate.entries.push(new_entry.clone());
            if !plan_cleanup(&mut candidate, &inner.active_dirty, now, self.policy).limits_satisfied
            {
                return Ok(RecoveryUpsertResult::memory_only(recovery_error(
                    DesktopErrorCode::RecoveryCapacityExceeded,
                    true,
                )));
            }
        }

        if let Err(error) = store.write_snapshot(&new_entry, content.as_bytes()) {
            if let Ok(mut inner) = self.lock_inner() {
                inner.status = RecoveryRepositoryStatus::Unavailable(error.clone());
            }
            return Ok(RecoveryUpsertResult::memory_only(error));
        }

        let mut inner = match self.lock_inner() {
            Ok(inner) => inner,
            Err(error) => {
                let _ = store.remove_snapshot_file(&new_entry.snapshot_file_name);
                return Err(error);
            }
        };
        if !inner.active_dirty.contains(&key) {
            drop(inner);
            let _ = store.remove_snapshot_file(&new_entry.snapshot_file_name);
            return Err(recovery_error(
                DesktopErrorCode::RecoverySessionNotActive,
                true,
            ));
        }
        if let Err(error) = ensure_writable(&inner.status) {
            drop(inner);
            let _ = store.remove_snapshot_file(&new_entry.snapshot_file_name);
            return Ok(RecoveryUpsertResult::memory_only(error));
        }

        if let Some(existing) = inner
            .manifest
            .entries
            .iter()
            .find(|entry| entry.metadata.key() == key)
        {
            metadata.created_at = existing.metadata.created_at;
        }
        let new_entry = RecoveryManifestEntry {
            metadata: metadata.clone(),
            snapshot_file_name: new_entry.snapshot_file_name,
        };
        let mut candidate = inner.manifest.clone();
        candidate
            .entries
            .retain(|entry| entry.metadata.key() != key);
        candidate.entries.push(new_entry.clone());
        let cleanup = plan_cleanup(&mut candidate, &inner.active_dirty, now, self.policy);
        if !cleanup.limits_satisfied {
            drop(inner);
            let _ = store.remove_snapshot_file(&new_entry.snapshot_file_name);
            return Ok(RecoveryUpsertResult::memory_only(recovery_error(
                DesktopErrorCode::RecoveryCapacityExceeded,
                true,
            )));
        }
        if let Err(error) = store.save_manifest(&candidate) {
            inner.status = RecoveryRepositoryStatus::Unavailable(error.clone());
            drop(inner);
            let _ = store.remove_snapshot_file(&new_entry.snapshot_file_name);
            return Ok(RecoveryUpsertResult::memory_only(error));
        }

        let retained_files = candidate
            .entries
            .iter()
            .map(|entry| entry.snapshot_file_name.clone())
            .collect::<HashSet<_>>();
        let obsolete = inner
            .manifest
            .entries
            .iter()
            .filter(|entry| !retained_files.contains(&entry.snapshot_file_name))
            .filter(|entry| {
                !inner
                    .snapshot_reads
                    .contains_key(&entry.metadata.snapshot_id)
            })
            .map(|entry| entry.snapshot_file_name.clone())
            .collect::<Vec<_>>();
        inner.manifest = candidate;
        inner.status = RecoveryRepositoryStatus::Ready;
        drop(inner);
        for file_name in obsolete {
            let _ = store.remove_snapshot_file(&file_name);
        }
        Ok(RecoveryUpsertResult::persisted(metadata))
    }

    pub fn delete(
        &self,
        snapshot_id: &str,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, DesktopError> {
        let store = self.store()?;
        let mut inner = self.lock_inner()?;
        ensure_writable(&inner.status)?;
        let Some(entry) = inner
            .manifest
            .entries
            .iter()
            .find(|entry| entry.metadata.snapshot_id == snapshot_id)
            .filter(|entry| &entry.metadata.workspace_id == workspace_id)
            .cloned()
        else {
            return Ok(false);
        };
        if inner.active_dirty.contains(&entry.metadata.key()) {
            return Err(recovery_error(
                DesktopErrorCode::RecoverySnapshotProtected,
                true,
            ));
        }
        let mut candidate = inner.manifest.clone();
        candidate
            .entries
            .retain(|item| item.metadata.snapshot_id != snapshot_id);
        if let Err(error) = store.save_manifest(&candidate) {
            inner.status = RecoveryRepositoryStatus::Unavailable(error.clone());
            return Err(error);
        }
        inner.manifest = candidate;
        inner.status = RecoveryRepositoryStatus::Ready;
        let remove_file = !inner.snapshot_reads.contains_key(snapshot_id);
        drop(inner);
        if remove_file {
            let _ = store.remove_snapshot_file(&entry.snapshot_file_name);
        }
        Ok(true)
    }

    pub fn cleanup(&self) -> Result<RecoveryCleanupResult, DesktopError> {
        let store = self.store()?;
        let mut inner = self.lock_inner()?;
        ensure_writable(&inner.status)?;
        let mut candidate = inner.manifest.clone();
        let cleanup = plan_cleanup(
            &mut candidate,
            &inner.active_dirty,
            unix_timestamp_millis(),
            self.policy,
        );
        let mut retained_files = candidate
            .entries
            .iter()
            .map(|entry| entry.snapshot_file_name.clone())
            .collect::<HashSet<_>>();
        retained_files.extend(
            inner
                .snapshot_reads
                .keys()
                .filter_map(|snapshot_id| snapshot_file_name(snapshot_id)),
        );
        let removed_entries = inner
            .manifest
            .entries
            .iter()
            .filter(|entry| {
                !candidate
                    .entries
                    .iter()
                    .any(|candidate| candidate.metadata.snapshot_id == entry.metadata.snapshot_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        if !removed_entries.is_empty() {
            if let Err(error) = store.save_manifest(&candidate) {
                inner.status = RecoveryRepositoryStatus::Unavailable(error.clone());
                return Err(error);
            }
            inner.manifest = candidate;
            inner.status = RecoveryRepositoryStatus::Ready;
        }
        for entry in &removed_entries {
            if !inner
                .snapshot_reads
                .contains_key(&entry.metadata.snapshot_id)
            {
                let _ = store.remove_snapshot_file(&entry.snapshot_file_name);
            }
        }
        store.remove_orphans(&retained_files);
        drop(inner);
        Ok(RecoveryCleanupResult {
            removed: u32::try_from(removed_entries.len()).unwrap_or(u32::MAX),
            remaining: u32::try_from(cleanup.remaining).unwrap_or(u32::MAX),
            total_bytes: cleanup.total_bytes,
            limits_satisfied: cleanup.limits_satisfied,
        })
    }

    fn repair_startup(&self) {
        let Ok(store) = self.store() else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if ensure_writable(&inner.status).is_err() {
            return;
        }
        let mut candidate = inner.manifest.clone();
        candidate
            .entries
            .retain(|entry| store.snapshot_metadata_is_valid(entry));
        let cleanup = plan_cleanup(
            &mut candidate,
            &inner.active_dirty,
            unix_timestamp_millis(),
            self.policy,
        );
        let changed = candidate != inner.manifest;
        if changed {
            if let Err(error) = store.save_manifest(&candidate) {
                inner.status = RecoveryRepositoryStatus::Unavailable(error);
                return;
            }
            inner.manifest = candidate;
            inner.status = RecoveryRepositoryStatus::Ready;
        }
        let retained = inner
            .manifest
            .entries
            .iter()
            .map(|entry| entry.snapshot_file_name.clone())
            .collect::<HashSet<_>>();
        drop(inner);
        store.remove_orphans(&retained);
        let _ = cleanup;
    }

    fn store(&self) -> Result<Arc<RecoveryStore>, DesktopError> {
        self.store.clone().ok_or_else(recovery_unavailable)
    }

    fn finish_snapshot_read(
        &self,
        entry: &RecoveryManifestEntry,
        store: &RecoveryStore,
    ) -> Result<(), DesktopError> {
        let remove_file = {
            let mut inner = self.lock_inner()?;
            let snapshot_id = &entry.metadata.snapshot_id;
            let Some(readers) = inner.snapshot_reads.get_mut(snapshot_id) else {
                return Err(recovery_unavailable());
            };
            if *readers == 0 {
                return Err(recovery_unavailable());
            }
            *readers -= 1;
            if *readers == 0 {
                inner.snapshot_reads.remove(snapshot_id);
            }
            !inner.snapshot_reads.contains_key(snapshot_id)
                && !inner
                    .manifest
                    .entries
                    .iter()
                    .any(|item| item.metadata.snapshot_id == *snapshot_id)
        };
        if remove_file {
            let _ = store.remove_snapshot_file(&entry.snapshot_file_name);
        }
        Ok(())
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, RecoveryInner>, DesktopError> {
        self.inner.lock().map_err(|_| recovery_unavailable())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryFault {
    None,
    #[cfg(test)]
    AfterSnapshotSync,
    #[cfg(test)]
    BeforeManifestReplace,
}

#[derive(Debug)]
struct RecoveryStore {
    root: PathBuf,
    manifest_path: PathBuf,
    snapshots_path: PathBuf,
    #[cfg(test)]
    fault: RecoveryFault,
}

impl RecoveryStore {
    fn new(root: PathBuf, fault: RecoveryFault) -> Self {
        #[cfg(not(test))]
        let _ = fault;
        Self {
            manifest_path: root.join(RECOVERY_MANIFEST_FILE_NAME),
            snapshots_path: root.join(SNAPSHOT_DIRECTORY_NAME),
            root,
            #[cfg(test)]
            fault,
        }
    }

    fn load_or_initialize(&self) -> Result<RecoveryLoadOutcome, RecoveryLoadFailure> {
        self.create_directories()
            .map_err(RecoveryLoadFailure::Unavailable)?;
        let bytes = match File::open(&self.manifest_path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_MANIFEST_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| {
                        RecoveryLoadFailure::Unavailable(recovery_error(
                            DesktopErrorCode::RecoveryReadFailed,
                            true,
                        ))
                    })?;
                bytes
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let manifest = RecoveryManifestV1::default();
                self.save_manifest(&manifest)
                    .map_err(RecoveryLoadFailure::Unavailable)?;
                return Ok(RecoveryLoadOutcome::Initialized(manifest));
            }
            Err(_) => {
                return Err(RecoveryLoadFailure::Unavailable(recovery_error(
                    DesktopErrorCode::RecoveryReadFailed,
                    true,
                )));
            }
        };
        if bytes.len() > MAX_MANIFEST_BYTES {
            return self.recover_corrupt(RecoveryManifestV1::default());
        }
        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return self.recover_corrupt(RecoveryManifestV1::default()),
        };
        let Some(found_version) = value.get("schemaVersion").and_then(Value::as_u64) else {
            return self.recover_corrupt(RecoveryManifestV1::default());
        };
        if found_version != u64::from(RECOVERY_SCHEMA_VERSION) {
            return Err(RecoveryLoadFailure::UnsupportedVersion);
        }
        let Some(entries) = value.get("entries").and_then(Value::as_array) else {
            return self.recover_corrupt(RecoveryManifestV1::default());
        };
        let mut recovered = false;
        let mut manifest = RecoveryManifestV1::default();
        let mut keys = HashSet::new();
        let mut ids = HashSet::new();
        let mut files = HashSet::new();
        for value in entries {
            let Ok(entry) = serde_json::from_value::<RecoveryManifestEntry>(value.clone()) else {
                recovered = true;
                continue;
            };
            let valid = entry.validate()
                && keys.insert(entry.metadata.key())
                && ids.insert(entry.metadata.snapshot_id.clone())
                && files.insert(entry.snapshot_file_name.clone());
            if valid {
                manifest.entries.push(entry);
            } else {
                recovered = true;
            }
        }
        if recovered {
            self.recover_corrupt(manifest)
        } else {
            Ok(RecoveryLoadOutcome::Loaded(manifest))
        }
    }

    fn create_directories(&self) -> Result<(), DesktopError> {
        fs::create_dir_all(&self.snapshots_path)
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .and_then(|_| {
                    fs::set_permissions(&self.snapshots_path, fs::Permissions::from_mode(0o700))
                })
                .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        }
        Ok(())
    }

    fn recover_corrupt(
        &self,
        manifest: RecoveryManifestV1,
    ) -> Result<RecoveryLoadOutcome, RecoveryLoadFailure> {
        let backup = self.next_corrupt_backup_path();
        fs::rename(&self.manifest_path, &backup).map_err(|_| {
            RecoveryLoadFailure::Unavailable(recovery_error(
                DesktopErrorCode::RecoveryWriteFailed,
                true,
            ))
        })?;
        self.save_manifest(&manifest)
            .map_err(RecoveryLoadFailure::Unavailable)?;
        Ok(RecoveryLoadOutcome::RecoveredCorrupt(manifest))
    }

    fn next_corrupt_backup_path(&self) -> PathBuf {
        let timestamp = unix_timestamp_millis();
        for collision in 0_u32.. {
            let suffix = if collision == 0 {
                format!(".corrupt-{timestamp}")
            } else {
                format!(".corrupt-{timestamp}-{collision}")
            };
            let candidate = self
                .manifest_path
                .with_file_name(format!("{RECOVERY_MANIFEST_FILE_NAME}{suffix}"));
            if !candidate.exists() {
                return candidate;
            }
        }
        unreachable!("recovery backup namespace should not be exhausted")
    }

    fn save_manifest(&self, manifest: &RecoveryManifestV1) -> Result<(), DesktopError> {
        let mut bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, false));
        }
        let (mut file, temp_path) = create_private_temp_file(&self.manifest_path, "manifest")?;
        let mut guard = TempFileGuard::new(temp_path.clone());
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        drop(file);
        #[cfg(test)]
        if self.fault == RecoveryFault::BeforeManifestReplace {
            return Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, true));
        }
        crate::fs::atomic::replace_existing(&temp_path, &self.manifest_path)
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        guard.disarm();
        // The content file was synced before replacement. A parent-directory sync failure after
        // commit is diagnostic only; reporting failure here would falsely imply the old manifest
        // is still authoritative.
        let _ = crate::fs::atomic::sync_parent_directory(&self.manifest_path);
        Ok(())
    }

    fn write_snapshot(
        &self,
        entry: &RecoveryManifestEntry,
        bytes: &[u8],
    ) -> Result<(), DesktopError> {
        let target = self.snapshots_path.join(&entry.snapshot_file_name);
        let (mut file, temp_path) = create_private_temp_file(&target, "snapshot")?;
        let mut guard = TempFileGuard::new(temp_path.clone());
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        drop(file);
        #[cfg(test)]
        if self.fault == RecoveryFault::AfterSnapshotSync {
            return Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, true));
        }
        crate::fs::atomic::rename_without_replace(&temp_path, &target)
            .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))?;
        guard.disarm();
        let _ = crate::fs::atomic::sync_parent_directory(&target);
        Ok(())
    }

    fn read_snapshot(&self, entry: &RecoveryManifestEntry) -> Result<String, DesktopError> {
        let path = self.snapshots_path.join(&entry.snapshot_file_name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| snapshot_corrupt())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != entry.metadata.size_bytes
            || metadata.len() > MAX_INLINE_MARKDOWN_BYTES
        {
            return Err(snapshot_corrupt());
        }
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
        File::open(&path)
            .and_then(|file| {
                file.take(MAX_INLINE_MARKDOWN_BYTES + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|_| snapshot_corrupt())?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != entry.metadata.size_bytes
            || sha256_hex(&bytes) != entry.metadata.content_hash
        {
            return Err(snapshot_corrupt());
        }
        String::from_utf8(bytes).map_err(|_| snapshot_corrupt())
    }

    fn snapshot_metadata_is_valid(&self, entry: &RecoveryManifestEntry) -> bool {
        let path = self.snapshots_path.join(&entry.snapshot_file_name);
        fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() == entry.metadata.size_bytes
                && metadata.len() <= MAX_INLINE_MARKDOWN_BYTES
        })
    }

    fn remove_snapshot_file(&self, file_name: &str) -> Result<(), DesktopError> {
        if !valid_snapshot_file_name(file_name) {
            return Err(recovery_unavailable());
        }
        let path = self.snapshots_path.join(file_name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                fs::remove_file(path)
                    .map_err(|_| recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, true)),
        }
    }

    fn remove_orphans(&self, retained: &HashSet<String>) {
        let Ok(entries) = fs::read_dir(&self.snapshots_path) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let owned_snapshot =
                valid_snapshot_file_name(&name) && !retained.contains(name.as_str());
            let owned_temp = name.starts_with(".plainroot-recovery-") && name.contains(".tmp-");
            if !owned_snapshot && !owned_temp {
                continue;
            }
            let path = entry.path();
            if fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[derive(Debug)]
enum RecoveryLoadOutcome {
    Initialized(RecoveryManifestV1),
    Loaded(RecoveryManifestV1),
    RecoveredCorrupt(RecoveryManifestV1),
}

#[derive(Debug)]
enum RecoveryLoadFailure {
    UnsupportedVersion,
    Unavailable(DesktopError),
}

#[derive(Debug)]
struct CleanupPlan {
    remaining: usize,
    total_bytes: u64,
    limits_satisfied: bool,
}

fn plan_cleanup(
    manifest: &mut RecoveryManifestV1,
    active: &HashSet<RecoveryDocumentKey>,
    now: u64,
    policy: RecoveryPolicy,
) -> CleanupPlan {
    manifest
        .entries
        .sort_by_key(|entry| entry.metadata.updated_at);
    manifest
        .entries
        .retain(|entry| entry.metadata.expires_at > now || active.contains(&entry.metadata.key()));
    while !limits_satisfied(&manifest.entries, policy) {
        let Some(index) = manifest
            .entries
            .iter()
            .position(|entry| !active.contains(&entry.metadata.key()))
        else {
            break;
        };
        manifest.entries.remove(index);
    }
    manifest
        .entries
        .sort_by_key(|entry| std::cmp::Reverse(entry.metadata.updated_at));
    let total_bytes = manifest
        .entries
        .iter()
        .map(|entry| entry.metadata.size_bytes)
        .sum();
    CleanupPlan {
        remaining: manifest.entries.len(),
        total_bytes,
        limits_satisfied: limits_satisfied(&manifest.entries, policy),
    }
}

fn limits_satisfied(entries: &[RecoveryManifestEntry], policy: RecoveryPolicy) -> bool {
    entries.len() <= policy.max_entries
        && entries
            .iter()
            .map(|entry| entry.metadata.size_bytes)
            .sum::<u64>()
            <= policy.max_bytes
}

fn validate_snapshot_input(
    relative_path: &WorkspaceRelativePath,
    base_revision: &FileRevision,
    size_bytes: u64,
) -> Result<(), DesktopError> {
    if !is_markdown_relative_path(relative_path)
        || !valid_revision_content_hash(&base_revision.content_hash)
        || base_revision.encoding == TextEncoding::Unsupported
        || base_revision.size > MAX_INLINE_MARKDOWN_BYTES
    {
        return Err(recovery_error(DesktopErrorCode::RecoveryUnavailable, false));
    }
    if size_bytes > MAX_INLINE_MARKDOWN_BYTES {
        return Err(DesktopError::new(
            DesktopErrorCode::FileTooLarge,
            true,
            false,
        ));
    }
    Ok(())
}

fn is_markdown_relative_path(path: &WorkspaceRelativePath) -> bool {
    Path::new(path.as_str())
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn valid_sha256_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_revision_content_hash(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(valid_sha256_digest)
}

fn valid_snapshot_id(value: &str) -> bool {
    value
        .strip_prefix(SNAPSHOT_ID_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn snapshot_file_name(snapshot_id: &str) -> Option<String> {
    let suffix = snapshot_id.strip_prefix(SNAPSHOT_ID_PREFIX)?;
    Some(format!("{SNAPSHOT_FILE_PREFIX}{suffix}.md"))
}

fn valid_snapshot_file_name(value: &str) -> bool {
    value
        .strip_prefix(SNAPSHOT_FILE_PREFIX)
        .and_then(|suffix| suffix.strip_suffix(".md"))
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn secure_snapshot_id() -> Result<String, DesktopError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| recovery_unavailable())?;
    let mut value = String::from(SNAPSHOT_ID_PREFIX);
    for byte in random {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut value = String::with_capacity(64);
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

fn create_private_temp_file(target: &Path, scope: &str) -> Result<(File, PathBuf), DesktopError> {
    let parent = target.parent().ok_or_else(recovery_unavailable)?;
    for _ in 0..100 {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(|_| recovery_unavailable())?;
        let mut suffix = String::with_capacity(16);
        for byte in random {
            write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
        }
        let path = parent.join(format!(
            ".plainroot-recovery-{scope}.tmp-{}-{suffix}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, true));
            }
        }
    }
    Err(recovery_error(DesktopErrorCode::RecoveryWriteFailed, true))
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

fn ensure_readable(status: &RecoveryRepositoryStatus) -> Result<(), DesktopError> {
    match status {
        RecoveryRepositoryStatus::UnsupportedVersion => Err(recovery_error(
            DesktopErrorCode::RecoveryUnsupportedVersion,
            false,
        )),
        RecoveryRepositoryStatus::Unavailable(error)
            if error.code != DesktopErrorCode::RecoveryWriteFailed =>
        {
            Err(error.clone())
        }
        _ => Ok(()),
    }
}

fn ensure_writable(status: &RecoveryRepositoryStatus) -> Result<(), DesktopError> {
    match status {
        RecoveryRepositoryStatus::UnsupportedVersion => Err(recovery_error(
            DesktopErrorCode::RecoveryUnsupportedVersion,
            false,
        )),
        RecoveryRepositoryStatus::Unavailable(error)
            if error.code != DesktopErrorCode::RecoveryWriteFailed =>
        {
            Err(error.clone())
        }
        _ => Ok(()),
    }
}

fn recovery_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

fn recovery_unavailable() -> DesktopError {
    recovery_error(DesktopErrorCode::RecoveryUnavailable, true)
}

fn snapshot_not_found() -> DesktopError {
    recovery_error(DesktopErrorCode::RecoverySnapshotNotFound, false)
}

fn snapshot_corrupt() -> DesktopError {
    recovery_error(DesktopErrorCode::RecoverySnapshotCorrupt, true)
}

fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::fs::{LineEnding, TextEncoding};
    use crate::test_support::TestDirectory;

    use super::*;

    struct Fixture {
        root: TestDirectory,
        app_data: PathBuf,
    }

    impl Fixture {
        fn new(scope: &str) -> Self {
            let root = TestDirectory::create(scope);
            let app_data = root.path().join("app-data");
            fs::create_dir_all(&app_data).unwrap();
            Self { root, app_data }
        }

        fn repository(&self) -> RecoveryRepository {
            RecoveryRepository::initialize_at(self.app_data.clone())
        }

        fn recovery_root(&self) -> PathBuf {
            self.app_data.join(RECOVERY_DIRECTORY_NAME)
        }

        fn snapshot_directory(&self) -> PathBuf {
            self.recovery_root().join(SNAPSHOT_DIRECTORY_NAME)
        }
    }

    fn workspace(value: &str) -> WorkspaceId {
        WorkspaceId::parse(value).unwrap()
    }

    fn path(value: &str) -> WorkspaceRelativePath {
        WorkspaceRelativePath::parse(value).unwrap()
    }

    fn revision(content: &str) -> FileRevision {
        FileRevision {
            modified_at: 1_700_000_000_000,
            size: content.len() as u64,
            content_hash: format!("sha256:{}", sha256_hex(content.as_bytes())),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        }
    }

    fn activate(
        repository: &RecoveryRepository,
        workspace_id: &WorkspaceId,
        relative_path: &WorkspaceRelativePath,
    ) {
        repository
            .register_active(workspace_id.clone(), relative_path.clone())
            .unwrap();
    }

    fn persist(
        repository: &RecoveryRepository,
        workspace_id: &WorkspaceId,
        relative_path: &WorkspaceRelativePath,
        content: &str,
    ) -> RecoverySnapshotMetadata {
        repository
            .upsert(
                workspace_id.clone(),
                relative_path.clone(),
                content.to_owned(),
                revision("disk\n"),
            )
            .unwrap()
            .snapshot
            .expect("snapshot should persist")
    }

    #[test]
    fn active_session_persists_private_opaque_snapshot_and_reads_it_back() {
        let fixture = Fixture::new("recovery-roundtrip");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-recovery");
        let relative_path = path("notes/private.md");
        activate(&repository, &workspace_id, &relative_path);

        let metadata = persist(
            &repository,
            &workspace_id,
            &relative_path,
            "# unsaved\nsecret body\n",
        );

        assert!(valid_snapshot_id(&metadata.snapshot_id));
        assert_eq!(repository.list().unwrap(), vec![metadata.clone()]);
        let snapshot = repository
            .get(&metadata.snapshot_id, &workspace_id, &relative_path)
            .unwrap();
        assert_eq!(snapshot.content, "# unsaved\nsecret body\n");
        let manifest =
            fs::read_to_string(fixture.recovery_root().join(RECOVERY_MANIFEST_FILE_NAME)).unwrap();
        assert!(!manifest.contains("secret body"));
        assert!(!manifest.contains(fixture.root.path().to_string_lossy().as_ref()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_name = snapshot_file_name(&metadata.snapshot_id).unwrap();
            let mode = fs::metadata(fixture.snapshot_directory().join(file_name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn upsert_requires_active_dirty_registration() {
        let fixture = Fixture::new("recovery-active-required");
        let repository = fixture.repository();
        let error = repository
            .upsert(
                workspace("workspace-one"),
                path("note.md"),
                "dirty".to_owned(),
                revision("disk"),
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::RecoverySessionNotActive);
        assert!(repository.list().unwrap().is_empty());
    }

    #[test]
    fn repeated_document_upsert_replaces_only_after_manifest_commit() {
        let fixture = Fixture::new("recovery-replace");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let first = persist(&repository, &workspace_id, &relative_path, "first");
        let second = persist(&repository, &workspace_id, &relative_path, "second");

        assert_ne!(first.snapshot_id, second.snapshot_id);
        assert_eq!(repository.list().unwrap(), vec![second.clone()]);
        assert_eq!(
            repository
                .get(&second.snapshot_id, &workspace_id, &relative_path)
                .unwrap()
                .content,
            "second"
        );
        assert!(!fixture
            .snapshot_directory()
            .join(snapshot_file_name(&first.snapshot_id).unwrap())
            .exists());
    }

    #[test]
    fn every_injected_commit_failure_preserves_previous_snapshot_and_cleans_remnants() {
        for fault in [
            RecoveryFault::AfterSnapshotSync,
            RecoveryFault::BeforeManifestReplace,
        ] {
            let fixture = Fixture::new("recovery-fault");
            let healthy = fixture.repository();
            let workspace_id = workspace("workspace-one");
            let relative_path = path("note.md");
            activate(&healthy, &workspace_id, &relative_path);
            let first = persist(&healthy, &workspace_id, &relative_path, "first");
            drop(healthy);

            let failing = RecoveryRepository::initialize_with_policy(
                fixture.app_data.clone(),
                RecoveryPolicy::default(),
                fault,
            );
            activate(&failing, &workspace_id, &relative_path);
            let outcome = failing
                .upsert(
                    workspace_id.clone(),
                    relative_path.clone(),
                    "second".to_owned(),
                    revision("disk"),
                )
                .unwrap();
            assert_eq!(outcome.status, RecoveryPersistStatus::MemoryOnly);
            assert_eq!(
                outcome.issue.unwrap().code,
                DesktopErrorCode::RecoveryWriteFailed
            );
            assert_eq!(
                failing
                    .get(&first.snapshot_id, &workspace_id, &relative_path)
                    .unwrap()
                    .content,
                "first"
            );
            let owned_files = fs::read_dir(fixture.snapshot_directory())
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_type().unwrap().is_file())
                .collect::<Vec<_>>();
            assert_eq!(owned_files.len(), 1);
        }
    }

    #[test]
    fn capacity_never_evicts_active_last_snapshots_and_recovers_after_release() {
        let fixture = Fixture::new("recovery-capacity");
        let policy = RecoveryPolicy {
            max_entries: 2,
            max_bytes: 8,
            retention_millis: RECOVERY_RETENTION_MILLIS,
        };
        let repository = RecoveryRepository::initialize_with_policy(
            fixture.app_data.clone(),
            policy,
            RecoveryFault::None,
        );
        let workspace_id = workspace("workspace-one");
        let first_path = path("first.md");
        let second_path = path("second.md");
        let third_path = path("third.md");
        for relative_path in [&first_path, &second_path, &third_path] {
            activate(&repository, &workspace_id, relative_path);
        }
        let first = persist(&repository, &workspace_id, &first_path, "1111");
        let second = persist(&repository, &workspace_id, &second_path, "2222");
        let blocked = repository
            .upsert(
                workspace_id.clone(),
                third_path.clone(),
                "3".to_owned(),
                revision("disk"),
            )
            .unwrap();
        assert_eq!(blocked.status, RecoveryPersistStatus::MemoryOnly);
        assert_eq!(
            blocked.issue.unwrap().code,
            DesktopErrorCode::RecoveryCapacityExceeded
        );
        assert_eq!(repository.list().unwrap().len(), 2);

        repository
            .release_active(workspace_id.clone(), first_path)
            .unwrap();
        let third = persist(&repository, &workspace_id, &third_path, "3");
        let ids = repository
            .list()
            .unwrap()
            .into_iter()
            .map(|metadata| metadata.snapshot_id)
            .collect::<HashSet<_>>();
        assert!(!ids.contains(&first.snapshot_id));
        assert!(ids.contains(&second.snapshot_id));
        assert!(ids.contains(&third.snapshot_id));
    }

    #[test]
    fn configured_capacity_represents_two_full_documents_but_not_a_third_byte() {
        let policy = RecoveryPolicy::default();
        let active = HashSet::from([
            RecoveryDocumentKey::new(workspace("workspace-one"), path("one.md")),
            RecoveryDocumentKey::new(workspace("workspace-one"), path("two.md")),
            RecoveryDocumentKey::new(workspace("workspace-one"), path("three.md")),
        ]);
        let mut manifest = RecoveryManifestV1 {
            schema_version: RECOVERY_SCHEMA_VERSION,
            entries: vec![
                test_entry(1, "one.md", MAX_INLINE_MARKDOWN_BYTES, 1),
                test_entry(2, "two.md", MAX_INLINE_MARKDOWN_BYTES, 2),
                test_entry(3, "three.md", 1, 3),
            ],
        };
        let cleanup = plan_cleanup(&mut manifest, &active, 0, policy);
        assert_eq!(MAX_INLINE_MARKDOWN_BYTES * 2, MAX_RECOVERY_BYTES);
        assert!(!cleanup.limits_satisfied);
        assert_eq!(cleanup.total_bytes, MAX_RECOVERY_BYTES + 1);
    }

    #[test]
    fn cleanup_removes_expired_inactive_snapshot_but_protects_active_snapshot() {
        let fixture = Fixture::new("recovery-expiry");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let active_path = path("active.md");
        let inactive_path = path("inactive.md");
        activate(&repository, &workspace_id, &active_path);
        activate(&repository, &workspace_id, &inactive_path);
        let active = persist(&repository, &workspace_id, &active_path, "active");
        let inactive = persist(&repository, &workspace_id, &inactive_path, "inactive");
        repository
            .release_active(workspace_id.clone(), inactive_path)
            .unwrap();
        {
            let store = repository.store().unwrap();
            let mut inner = repository.lock_inner().unwrap();
            for entry in &mut inner.manifest.entries {
                entry.metadata.expires_at = 0;
            }
            store.save_manifest(&inner.manifest).unwrap();
        }

        let result = repository.cleanup().unwrap();
        assert_eq!(result.removed, 1);
        assert!(result.limits_satisfied);
        let remaining = repository.list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].snapshot_id, active.snapshot_id);
        assert_eq!(remaining[0].expires_at, 0);
        assert!(!fixture
            .snapshot_directory()
            .join(snapshot_file_name(&inactive.snapshot_id).unwrap())
            .exists());
    }

    #[test]
    fn active_snapshot_requires_release_before_explicit_delete() {
        let fixture = Fixture::new("recovery-delete");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let snapshot = persist(&repository, &workspace_id, &relative_path, "dirty");

        let error = repository
            .delete(&snapshot.snapshot_id, &workspace_id)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::RecoverySnapshotProtected);
        repository
            .release_active(workspace_id.clone(), relative_path)
            .unwrap();
        assert!(repository
            .delete(&snapshot.snapshot_id, &workspace_id)
            .unwrap());
        assert!(repository.list().unwrap().is_empty());
    }

    #[test]
    fn delete_rejects_a_snapshot_owned_by_another_workspace() {
        let fixture = Fixture::new("recovery-delete-workspace");
        let repository = fixture.repository();
        let owner = workspace("workspace-owner");
        let other = workspace("workspace-other");
        let relative_path = path("note.md");
        activate(&repository, &owner, &relative_path);
        let snapshot = persist(&repository, &owner, &relative_path, "dirty");
        repository
            .release_active(owner.clone(), relative_path.clone())
            .unwrap();

        assert!(!repository.delete(&snapshot.snapshot_id, &other).unwrap());
        assert_eq!(
            repository
                .get(&snapshot.snapshot_id, &owner, &relative_path)
                .unwrap()
                .content,
            "dirty"
        );
    }

    #[test]
    fn a_leased_snapshot_file_is_removed_only_after_its_last_reader_releases() {
        let fixture = Fixture::new("recovery-read-lease");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let snapshot = persist(&repository, &workspace_id, &relative_path, "dirty");
        repository
            .release_active(workspace_id.clone(), relative_path)
            .unwrap();
        let entry = {
            let mut inner = repository.lock_inner().unwrap();
            let entry = inner.manifest.entries[0].clone();
            inner.snapshot_reads.insert(snapshot.snapshot_id.clone(), 1);
            entry
        };
        let snapshot_path = fixture.snapshot_directory().join(&entry.snapshot_file_name);

        assert!(repository
            .delete(&snapshot.snapshot_id, &workspace_id)
            .unwrap());
        assert!(snapshot_path.exists());
        repository
            .finish_snapshot_read(&entry, repository.store().unwrap().as_ref())
            .unwrap();
        assert!(!snapshot_path.exists());
    }

    #[test]
    fn corrupt_snapshot_is_isolated_from_other_valid_snapshot() {
        let fixture = Fixture::new("recovery-corrupt-snapshot");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let bad_path = path("bad.md");
        let good_path = path("good.md");
        activate(&repository, &workspace_id, &bad_path);
        activate(&repository, &workspace_id, &good_path);
        let bad = persist(&repository, &workspace_id, &bad_path, "bad");
        let good = persist(&repository, &workspace_id, &good_path, "good");
        fs::write(
            fixture
                .snapshot_directory()
                .join(snapshot_file_name(&bad.snapshot_id).unwrap()),
            b"BAD",
        )
        .unwrap();

        assert_eq!(
            repository
                .get(&bad.snapshot_id, &workspace_id, &bad_path)
                .unwrap_err()
                .code,
            DesktopErrorCode::RecoverySnapshotCorrupt
        );
        assert_eq!(
            repository
                .get(&good.snapshot_id, &workspace_id, &good_path)
                .unwrap()
                .content,
            "good"
        );
    }

    #[test]
    fn snapshot_content_requires_exact_authorized_identity() {
        let fixture = Fixture::new("recovery-identity");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let snapshot = persist(&repository, &workspace_id, &relative_path, "dirty");

        for (wrong_workspace, wrong_path) in [
            (workspace("workspace-two"), relative_path.clone()),
            (workspace_id.clone(), path("other.md")),
        ] {
            assert_eq!(
                repository
                    .get(&snapshot.snapshot_id, &wrong_workspace, &wrong_path)
                    .unwrap_err()
                    .code,
                DesktopErrorCode::RecoverySnapshotNotFound
            );
        }
    }

    #[test]
    fn invalid_revision_and_oversized_snapshot_are_rejected_before_disk_write() {
        let relative_path = path("note.md");
        let mut invalid_revision = revision("disk");
        invalid_revision.content_hash = "not-sha256".to_owned();
        assert_eq!(
            validate_snapshot_input(&relative_path, &invalid_revision, 1)
                .unwrap_err()
                .code,
            DesktopErrorCode::RecoveryUnavailable
        );
        assert_eq!(
            validate_snapshot_input(
                &relative_path,
                &revision("disk"),
                MAX_INLINE_MARKDOWN_BYTES + 1,
            )
            .unwrap_err()
            .code,
            DesktopErrorCode::FileTooLarge
        );
    }

    #[test]
    fn startup_drops_only_metadata_whose_snapshot_file_is_missing() {
        let fixture = Fixture::new("recovery-missing-snapshot");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let missing_path = path("missing.md");
        let good_path = path("good.md");
        activate(&repository, &workspace_id, &missing_path);
        activate(&repository, &workspace_id, &good_path);
        let missing = persist(&repository, &workspace_id, &missing_path, "missing");
        let good = persist(&repository, &workspace_id, &good_path, "good");
        fs::remove_file(
            fixture
                .snapshot_directory()
                .join(snapshot_file_name(&missing.snapshot_id).unwrap()),
        )
        .unwrap();
        drop(repository);

        let repaired = fixture.repository();
        assert_eq!(repaired.list().unwrap(), vec![good]);
    }

    #[test]
    fn invalid_manifest_entry_is_backed_up_without_losing_valid_entry() {
        let fixture = Fixture::new("recovery-corrupt-manifest");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let valid = persist(&repository, &workspace_id, &relative_path, "valid");
        drop(repository);

        let manifest_path = fixture.recovery_root().join(RECOVERY_MANIFEST_FILE_NAME);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["entries"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"snapshotId": "../../escape"}));
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let recovered = fixture.repository();
        assert_eq!(recovered.list().unwrap(), vec![valid]);
        assert!(fs::read_dir(fixture.recovery_root())
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("manifest-v1.json.corrupt-")));
    }

    #[test]
    fn unknown_manifest_version_is_preserved_and_degrades_upsert_to_memory_only() {
        let fixture = Fixture::new("recovery-unknown-version");
        let store = RecoveryStore::new(fixture.recovery_root(), RecoveryFault::None);
        store.create_directories().unwrap();
        let unknown = br#"{"schemaVersion":2,"entries":[]}"#;
        fs::write(&store.manifest_path, unknown).unwrap();
        let repository = fixture.repository();
        assert_eq!(
            repository.current_error().unwrap().code,
            DesktopErrorCode::RecoveryUnsupportedVersion
        );
        assert_eq!(fs::read(&store.manifest_path).unwrap(), unknown);
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let outcome = repository
            .upsert(
                workspace_id,
                relative_path,
                "dirty".to_owned(),
                revision("disk"),
            )
            .unwrap();
        assert_eq!(outcome.status, RecoveryPersistStatus::MemoryOnly);
        assert_eq!(
            outcome.issue.unwrap().code,
            DesktopErrorCode::RecoveryUnsupportedVersion
        );
        assert_eq!(fs::read(&store.manifest_path).unwrap(), unknown);
    }

    #[test]
    fn transient_write_failure_status_recovers_on_the_next_successful_upsert() {
        let fixture = Fixture::new("recovery-runtime-retry");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        {
            let mut inner = repository.lock_inner().unwrap();
            inner.status = RecoveryRepositoryStatus::Unavailable(recovery_error(
                DesktopErrorCode::RecoveryWriteFailed,
                true,
            ));
        }

        let outcome = repository
            .upsert(
                workspace_id,
                relative_path,
                "retry succeeds".to_owned(),
                revision("disk"),
            )
            .unwrap();

        assert_eq!(outcome.status, RecoveryPersistStatus::Persisted);
        assert!(repository.current_error().is_none());
    }

    #[test]
    fn startup_removes_only_owned_regular_orphans_and_temp_files() {
        let fixture = Fixture::new("recovery-orphans");
        let repository = fixture.repository();
        drop(repository);
        let orphan = fixture
            .snapshot_directory()
            .join(format!("{SNAPSHOT_FILE_PREFIX}{}.md", "a".repeat(32)));
        let temp = fixture
            .snapshot_directory()
            .join(".plainroot-recovery-snapshot.tmp-1-deadbeef");
        let unrelated = fixture.snapshot_directory().join("keep.txt");
        fs::write(&orphan, b"orphan").unwrap();
        fs::write(&temp, b"temp").unwrap();
        fs::write(&unrelated, b"keep").unwrap();

        let _ = fixture.repository();
        assert!(!orphan.exists());
        assert!(!temp.exists());
        assert!(unrelated.exists());
    }

    #[cfg(unix)]
    #[test]
    fn app_data_permission_failure_degrades_to_memory_only_and_preserves_previous_snapshot() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new("recovery-permission");
        let repository = fixture.repository();
        let workspace_id = workspace("workspace-one");
        let relative_path = path("note.md");
        activate(&repository, &workspace_id, &relative_path);
        let previous = persist(&repository, &workspace_id, &relative_path, "previous");
        fs::set_permissions(
            fixture.snapshot_directory(),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();

        let outcome = repository
            .upsert(
                workspace_id.clone(),
                relative_path.clone(),
                "new".to_owned(),
                revision("disk"),
            )
            .unwrap();
        assert_eq!(outcome.status, RecoveryPersistStatus::MemoryOnly);
        assert_eq!(
            outcome.issue.unwrap().code,
            DesktopErrorCode::RecoveryWriteFailed
        );
        assert_eq!(
            repository
                .get(&previous.snapshot_id, &workspace_id, &relative_path)
                .unwrap()
                .content,
            "previous"
        );
        fs::set_permissions(
            fixture.snapshot_directory(),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_app_data_path_fails_safely_without_leaking_absolute_path() {
        use std::os::unix::ffi::OsStringExt;

        let fixture = Fixture::new("recovery-non-utf8");
        let invalid = std::ffi::OsString::from_vec(vec![b'a', b'p', b'p', 0xff]);
        let app_data = fixture.root.path().join(invalid);
        let repository = RecoveryRepository::initialize_at(app_data);
        let error = repository
            .current_error()
            .expect("unsupported native path should fail safely");
        assert_eq!(error.code, DesktopErrorCode::RecoveryWriteFailed);
        assert!(error.path_hint.is_none());
    }

    #[test]
    fn recovery_contracts_and_status_values_match_typescript() {
        let metadata = test_entry(1, "note.md", 5, 10).metadata;
        let snapshot = RecoverySnapshot {
            metadata: metadata.clone(),
            content: "dirty".to_owned(),
        };
        let persisted = RecoveryUpsertResult::persisted(metadata.clone());
        let cleanup = RecoveryCleanupResult {
            removed: 1,
            remaining: 1,
            total_bytes: 5,
            limits_satisfied: true,
        };
        assert_interface_matches("RecoverySnapshotMetadata", &metadata);
        assert_interface_matches("RecoverySnapshot", &snapshot);
        assert_interface_matches("RecoveryUpsertResult", &persisted);
        assert_interface_matches("RecoveryCleanupResult", &cleanup);
        let rust_values = RecoveryPersistStatus::ALL
            .iter()
            .map(|status| {
                serde_json::to_value(status)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rust_values,
            typescript_string_constant_values("RECOVERY_PERSIST_STATUSES")
        );
    }

    fn test_entry(
        index: u128,
        relative_path: &str,
        size: u64,
        updated_at: u64,
    ) -> RecoveryManifestEntry {
        let suffix = format!("{index:032x}");
        RecoveryManifestEntry {
            metadata: RecoverySnapshotMetadata {
                snapshot_id: format!("{SNAPSHOT_ID_PREFIX}{suffix}"),
                workspace_id: workspace("workspace-one"),
                relative_path: path(relative_path),
                base_revision: revision("disk"),
                content_hash: sha256_hex(b"content"),
                created_at: updated_at,
                updated_at,
                expires_at: u64::MAX,
                size_bytes: size,
            },
            snapshot_file_name: format!("{SNAPSHOT_FILE_PREFIX}{suffix}.md"),
        }
    }
}
