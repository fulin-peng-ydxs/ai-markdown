use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::error::{DesktopError, DesktopErrorCode};

use super::atomic;
use super::read::{inspect_markdown_revision, MAX_INLINE_MARKDOWN_BYTES};
use super::{
    metadata_writable_hint, FileRevision, LineEnding, TextEncoding, WorkspaceRelativePath,
};

pub const SAFE_WRITE_CLEANUP_FILE_NAME: &str = "plainroot-safe-write-cleanup-v1.json";
const CLEANUP_SCHEMA_VERSION: u32 = 1;
const MAX_PENDING_CLEANUPS: usize = 32;
const MAX_CLEANUP_FILE_BYTES: u64 = 64 * 1024;
const TEMP_CREATE_ATTEMPTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeWriteResult {
    pub relative_path: WorkspaceRelativePath,
    pub revision: FileRevision,
    pub bytes_written: u64,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSafeWriteService {
    inner: Arc<SafeWriteInner>,
}

#[derive(Debug)]
struct SafeWriteInner {
    operation_lock: Arc<Mutex<()>>,
    cleanup: Mutex<CleanupState>,
    initialization_error: Option<DesktopError>,
}

#[derive(Debug)]
struct CleanupState {
    store: CleanupStore,
    journal: CleanupJournal,
    authorized_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupJournal {
    schema_version: u32,
    pending_paths: Vec<PathBuf>,
}

#[derive(Debug)]
struct CleanupStore {
    path: PathBuf,
}

impl WorkspaceSafeWriteService {
    pub fn initialize_for_app<R: Runtime>(
        app: &AppHandle<R>,
        operation_lock: Arc<Mutex<()>>,
        authorized_roots: Vec<PathBuf>,
    ) -> Self {
        match crate::app_data_directory(app) {
            Ok(app_data_dir) => Self::initialize_at(app_data_dir, operation_lock, authorized_roots),
            Err(_) => Self::unavailable(operation_lock, safe_write_unavailable()),
        }
    }

    pub fn initialize_at(
        app_data_dir: PathBuf,
        operation_lock: Arc<Mutex<()>>,
        authorized_roots: Vec<PathBuf>,
    ) -> Self {
        let store = CleanupStore::new(app_data_dir.join(SAFE_WRITE_CLEANUP_FILE_NAME));
        let authorized_roots = validated_cleanup_roots(authorized_roots);
        match store.load_and_retry(&authorized_roots) {
            Ok(journal) => Self {
                inner: Arc::new(SafeWriteInner {
                    operation_lock,
                    cleanup: Mutex::new(CleanupState {
                        store,
                        journal,
                        authorized_roots,
                    }),
                    initialization_error: None,
                }),
            },
            Err(error) => Self::unavailable(operation_lock, error),
        }
    }

    fn unavailable(operation_lock: Arc<Mutex<()>>, error: DesktopError) -> Self {
        Self {
            inner: Arc::new(SafeWriteInner {
                operation_lock,
                cleanup: Mutex::new(CleanupState {
                    store: CleanupStore::new(PathBuf::new()),
                    journal: CleanupJournal::default(),
                    authorized_roots: Vec::new(),
                }),
                initialization_error: Some(error),
            }),
        }
    }

    pub fn current_error(&self) -> Option<DesktopError> {
        self.inner.initialization_error.clone()
    }

    pub fn write_markdown(
        &self,
        canonical_root: &Path,
        relative_path: WorkspaceRelativePath,
        content: String,
        expected_revision: FileRevision,
    ) -> Result<SafeWriteResult, DesktopError> {
        self.write_markdown_inner(
            canonical_root,
            relative_path,
            content,
            expected_revision,
            WriteFault::None,
        )
    }

    fn write_markdown_inner(
        &self,
        canonical_root: &Path,
        relative_path: WorkspaceRelativePath,
        content: String,
        expected_revision: FileRevision,
        fault: WriteFault,
    ) -> Result<SafeWriteResult, DesktopError> {
        if let Some(error) = &self.inner.initialization_error {
            return Err(error.clone());
        }
        let _operation_guard = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| safe_write_unavailable())?;
        let target = super::resolve_existing_workspace_path(canonical_root, &relative_path)?;
        let metadata =
            fs::metadata(&target).map_err(|error| DesktopError::from_io(&error, &target, true))?;
        if !metadata.is_file() {
            return Err(
                DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(&target)
            );
        }
        if !metadata_writable_hint(&metadata) {
            return Err(
                DesktopError::new(DesktopErrorCode::PermissionDenied, true, true)
                    .with_path_hint(&target),
            );
        }

        let current_revision = inspect_markdown_revision(&target)?;
        validate_expected_revision(&target, &current_revision, &expected_revision)?;
        let bytes = encode_content(&content, &expected_revision)?;
        if content_exceeds_write_limit(bytes.len() as u64) {
            return Err(
                DesktopError::new(DesktopErrorCode::FileTooLarge, true, false)
                    .with_path_hint(&target),
            );
        }

        let temp_path = self.next_temp_path(&target)?;
        self.register_cleanup(temp_path.clone(), canonical_root)?;
        #[cfg(test)]
        if fault == WriteFault::OccupyTempBeforeCreate {
            fs::write(&temp_path, b"external temporary name owner").unwrap();
        }
        let mut temp_created = false;
        let write_result = Self::write_and_replace(
            &target,
            &temp_path,
            &bytes,
            &metadata,
            &expected_revision,
            fault,
            &mut temp_created,
        );
        if let Err(error) = write_result {
            if temp_created {
                self.cleanup_after_failure(&temp_path, fault);
            } else {
                self.complete_cleanup(&temp_path);
            }
            return Err(error);
        }

        self.complete_cleanup(&temp_path);
        let revision = inspect_markdown_revision(&target)?;
        Ok(SafeWriteResult {
            relative_path,
            bytes_written: revision.size,
            revision,
        })
    }

    fn write_and_replace(
        target: &Path,
        temp_path: &Path,
        bytes: &[u8],
        target_metadata: &fs::Metadata,
        expected_revision: &FileRevision,
        fault: WriteFault,
        temp_created: &mut bool,
    ) -> Result<(), DesktopError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(temp_path)
            .map_err(|error| map_safe_write_io(error, target))?;
        *temp_created = true;
        if fault == WriteFault::AfterTempCreate {
            return Err(injected_write_error(target));
        }
        file.write_all(bytes)
            .map_err(|error| map_safe_write_io(error, target))?;
        if fault == WriteFault::AfterTempWrite {
            return Err(injected_write_error(target));
        }
        file.sync_all()
            .map_err(|error| map_safe_write_io(error, target))?;
        if fault == WriteFault::AfterTempSync {
            return Err(injected_write_error(target));
        }
        fs::set_permissions(temp_path, target_metadata.permissions())
            .map_err(|error| map_safe_write_io(error, target))?;
        drop(file);

        #[cfg(test)]
        if fault == WriteFault::ExternalChangeBeforeReplace {
            fs::write(target, b"external change\n").unwrap();
        }

        let latest_revision = inspect_markdown_revision(target)?;
        validate_expected_revision(target, &latest_revision, expected_revision)?;
        if matches!(
            fault,
            WriteFault::BeforeReplace | WriteFault::Replace | WriteFault::Cleanup
        ) {
            return Err(injected_write_error(target));
        }
        atomic::replace_existing(temp_path, target)
            .map_err(|error| map_safe_write_io(error, target))?;
        // The rename is already the disk commit point. A directory fsync failure cannot be rolled
        // back safely, so it is diagnostic-only instead of reporting a false failed save after the
        // target content has changed. Windows uses MOVEFILE_WRITE_THROUGH in the adapter.
        if let Err(error) = atomic::sync_parent_directory(target) {
            eprintln!(
                "Plainroot safe-write parent sync failed for {}: {error}",
                target
                    .file_name()
                    .map(|name| name.to_string_lossy())
                    .unwrap_or_default()
            );
        }
        Ok(())
    }

    fn next_temp_path(&self, target: &Path) -> Result<PathBuf, DesktopError> {
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| safe_write_failed(target))?;
        for _ in 0..TEMP_CREATE_ATTEMPTS {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random).map_err(|_| safe_write_unavailable())?;
            let token = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let candidate =
                target.with_file_name(format!(".{file_name}.plainroot-save-{token}.tmp"));
            match fs::symlink_metadata(&candidate) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
                Ok(_) => continue,
                Err(error) => return Err(map_safe_write_io(error, target)),
            }
        }
        Err(safe_write_failed(target))
    }

    fn register_cleanup(&self, path: PathBuf, canonical_root: &Path) -> Result<(), DesktopError> {
        let mut cleanup = self
            .inner
            .cleanup
            .lock()
            .map_err(|_| safe_write_unavailable())?;
        if !cleanup
            .authorized_roots
            .iter()
            .any(|root| root == canonical_root)
        {
            cleanup.authorized_roots.push(canonical_root.to_path_buf());
        }
        let authorized_roots = cleanup.authorized_roots.clone();
        retry_authorized_pending_paths(&mut cleanup.journal, &authorized_roots);
        if cleanup.journal.pending_paths.len() >= MAX_PENDING_CLEANUPS {
            return Err(safe_write_unavailable());
        }
        cleanup.journal.pending_paths.push(path);
        if let Err(error) = cleanup.store.persist(&cleanup.journal) {
            cleanup.journal.pending_paths.pop();
            return Err(error);
        }
        Ok(())
    }

    fn cleanup_after_failure(&self, path: &Path, fault: WriteFault) {
        let removed = fault != WriteFault::Cleanup && remove_temp_candidate(path).is_ok();
        if removed {
            self.complete_cleanup(path);
        } else {
            eprintln!(
                "Plainroot deferred cleanup for safe-write temporary file: {}",
                path.file_name()
                    .map(|name| name.to_string_lossy())
                    .unwrap_or_default()
            );
        }
    }

    fn complete_cleanup(&self, path: &Path) {
        let Ok(mut cleanup) = self.inner.cleanup.lock() else {
            return;
        };
        cleanup
            .journal
            .pending_paths
            .retain(|pending| pending != path);
        if let Err(error) = cleanup.store.persist(&cleanup.journal) {
            eprintln!(
                "Plainroot safe-write cleanup journal update failed: {}",
                error.message_key
            );
        }
    }

    #[cfg(test)]
    fn pending_cleanup_count(&self) -> usize {
        self.inner
            .cleanup
            .lock()
            .unwrap()
            .journal
            .pending_paths
            .len()
    }
}

impl CleanupStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load_and_retry(&self, authorized_roots: &[PathBuf]) -> Result<CleanupJournal, DesktopError> {
        let parent = self.path.parent().ok_or_else(safe_write_unavailable)?;
        fs::create_dir_all(parent).map_err(|_| safe_write_unavailable())?;
        let mut journal = match File::open(&self.path) {
            Ok(mut file) => {
                let size = file.metadata().map_err(|_| safe_write_unavailable())?.len();
                if size > MAX_CLEANUP_FILE_BYTES {
                    return Err(safe_write_unavailable());
                }
                let mut bytes = Vec::with_capacity(size as usize);
                file.read_to_end(&mut bytes)
                    .map_err(|_| safe_write_unavailable())?;
                serde_json::from_slice::<CleanupJournal>(&bytes)
                    .map_err(|_| safe_write_unavailable())?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => CleanupJournal {
                schema_version: CLEANUP_SCHEMA_VERSION,
                pending_paths: Vec::new(),
            },
            Err(_) => return Err(safe_write_unavailable()),
        };
        if journal.schema_version != CLEANUP_SCHEMA_VERSION
            || journal.pending_paths.len() > MAX_PENDING_CLEANUPS
            || journal
                .pending_paths
                .iter()
                .any(|path| !is_temp_candidate(path))
        {
            return Err(safe_write_unavailable());
        }
        journal
            .pending_paths
            .retain(|path| cleanup_still_requires_retry(path, authorized_roots));
        self.persist(&journal)?;
        Ok(journal)
    }

    fn persist(&self, journal: &CleanupJournal) -> Result<(), DesktopError> {
        let parent = self.path.parent().ok_or_else(safe_write_unavailable)?;
        fs::create_dir_all(parent).map_err(|_| safe_write_unavailable())?;
        let bytes = serde_json::to_vec(journal).map_err(|_| safe_write_unavailable())?;
        if bytes.len() as u64 > MAX_CLEANUP_FILE_BYTES {
            return Err(safe_write_unavailable());
        }
        let temp = self.path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| safe_write_unavailable())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| safe_write_unavailable())?;
        drop(file);
        atomic::replace_existing(&temp, &self.path).map_err(|_| safe_write_unavailable())
    }
}

fn retry_authorized_pending_paths(journal: &mut CleanupJournal, authorized_roots: &[PathBuf]) {
    journal
        .pending_paths
        .retain(|path| cleanup_still_requires_retry(path, authorized_roots));
}

fn cleanup_still_requires_retry(path: &Path, authorized_roots: &[PathBuf]) -> bool {
    if !authorized_roots.iter().any(|root| path.starts_with(root)) {
        // A root can legitimately age out of recent workspaces. The orphaned file must remain on
        // disk, but its unactionable journal entry must not consume the global cleanup budget.
        return false;
    }
    remove_authorized_temp_candidate(path, authorized_roots).is_err()
}

fn validated_cleanup_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots
        .into_iter()
        .filter_map(|root| {
            let metadata = fs::symlink_metadata(&root).ok()?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return None;
            }
            fs::canonicalize(root).ok()
        })
        .collect()
}

fn remove_temp_candidate(path: &Path) -> io::Result<()> {
    if !is_temp_candidate(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a Plainroot temporary file",
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path)
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "temporary path is not a file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn remove_authorized_temp_candidate(path: &Path, authorized_roots: &[PathBuf]) -> io::Result<()> {
    if !is_temp_candidate(path) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a Plainroot temporary file",
        ));
    }
    let Some(root) = authorized_roots.iter().find(|root| path.starts_with(root)) else {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "temporary file is outside an authorized root",
        ));
    };
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    let relative = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .map(|relative| relative.replace('\\', "/"))
        .and_then(|relative| WorkspaceRelativePath::parse(&relative).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "temporary file path cannot be revalidated",
            )
        })?;
    super::resolve_existing_workspace_path(root, &relative)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "path revalidation failed"))?;
    remove_temp_candidate(path)
}

fn is_temp_candidate(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with('.') && name.contains(".plainroot-save-") && name.ends_with(".tmp")
        })
}

fn validate_expected_revision(
    target: &Path,
    current: &FileRevision,
    expected: &FileRevision,
) -> Result<(), DesktopError> {
    if current != expected {
        return Err(
            DesktopError::new(DesktopErrorCode::FileRevisionConflict, true, false)
                .with_path_hint(target),
        );
    }
    if current.size > MAX_INLINE_MARKDOWN_BYTES {
        return Err(
            DesktopError::new(DesktopErrorCode::FileTooLarge, true, false).with_path_hint(target),
        );
    }
    if current.encoding == TextEncoding::Unsupported {
        return Err(
            DesktopError::new(DesktopErrorCode::UnsupportedTextEncoding, true, false)
                .with_path_hint(target),
        );
    }
    Ok(())
}

fn encode_content(content: &str, revision: &FileRevision) -> Result<Vec<u8>, DesktopError> {
    if revision.encoding == TextEncoding::Unsupported {
        return Err(DesktopError::new(
            DesktopErrorCode::UnsupportedTextEncoding,
            true,
            false,
        ));
    }
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let normalized = match revision.line_ending {
        LineEnding::Lf => normalize_line_endings(content, "\n"),
        LineEnding::Crlf => normalize_line_endings(content, "\r\n"),
        LineEnding::Cr => normalize_line_endings(content, "\r"),
        LineEnding::None | LineEnding::Mixed => content.to_owned(),
    };
    let mut bytes = Vec::with_capacity(
        normalized.len() + usize::from(revision.encoding == TextEncoding::Utf8Bom) * 3,
    );
    if revision.encoding == TextEncoding::Utf8Bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(normalized.as_bytes());
    Ok(bytes)
}

fn content_exceeds_write_limit(bytes: u64) -> bool {
    bytes > MAX_INLINE_MARKDOWN_BYTES
}

fn normalize_line_endings(content: &str, line_ending: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            normalized.push_str(line_ending);
        } else if character == '\n' {
            normalized.push_str(line_ending);
        } else {
            normalized.push(character);
        }
    }
    normalized
}

fn map_safe_write_io(error: io::Error, target: &Path) -> DesktopError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        DesktopError::new(DesktopErrorCode::PermissionDenied, true, true).with_path_hint(target)
    } else {
        safe_write_failed(target)
    }
}

fn safe_write_failed(target: &Path) -> DesktopError {
    DesktopError::new(DesktopErrorCode::SafeWriteFailed, true, true).with_path_hint(target)
}

fn safe_write_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::SafeWriteUnavailable, true, true)
}

fn injected_write_error(target: &Path) -> DesktopError {
    safe_write_failed(target)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum WriteFault {
    None,
    AfterTempCreate,
    AfterTempWrite,
    AfterTempSync,
    BeforeReplace,
    Replace,
    Cleanup,
    ExternalChangeBeforeReplace,
    OccupyTempBeforeCreate,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;

    use crate::contract_test::assert_interface_matches;
    use crate::error::DesktopErrorCode;
    use crate::fs::read::inspect_markdown_revision;
    use crate::fs::{LineEnding, TextEncoding, WorkspaceRelativePath};
    use crate::test_support::TestDirectory;

    use super::{
        content_exceeds_write_limit, encode_content, validate_expected_revision,
        WorkspaceSafeWriteService, WriteFault, MAX_INLINE_MARKDOWN_BYTES,
        SAFE_WRITE_CLEANUP_FILE_NAME,
    };

    struct Fixture {
        root: PathBuf,
        app_data: PathBuf,
    }

    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            let root = std::env::temp_dir().join(format!(
                "plainroot-safe-write-{}-{}",
                std::process::id(),
                rand_suffix()
            ));
            let app_data = root.join("app-data");
            fs::create_dir_all(&app_data).unwrap();
            fs::write(root.join("note.md"), bytes).unwrap();
            Self {
                root: fs::canonicalize(root).unwrap(),
                app_data,
            }
        }

        fn target(&self) -> PathBuf {
            self.root.join("note.md")
        }

        fn service(&self) -> WorkspaceSafeWriteService {
            WorkspaceSafeWriteService::initialize_at(
                self.app_data.clone(),
                Arc::new(Mutex::new(())),
                vec![self.root.clone()],
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    fn write_with_fault(
        service: &WorkspaceSafeWriteService,
        root: &Path,
        content: &str,
        fault: WriteFault,
    ) -> Result<super::SafeWriteResult, crate::error::DesktopError> {
        let revision = inspect_markdown_revision(&root.join("note.md")).unwrap();
        service.write_markdown_inner(
            root,
            WorkspaceRelativePath::parse("note.md").unwrap(),
            content.to_owned(),
            revision,
            fault,
        )
    }

    #[test]
    fn successful_write_preserves_crlf_bom_and_returns_revision_contract() {
        let fixture = Fixture::new(b"\xEF\xBB\xBFold\r\nline\r\n");
        let result = write_with_fault(
            &fixture.service(),
            &fixture.root,
            "new\nline\n",
            WriteFault::None,
        )
        .unwrap();

        assert_eq!(
            fs::read(fixture.target()).unwrap(),
            b"\xEF\xBB\xBFnew\r\nline\r\n"
        );
        assert_eq!(result.revision.encoding, TextEncoding::Utf8Bom);
        assert_eq!(result.revision.line_ending, LineEnding::Crlf);
        assert_eq!(result.bytes_written, result.revision.size);
        assert_interface_matches("SafeWriteResult", &result);
    }

    #[test]
    fn every_injected_failure_preserves_original_and_cleans_temp_file() {
        for fault in [
            WriteFault::AfterTempCreate,
            WriteFault::AfterTempWrite,
            WriteFault::AfterTempSync,
            WriteFault::BeforeReplace,
            WriteFault::Replace,
        ] {
            let fixture = Fixture::new(b"original\n");
            let service = fixture.service();
            let before = inspect_markdown_revision(&fixture.target()).unwrap();
            let error = write_with_fault(&service, &fixture.root, "replacement\n", fault)
                .expect_err("injected failure must abort");
            assert_eq!(error.code, DesktopErrorCode::SafeWriteFailed);
            assert!(error.content_safe);
            assert_eq!(fs::read(fixture.target()).unwrap(), b"original\n");
            assert_eq!(
                inspect_markdown_revision(&fixture.target()).unwrap(),
                before
            );
            assert_eq!(service.pending_cleanup_count(), 0);
            assert_eq!(
                fs::read_dir(&fixture.root)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry
                        .file_name()
                        .to_string_lossy()
                        .contains("plainroot-save"))
                    .count(),
                0
            );
        }
    }

    #[test]
    fn external_change_before_replace_aborts_without_overwriting_it() {
        let fixture = Fixture::new(b"original\n");
        let error = write_with_fault(
            &fixture.service(),
            &fixture.root,
            "replacement\n",
            WriteFault::ExternalChangeBeforeReplace,
        )
        .expect_err("changed revision must abort");

        assert_eq!(error.code, DesktopErrorCode::FileRevisionConflict);
        assert_eq!(fs::read(fixture.target()).unwrap(), b"external change\n");
    }

    #[test]
    fn deferred_cleanup_is_retried_on_next_service_initialization() {
        let fixture = Fixture::new(b"original\n");
        let service = fixture.service();
        let error = write_with_fault(
            &service,
            &fixture.root,
            "replacement\n",
            WriteFault::Cleanup,
        )
        .expect_err("cleanup fault accompanies a failed write");
        assert_eq!(error.code, DesktopErrorCode::SafeWriteFailed);
        assert_eq!(service.pending_cleanup_count(), 1);
        assert_eq!(fs::read(fixture.target()).unwrap(), b"original\n");
        drop(service);

        let restarted = fixture.service();
        assert_eq!(restarted.pending_cleanup_count(), 0);
        assert_eq!(
            fs::read_dir(&fixture.root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("plainroot-save"))
                .count(),
            0
        );
    }

    #[test]
    fn stale_revision_unsupported_encoding_and_missing_target_are_rejected() {
        let fixture = Fixture::new(b"original\n");
        let service = fixture.service();
        let mut stale = inspect_markdown_revision(&fixture.target()).unwrap();
        stale.content_hash = "sha256:stale".to_owned();
        let error = service
            .write_markdown(
                &fixture.root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "replacement\n".to_owned(),
                stale,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::FileRevisionConflict);

        fs::write(fixture.target(), [0xff, b'\n']).unwrap();
        let unsupported = inspect_markdown_revision(&fixture.target()).unwrap();
        let error = service
            .write_markdown(
                &fixture.root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "replacement\n".to_owned(),
                unsupported,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::UnsupportedTextEncoding);

        fs::remove_file(fixture.target()).unwrap();
        let error = service
            .write_markdown(
                &fixture.root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                String::new(),
                FileRevisionFixture::utf8(),
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::PathNotFound);
    }

    #[test]
    fn concurrent_writes_with_one_revision_allow_only_one_commit() {
        let fixture = Fixture::new(b"original\n");
        let service = fixture.service();
        let expected = inspect_markdown_revision(&fixture.target()).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let handles = ["first\n", "second\n"].map(|content| {
            let barrier = Arc::clone(&barrier);
            let service = service.clone();
            let root = fixture.root.clone();
            let expected = expected.clone();
            thread::spawn(move || {
                barrier.wait();
                service.write_markdown(
                    &root,
                    WorkspaceRelativePath::parse("note.md").unwrap(),
                    content.to_owned(),
                    expected,
                )
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    result
                        .as_ref()
                        .is_err_and(|error| error.code == DesktopErrorCode::FileRevisionConflict)
                })
                .count(),
            1
        );
        assert!(matches!(
            fs::read(fixture.target()).unwrap().as_slice(),
            b"first\n" | b"second\n"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn readonly_file_is_rejected_before_a_temporary_file_is_created() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new(b"original\n");
        let mut permissions = fs::metadata(fixture.target()).unwrap().permissions();
        permissions.set_mode(0o444);
        fs::set_permissions(fixture.target(), permissions).unwrap();

        let error = write_with_fault(
            &fixture.service(),
            &fixture.root,
            "replacement\n",
            WriteFault::None,
        )
        .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::PermissionDenied);
        assert_eq!(fs::read(fixture.target()).unwrap(), b"original\n");
    }

    #[test]
    fn line_endings_and_size_boundary_are_explicit() {
        let mixed = FileRevisionFixture::with_line_ending(LineEnding::Mixed);
        assert_eq!(
            encode_content("a\r\nb\nc\r", &mixed).unwrap(),
            b"a\r\nb\nc\r"
        );
        let cr = FileRevisionFixture::with_line_ending(LineEnding::Cr);
        assert_eq!(encode_content("a\r\nb\nc\r", &cr).unwrap(), b"a\rb\rc\r");
        assert!(!content_exceeds_write_limit(MAX_INLINE_MARKDOWN_BYTES));
        assert!(content_exceeds_write_limit(MAX_INLINE_MARKDOWN_BYTES + 1));
        let mut oversized = FileRevisionFixture::utf8();
        oversized.size = MAX_INLINE_MARKDOWN_BYTES + 1;
        assert_eq!(
            validate_expected_revision(Path::new("large.md"), &oversized, &oversized)
                .unwrap_err()
                .code,
            DesktopErrorCode::FileTooLarge
        );
    }

    #[test]
    fn oversized_or_invalid_cleanup_journal_disables_writes_without_deleting_paths() {
        let fixture = Fixture::new(b"original\n");
        let pending_paths = (0..33)
            .map(|index| {
                fixture
                    .root
                    .join(format!(".note.md.plainroot-save-test-{index}.tmp"))
            })
            .collect::<Vec<_>>();
        let journal = serde_json::json!({
            "schemaVersion": 1,
            "pendingPaths": pending_paths,
        });
        fs::write(
            fixture.app_data.join(SAFE_WRITE_CLEANUP_FILE_NAME),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let service = fixture.service();
        assert_eq!(
            service.current_error().unwrap().code,
            DesktopErrorCode::SafeWriteUnavailable
        );
        let expected = inspect_markdown_revision(&fixture.target()).unwrap();
        let error = service
            .write_markdown(
                &fixture.root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "replacement\n".to_owned(),
                expected,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::SafeWriteUnavailable);
        assert_eq!(fs::read(fixture.target()).unwrap(), b"original\n");
    }

    #[test]
    fn startup_cleanup_drops_unauthorized_journal_entry_without_deleting_candidate() {
        let fixture = Fixture::new(b"original\n");
        let outside_root = TestDirectory::create("stale-cleanup-root");
        let outside = outside_root
            .path()
            .join(".outside.plainroot-save-stale.tmp");
        fs::write(&outside, b"must remain").unwrap();
        let journal = serde_json::json!({
            "schemaVersion": 1,
            "pendingPaths": [&outside],
        });
        fs::write(
            fixture.app_data.join(SAFE_WRITE_CLEANUP_FILE_NAME),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let service = fixture.service();
        assert!(service.current_error().is_none());
        assert_eq!(service.pending_cleanup_count(), 0);
        assert_eq!(fs::read(&outside).unwrap(), b"must remain");
    }

    #[test]
    fn stale_roots_cannot_fill_cleanup_budget_and_disable_safe_write() {
        let fixture = Fixture::new(b"original\n");
        let outside_root = TestDirectory::create("stale-cleanup-budget");
        let pending_paths = (0..32)
            .map(|index| {
                let path = outside_root
                    .path()
                    .join(format!(".note.md.plainroot-save-stale-{index}.tmp"));
                fs::write(&path, b"must remain").unwrap();
                path
            })
            .collect::<Vec<_>>();
        let journal = serde_json::json!({
            "schemaVersion": 1,
            "pendingPaths": pending_paths,
        });
        fs::write(
            fixture.app_data.join(SAFE_WRITE_CLEANUP_FILE_NAME),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();

        let service = fixture.service();
        assert!(service.current_error().is_none());
        assert_eq!(service.pending_cleanup_count(), 0);
        let result = write_with_fault(&service, &fixture.root, "replacement\n", WriteFault::None)
            .expect("stale roots must not disable future safe writes");

        assert_eq!(result.bytes_written, b"replacement\n".len() as u64);
        assert_eq!(fs::read_dir(outside_root.path()).unwrap().count(), 32);
    }

    #[test]
    fn temp_name_race_never_deletes_a_file_the_write_did_not_create() {
        let fixture = Fixture::new(b"original\n");
        let service = fixture.service();
        let error = write_with_fault(
            &service,
            &fixture.root,
            "replacement\n",
            WriteFault::OccupyTempBeforeCreate,
        )
        .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::SafeWriteFailed);
        assert_eq!(fs::read(fixture.target()).unwrap(), b"original\n");
        let occupied = fs::read_dir(&fixture.root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("plainroot-save")
            })
            .expect("external file with the raced temporary name must remain");
        assert_eq!(
            fs::read(occupied.path()).unwrap(),
            b"external temporary name owner"
        );
        assert_eq!(service.pending_cleanup_count(), 0);
    }

    struct FileRevisionFixture;

    impl FileRevisionFixture {
        fn utf8() -> crate::fs::FileRevision {
            Self::with_line_ending(LineEnding::None)
        }

        fn with_line_ending(line_ending: LineEnding) -> crate::fs::FileRevision {
            crate::fs::FileRevision {
                modified_at: 0,
                size: 0,
                content_hash: "sha256:empty".to_owned(),
                encoding: TextEncoding::Utf8,
                line_ending,
            }
        }
    }
}
