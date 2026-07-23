use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::read::{inspect_markdown_revision, MAX_INLINE_MARKDOWN_BYTES};
use crate::fs::safe_write::{encode_markdown_content, SafeWriteResult, WorkspaceSafeWriteService};
use crate::fs::{
    atomic, metadata_writable_hint, native_path_identity, resolve_existing_workspace_path,
    FileRevision, LineEnding, TextEncoding, WorkspaceId, WorkspaceRelativePath,
};

const MAX_PENDING_EDITOR_SAVES: usize = 32;
const EDITOR_SAVE_LIFETIME: Duration = Duration::from_secs(5 * 60);
const TEMP_CREATE_ATTEMPTS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveCopyFormatChoice {
    Preserve,
    Utf8Lf,
    Utf8Crlf,
    Utf8Cr,
}

impl SaveCopyFormatChoice {
    pub const ALL: &'static [Self] = &[Self::Preserve, Self::Utf8Lf, Self::Utf8Crlf, Self::Utf8Cr];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SaveCopySource {
    WorkspaceDocument {
        workspace_id: WorkspaceId,
        relative_path: WorkspaceRelativePath,
        revision: FileRevision,
    },
    NewDocument {
        suggested_name: String,
    },
}

impl SaveCopySource {
    pub fn suggested_name(&self) -> String {
        match self {
            Self::WorkspaceDocument { relative_path, .. } => relative_path
                .as_str()
                .rsplit('/')
                .next()
                .unwrap_or("Untitled.md")
                .to_owned(),
            Self::NewDocument { suggested_name } => safe_suggested_name(suggested_name),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveCopyTargetState {
    New,
    Existing,
}

impl SaveCopyTargetState {
    pub const ALL: &'static [Self] = &[Self::New, Self::Existing];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictOverwriteProposal {
    pub confirmation_id: String,
    pub relative_path: WorkspaceRelativePath,
    pub latest_revision: FileRevision,
    pub current_content_hash: String,
    pub target_writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCopyProposal {
    pub confirmation_id: String,
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub display_path: PathBuf,
    pub file_name: String,
    pub target_state: SaveCopyTargetState,
    pub target_revision: Option<FileRevision>,
    pub output_encoding: TextEncoding,
    pub output_line_ending: LineEnding,
    pub workspace_id: Option<WorkspaceId>,
    pub relative_path: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SaveCopySelectionOutcome {
    Cancelled,
    Ready { proposal: SaveCopyProposal },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCopyResult {
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub display_path: PathBuf,
    pub workspace_id: Option<WorkspaceId>,
    pub relative_path: Option<WorkspaceRelativePath>,
    pub revision: FileRevision,
    pub bytes_written: u64,
}

#[derive(Debug, Clone, Copy)]
struct SaveCopyFormat {
    encoding: TextEncoding,
    line_ending: LineEnding,
}

#[derive(Debug)]
struct PendingConflictOverwrite {
    created_at: Instant,
    workspace_id: WorkspaceId,
    root_identity: String,
    relative_path: WorkspaceRelativePath,
    latest_revision: FileRevision,
    content_hash: String,
}

#[derive(Debug)]
struct PendingSaveCopy {
    created_at: Instant,
    target_path: PathBuf,
    parent_identity: String,
    target_revision: Option<FileRevision>,
    format: SaveCopyFormat,
    workspace_id: Option<WorkspaceId>,
    relative_path: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Default)]
struct PendingEditorSaves {
    overwrites: HashMap<String, PendingConflictOverwrite>,
    save_copies: HashMap<String, PendingSaveCopy>,
}

#[derive(Debug)]
struct EditorSaveInner {
    pending: Mutex<PendingEditorSaves>,
}

#[derive(Debug, Clone)]
pub struct EditorSaveService {
    operation_lock: Arc<Mutex<()>>,
    inner: Arc<EditorSaveInner>,
}

impl Default for EditorSaveService {
    fn default() -> Self {
        Self::with_operation_lock(Arc::new(Mutex::new(())))
    }
}

impl EditorSaveService {
    pub(crate) fn with_operation_lock(operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            operation_lock,
            inner: Arc::new(EditorSaveInner {
                pending: Mutex::new(PendingEditorSaves::default()),
            }),
        }
    }

    pub fn prepare_conflict_overwrite(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        relative_path: WorkspaceRelativePath,
        content: &str,
    ) -> Result<ConflictOverwriteProposal, DesktopError> {
        let target = resolve_existing_workspace_path(canonical_root, &relative_path)?;
        let metadata =
            fs::metadata(&target).map_err(|error| DesktopError::from_io(&error, &target, true))?;
        if !metadata.is_file() {
            return Err(
                DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(&target)
            );
        }
        let latest_revision = inspect_markdown_revision(&target)?;
        let content_hash = content_hash(content);
        let root_identity = native_path_identity(canonical_root)?;
        let confirmation_id = self.next_id("conflict-v1-")?;
        let proposal = ConflictOverwriteProposal {
            confirmation_id: confirmation_id.clone(),
            relative_path: relative_path.clone(),
            latest_revision: latest_revision.clone(),
            current_content_hash: content_hash.clone(),
            target_writable: metadata_writable_hint(&metadata)
                && latest_revision.encoding != TextEncoding::Unsupported,
        };
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        make_room(&mut pending.overwrites);
        pending.overwrites.insert(
            confirmation_id,
            PendingConflictOverwrite {
                created_at: Instant::now(),
                workspace_id: workspace_id.clone(),
                root_identity,
                relative_path,
                latest_revision,
                content_hash,
            },
        );
        Ok(proposal)
    }

    pub fn confirm_conflict_overwrite(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        confirmation_id: &str,
        content: String,
        safe_writes: &WorkspaceSafeWriteService,
    ) -> Result<SafeWriteResult, DesktopError> {
        let pending = {
            let mut state = self.lock_pending()?;
            prune_pending(&mut state, Instant::now());
            state
                .overwrites
                .remove(confirmation_id)
                .ok_or_else(conflict_confirmation_not_found)?
        };
        if pending.workspace_id != *workspace_id
            || pending.root_identity != native_path_identity(canonical_root)?
        {
            return Err(conflict_confirmation_not_found());
        }
        if pending.content_hash != content_hash(&content) {
            return Err(DesktopError::new(
                DesktopErrorCode::ConflictContentChanged,
                true,
                true,
            ));
        }
        safe_writes.write_markdown(
            canonical_root,
            pending.relative_path,
            content,
            pending.latest_revision,
        )
    }

    pub fn cancel_conflict_overwrite(&self, confirmation_id: &str) -> Result<bool, DesktopError> {
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        Ok(pending.overwrites.remove(confirmation_id).is_some())
    }

    pub fn prepare_save_copy(
        &self,
        selected_target: Option<PathBuf>,
        source: SaveCopySource,
        source_root: Option<&Path>,
        format_choice: Option<SaveCopyFormatChoice>,
    ) -> Result<SaveCopySelectionOutcome, DesktopError> {
        let Some(selected_target) = selected_target else {
            return Ok(SaveCopySelectionOutcome::Cancelled);
        };
        let (source_workspace, format) =
            validate_save_copy_source(&source, source_root, format_choice)?;
        let target = inspect_save_copy_target(selected_target)?;
        let (workspace_id, relative_path) = source_workspace
            .as_ref()
            .and_then(|(workspace_id, root)| {
                workspace_relative_target(root, &target.path)
                    .map(|relative| (Some(workspace_id.clone()), Some(relative)))
            })
            .unwrap_or((None, None));
        let confirmation_id = self.next_id("save-copy-v1-")?;
        let proposal = SaveCopyProposal {
            confirmation_id: confirmation_id.clone(),
            display_path: target.path.clone(),
            file_name: target.file_name,
            target_state: if target.revision.is_some() {
                SaveCopyTargetState::Existing
            } else {
                SaveCopyTargetState::New
            },
            target_revision: target.revision.clone(),
            output_encoding: format.encoding,
            output_line_ending: format.line_ending,
            workspace_id: workspace_id.clone(),
            relative_path: relative_path.clone(),
        };
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        make_room(&mut pending.save_copies);
        pending.save_copies.insert(
            confirmation_id,
            PendingSaveCopy {
                created_at: Instant::now(),
                target_path: target.path,
                parent_identity: target.parent_identity,
                target_revision: target.revision,
                format,
                workspace_id,
                relative_path,
            },
        );
        Ok(SaveCopySelectionOutcome::Ready { proposal })
    }

    pub fn confirm_save_copy(
        &self,
        confirmation_id: &str,
        content: String,
        overwrite_existing: bool,
    ) -> Result<SaveCopyResult, DesktopError> {
        self.confirm_save_copy_with_fault(
            confirmation_id,
            content,
            overwrite_existing,
            SaveCopyFault::None,
        )
    }

    fn confirm_save_copy_with_fault(
        &self,
        confirmation_id: &str,
        content: String,
        overwrite_existing: bool,
        fault: SaveCopyFault,
    ) -> Result<SaveCopyResult, DesktopError> {
        let pending = {
            let mut state = self.lock_pending()?;
            prune_pending(&mut state, Instant::now());
            state
                .save_copies
                .remove(confirmation_id)
                .ok_or_else(save_copy_confirmation_not_found)?
        };
        if pending.target_revision.is_some() && !overwrite_existing {
            return Err(DesktopError::new(
                DesktopErrorCode::SaveCopyOverwriteConfirmationRequired,
                true,
                false,
            ));
        }
        let bytes = encode_markdown_content(
            &content,
            pending.format.encoding,
            pending.format.line_ending,
        )?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_INLINE_MARKDOWN_BYTES {
            return Err(DesktopError::new(
                DesktopErrorCode::FileTooLarge,
                true,
                false,
            ));
        }
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| save_copy_failed(&pending.target_path))?;
        validate_save_copy_target(&pending)?;
        write_save_copy(&pending, &bytes, fault)?;
        let revision = inspect_markdown_revision(&pending.target_path)?;
        Ok(SaveCopyResult {
            display_path: pending.target_path,
            workspace_id: pending.workspace_id,
            relative_path: pending.relative_path,
            bytes_written: revision.size,
            revision,
        })
    }

    pub fn cancel_save_copy(&self, confirmation_id: &str) -> Result<bool, DesktopError> {
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        Ok(pending.save_copies.remove(confirmation_id).is_some())
    }

    fn next_id(&self, prefix: &str) -> Result<String, DesktopError> {
        for _ in 0..100 {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random).map_err(|_| editor_save_unavailable())?;
            let mut candidate = prefix.to_owned();
            for byte in random {
                write!(&mut candidate, "{byte:02x}").expect("writing to a String cannot fail");
            }
            let pending = self.lock_pending()?;
            if !pending.overwrites.contains_key(&candidate)
                && !pending.save_copies.contains_key(&candidate)
            {
                return Ok(candidate);
            }
        }
        Err(editor_save_unavailable())
    }

    fn lock_pending(&self) -> Result<std::sync::MutexGuard<'_, PendingEditorSaves>, DesktopError> {
        self.inner
            .pending
            .lock()
            .map_err(|_| editor_save_unavailable())
    }
}

#[derive(Debug)]
struct InspectedSaveCopyTarget {
    path: PathBuf,
    parent_identity: String,
    file_name: String,
    revision: Option<FileRevision>,
}

fn inspect_save_copy_target(mut path: PathBuf) -> Result<InspectedSaveCopyTarget, DesktopError> {
    match path.extension().and_then(|extension| extension.to_str()) {
        None => {
            path.set_extension("md");
        }
        Some(extension) if extension.eq_ignore_ascii_case("md") => {}
        Some(_) => {
            return Err(
                DesktopError::new(DesktopErrorCode::UnsupportedMarkdownFile, true, false)
                    .with_path_hint(&path),
            );
        }
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| save_copy_failed(&path))?
        .to_owned();
    let parent = path.parent().ok_or_else(|| save_copy_failed(&path))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| DesktopError::from_io(&error, parent, true))?;
    let parent_metadata = fs::metadata(&canonical_parent)
        .map_err(|error| DesktopError::from_io(&error, &canonical_parent, true))?;
    if !parent_metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(&canonical_parent),
        );
    }
    if !metadata_writable_hint(&parent_metadata) {
        return Err(
            DesktopError::new(DesktopErrorCode::PermissionDenied, true, true)
                .with_path_hint(&canonical_parent),
        );
    }
    let path = canonical_parent.join(&file_name);
    let revision = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(
                DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                    .with_path_hint(&path),
            );
        }
        Ok(metadata) if metadata.is_file() => Some(inspect_markdown_revision(&path)?),
        Ok(_) => {
            return Err(
                DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(&path)
            );
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(DesktopError::from_io(&error, &path, true)),
    };
    Ok(InspectedSaveCopyTarget {
        parent_identity: native_path_identity(&canonical_parent)?,
        path,
        file_name,
        revision,
    })
}

fn validate_save_copy_source(
    source: &SaveCopySource,
    source_root: Option<&Path>,
    choice: Option<SaveCopyFormatChoice>,
) -> Result<(Option<(WorkspaceId, PathBuf)>, SaveCopyFormat), DesktopError> {
    match source {
        SaveCopySource::WorkspaceDocument {
            workspace_id,
            relative_path,
            revision,
        } => {
            let root = source_root.ok_or_else(editor_save_unavailable)?;
            let source_path = resolve_existing_workspace_path(root, relative_path)?;
            let latest = inspect_markdown_revision(&source_path)?;
            if latest != *revision {
                return Err(
                    DesktopError::new(DesktopErrorCode::FileRevisionConflict, true, true)
                        .with_path_hint(&source_path),
                );
            }
            Ok((
                Some((workspace_id.clone(), root.to_path_buf())),
                resolve_save_copy_format(Some(revision), choice)?,
            ))
        }
        SaveCopySource::NewDocument { .. } => {
            if source_root.is_some() {
                return Err(editor_save_unavailable());
            }
            Ok((None, resolve_save_copy_format(None, choice)?))
        }
    }
}

fn resolve_save_copy_format(
    revision: Option<&FileRevision>,
    choice: Option<SaveCopyFormatChoice>,
) -> Result<SaveCopyFormat, DesktopError> {
    match choice {
        Some(SaveCopyFormatChoice::Utf8Lf) => Ok(SaveCopyFormat {
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        }),
        Some(SaveCopyFormatChoice::Utf8Crlf) => Ok(SaveCopyFormat {
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Crlf,
        }),
        Some(SaveCopyFormatChoice::Utf8Cr) => Ok(SaveCopyFormat {
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Cr,
        }),
        None if revision.is_none() => Ok(SaveCopyFormat {
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        }),
        None | Some(SaveCopyFormatChoice::Preserve) => {
            let revision = revision.ok_or_else(save_copy_format_required)?;
            if revision.encoding == TextEncoding::Unsupported
                || revision.line_ending == LineEnding::Mixed
            {
                return Err(save_copy_format_required());
            }
            Ok(SaveCopyFormat {
                encoding: revision.encoding,
                line_ending: revision.line_ending,
            })
        }
    }
}

fn validate_save_copy_target(pending: &PendingSaveCopy) -> Result<(), DesktopError> {
    let parent = pending
        .target_path
        .parent()
        .ok_or_else(|| save_copy_target_changed(&pending.target_path))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| save_copy_target_changed(&pending.target_path))?;
    if native_path_identity(&canonical_parent)? != pending.parent_identity {
        return Err(save_copy_target_changed(&pending.target_path));
    }
    match (
        &pending.target_revision,
        fs::symlink_metadata(&pending.target_path),
    ) {
        (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        (Some(expected), Ok(metadata))
            if metadata.is_file() && !metadata.file_type().is_symlink() =>
        {
            let current = inspect_markdown_revision(&pending.target_path)?;
            if &current == expected {
                Ok(())
            } else {
                Err(save_copy_target_changed(&pending.target_path))
            }
        }
        _ => Err(save_copy_target_changed(&pending.target_path)),
    }
}

fn write_save_copy(
    pending: &PendingSaveCopy,
    bytes: &[u8],
    fault: SaveCopyFault,
) -> Result<(), DesktopError> {
    let temp_path = next_save_copy_temp_path(&pending.target_path)?;
    let mut guard = SaveCopyTempGuard::new(temp_path.clone());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .map_err(|error| map_save_copy_io(error, &pending.target_path))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| map_save_copy_io(error, &pending.target_path))?;
    if pending.target_revision.is_some() {
        let permissions = fs::metadata(&pending.target_path)
            .map_err(|error| map_save_copy_io(error, &pending.target_path))?
            .permissions();
        fs::set_permissions(&temp_path, permissions)
            .map_err(|error| map_save_copy_io(error, &pending.target_path))?;
    }
    drop(file);
    validate_save_copy_target(pending)?;
    if fault == SaveCopyFault::BeforeCommit {
        return Err(save_copy_failed(&pending.target_path));
    }
    let commit = if pending.target_revision.is_some() {
        atomic::replace_existing(&temp_path, &pending.target_path)
    } else {
        atomic::rename_without_replace(&temp_path, &pending.target_path)
    };
    commit.map_err(|error| map_save_copy_io(error, &pending.target_path))?;
    guard.disarm();
    if let Err(error) = atomic::sync_parent_directory(&pending.target_path) {
        eprintln!(
            "Plainroot save-copy parent sync failed for {}: {error}",
            pending
                .target_path
                .file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default()
        );
    }
    Ok(())
}

fn next_save_copy_temp_path(target: &Path) -> Result<PathBuf, DesktopError> {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| save_copy_failed(target))?;
    for _ in 0..TEMP_CREATE_ATTEMPTS {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| editor_save_unavailable())?;
        let mut token = String::new();
        for byte in random {
            write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
        }
        let candidate = target.with_file_name(format!(".{name}.plainroot-copy-{token}.tmp"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(map_save_copy_io(error, target)),
        }
    }
    Err(save_copy_failed(target))
}

fn workspace_relative_target(
    canonical_root: &Path,
    target: &Path,
) -> Option<WorkspaceRelativePath> {
    let relative = target.strip_prefix(canonical_root).ok()?.to_str()?;
    WorkspaceRelativePath::parse(&relative.replace('\\', "/")).ok()
}

fn content_hash(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

fn safe_suggested_name(name: &str) -> String {
    let candidate = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Untitled.md");
    if candidate
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md"))
    {
        candidate.to_owned()
    } else {
        format!("{candidate}.md")
    }
}

fn make_room<T>(pending: &mut HashMap<String, T>)
where
    T: PendingCreatedAt,
{
    while pending.len() >= MAX_PENDING_EDITOR_SAVES {
        let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, value)| value.created_at())
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        pending.remove(&oldest);
    }
}

trait PendingCreatedAt {
    fn created_at(&self) -> Instant;
}

impl PendingCreatedAt for PendingConflictOverwrite {
    fn created_at(&self) -> Instant {
        self.created_at
    }
}

impl PendingCreatedAt for PendingSaveCopy {
    fn created_at(&self) -> Instant {
        self.created_at
    }
}

fn prune_pending(pending: &mut PendingEditorSaves, now: Instant) {
    pending
        .overwrites
        .retain(|_, item| now.saturating_duration_since(item.created_at) <= EDITOR_SAVE_LIFETIME);
    pending
        .save_copies
        .retain(|_, item| now.saturating_duration_since(item.created_at) <= EDITOR_SAVE_LIFETIME);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum SaveCopyFault {
    None,
    BeforeCommit,
}

struct SaveCopyTempGuard {
    path: Option<PathBuf>,
}

impl SaveCopyTempGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for SaveCopyTempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn map_save_copy_io(error: io::Error, target: &Path) -> DesktopError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        DesktopError::new(DesktopErrorCode::PermissionDenied, true, true).with_path_hint(target)
    } else {
        save_copy_failed(target)
    }
}

fn editor_save_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::EditorSaveUnavailable, true, true)
}

fn conflict_confirmation_not_found() -> DesktopError {
    DesktopError::new(DesktopErrorCode::ConflictConfirmationNotFound, true, true)
}

fn save_copy_confirmation_not_found() -> DesktopError {
    DesktopError::new(DesktopErrorCode::SaveCopyConfirmationNotFound, true, true)
}

fn save_copy_target_changed(target: &Path) -> DesktopError {
    DesktopError::new(DesktopErrorCode::SaveCopyTargetChanged, true, true).with_path_hint(target)
}

fn save_copy_format_required() -> DesktopError {
    DesktopError::new(DesktopErrorCode::SaveCopyFormatRequired, true, false)
}

fn save_copy_failed(target: &Path) -> DesktopError {
    DesktopError::new(DesktopErrorCode::SaveCopyFailed, true, true).with_path_hint(target)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::fs::read::inspect_markdown_revision;
    use crate::test_support::TestDirectory;

    use super::*;

    struct Fixture {
        root: TestDirectory,
        workspace_root: PathBuf,
        service: EditorSaveService,
        safe_writes: WorkspaceSafeWriteService,
        workspace_id: WorkspaceId,
    }

    impl Fixture {
        fn new(source: &[u8]) -> Self {
            let root = TestDirectory::create("editor-save");
            let workspace_root = root.path().join("workspace");
            let app_data = root.path().join("app-data");
            fs::create_dir_all(&workspace_root).unwrap();
            fs::create_dir_all(&app_data).unwrap();
            fs::write(workspace_root.join("note.md"), source).unwrap();
            let workspace_root = fs::canonicalize(workspace_root).unwrap();
            let lock = Arc::new(Mutex::new(()));
            Self {
                root,
                safe_writes: WorkspaceSafeWriteService::initialize_at(
                    app_data.clone(),
                    Arc::clone(&lock),
                    vec![workspace_root.clone()],
                ),
                service: EditorSaveService::with_operation_lock(lock),
                workspace_root,
                workspace_id: WorkspaceId::parse("workspace-save").unwrap(),
            }
        }

        fn source(&self) -> SaveCopySource {
            SaveCopySource::WorkspaceDocument {
                workspace_id: self.workspace_id.clone(),
                relative_path: WorkspaceRelativePath::parse("note.md").unwrap(),
                revision: inspect_markdown_revision(&self.workspace_root.join("note.md")).unwrap(),
            }
        }

        fn proposal(
            &self,
            target: PathBuf,
            choice: Option<SaveCopyFormatChoice>,
        ) -> SaveCopyProposal {
            match self
                .service
                .prepare_save_copy(
                    Some(target),
                    self.source(),
                    Some(&self.workspace_root),
                    choice,
                )
                .unwrap()
            {
                SaveCopySelectionOutcome::Ready { proposal } => proposal,
                SaveCopySelectionOutcome::Cancelled => panic!("target should create a proposal"),
            }
        }
    }

    #[test]
    fn conflict_overwrite_binds_latest_revision_content_and_single_use_token() {
        let fixture = Fixture::new(b"disk\n");
        let relative = WorkspaceRelativePath::parse("note.md").unwrap();
        let proposal = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                relative,
                "editor\n",
            )
            .unwrap();
        assert_eq!(
            proposal.latest_revision.content_hash,
            content_hash("disk\n")
        );

        let mismatch = fixture
            .service
            .confirm_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.confirmation_id,
                "changed editor\n".to_owned(),
                &fixture.safe_writes,
            )
            .unwrap_err();
        assert_eq!(mismatch.code, DesktopErrorCode::ConflictContentChanged);
        assert_eq!(
            fs::read(fixture.workspace_root.join("note.md")).unwrap(),
            b"disk\n"
        );
        assert_eq!(
            fixture
                .service
                .confirm_conflict_overwrite(
                    &fixture.workspace_id,
                    &fixture.workspace_root,
                    &proposal.confirmation_id,
                    "editor\n".to_owned(),
                    &fixture.safe_writes,
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::ConflictConfirmationNotFound
        );
    }

    #[test]
    fn conflict_overwrite_rechecks_disk_revision_before_commit() {
        let fixture = Fixture::new(b"disk\n");
        let proposal = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "editor\n",
            )
            .unwrap();
        fs::write(fixture.workspace_root.join("note.md"), b"new external\n").unwrap();

        let error = fixture
            .service
            .confirm_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.confirmation_id,
                "editor\n".to_owned(),
                &fixture.safe_writes,
            )
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::FileRevisionConflict);
        assert_eq!(
            fs::read(fixture.workspace_root.join("note.md")).unwrap(),
            b"new external\n"
        );
    }

    #[test]
    fn conflict_overwrite_success_uses_safe_write_and_cancel_has_no_disk_effect() {
        let fixture = Fixture::new(b"\xEF\xBB\xBFdisk\r\n");
        let relative = WorkspaceRelativePath::parse("note.md").unwrap();
        let cancelled = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                relative.clone(),
                "cancelled\n",
            )
            .unwrap();
        assert!(fixture
            .service
            .cancel_conflict_overwrite(&cancelled.confirmation_id)
            .unwrap());
        assert_eq!(
            fs::read(fixture.workspace_root.join("note.md")).unwrap(),
            b"\xEF\xBB\xBFdisk\r\n"
        );

        let proposal = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                relative,
                "saved\nline\n",
            )
            .unwrap();
        let result = fixture
            .service
            .confirm_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.confirmation_id,
                "saved\nline\n".to_owned(),
                &fixture.safe_writes,
            )
            .unwrap();
        assert_eq!(result.revision.encoding, TextEncoding::Utf8Bom);
        assert_eq!(result.revision.line_ending, LineEnding::Crlf);
        assert_eq!(
            fs::read(fixture.workspace_root.join("note.md")).unwrap(),
            b"\xEF\xBB\xBFsaved\r\nline\r\n"
        );
    }

    #[test]
    fn new_save_copy_outside_workspace_defaults_to_utf8_lf_and_is_single_use() {
        let fixture = Fixture::new(b"source\n");
        let outside = fixture.root.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let proposal = match fixture
            .service
            .prepare_save_copy(
                Some(outside.join("copy")),
                SaveCopySource::NewDocument {
                    suggested_name: "Draft".to_owned(),
                },
                None,
                None,
            )
            .unwrap()
        {
            SaveCopySelectionOutcome::Ready { proposal } => proposal,
            SaveCopySelectionOutcome::Cancelled => panic!("target should create a proposal"),
        };
        assert_eq!(proposal.target_state, SaveCopyTargetState::New);
        assert_eq!(proposal.output_encoding, TextEncoding::Utf8);
        assert_eq!(proposal.output_line_ending, LineEnding::Lf);
        assert!(proposal.workspace_id.is_none());

        let result = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "a\r\nb\r".to_owned(), false)
            .unwrap();
        assert_eq!(fs::read(&result.display_path).unwrap(), b"a\nb\n");
        assert_eq!(
            fixture
                .service
                .confirm_save_copy(&proposal.confirmation_id, "again".to_owned(), false)
                .unwrap_err()
                .code,
            DesktopErrorCode::SaveCopyConfirmationNotFound
        );
    }

    #[test]
    fn workspace_copy_preserves_bom_and_single_line_ending_or_uses_explicit_format() {
        let fixture = Fixture::new(b"\xEF\xBB\xBFsource\r\nline\r\n");
        let preserve = fixture.proposal(
            fixture.workspace_root.join("preserved.md"),
            Some(SaveCopyFormatChoice::Preserve),
        );
        let preserved = fixture
            .service
            .confirm_save_copy(&preserve.confirmation_id, "a\nb\n".to_owned(), false)
            .unwrap();
        assert_eq!(
            fs::read(&preserved.display_path).unwrap(),
            b"\xEF\xBB\xBFa\r\nb\r\n"
        );
        assert_eq!(
            preserved.relative_path.as_ref().map(|path| path.as_str()),
            Some("preserved.md")
        );

        let normalized = fixture.proposal(
            fixture.workspace_root.join("normalized.md"),
            Some(SaveCopyFormatChoice::Utf8Cr),
        );
        let normalized = fixture
            .service
            .confirm_save_copy(&normalized.confirmation_id, "a\nb\n".to_owned(), false)
            .unwrap();
        assert_eq!(fs::read(normalized.display_path).unwrap(), b"a\rb\r");
    }

    #[test]
    fn mixed_and_unsupported_sources_require_an_explicit_utf8_choice() {
        let mixed = Fixture::new(b"a\r\nb\n");
        let target = mixed.root.path().join("mixed-copy.md");
        let error = mixed
            .service
            .prepare_save_copy(
                Some(target.clone()),
                mixed.source(),
                Some(&mixed.workspace_root),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::SaveCopyFormatRequired);
        let proposal = mixed.proposal(target, Some(SaveCopyFormatChoice::Utf8Lf));
        let result = mixed
            .service
            .confirm_save_copy(&proposal.confirmation_id, "a\r\nb\n".to_owned(), false)
            .unwrap();
        assert_eq!(fs::read(result.display_path).unwrap(), b"a\nb\n");

        let unsupported = Fixture::new(&[0xff, b'\n']);
        let error = unsupported
            .service
            .prepare_save_copy(
                Some(unsupported.root.path().join("unsupported-copy.md")),
                unsupported.source(),
                Some(&unsupported.workspace_root),
                Some(SaveCopyFormatChoice::Preserve),
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::SaveCopyFormatRequired);
    }

    #[test]
    fn changed_source_revision_is_rejected_before_target_authority_is_created() {
        let fixture = Fixture::new(b"source\n");
        let stale_source = fixture.source();
        let target = fixture.root.path().join("stale-source-copy.md");
        fs::write(fixture.workspace_root.join("note.md"), b"external\n").unwrap();

        let error = fixture
            .service
            .prepare_save_copy(
                Some(target.clone()),
                stale_source,
                Some(&fixture.workspace_root),
                None,
            )
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::FileRevisionConflict);
        assert!(!target.exists());
        assert!(fixture
            .service
            .lock_pending()
            .unwrap()
            .save_copies
            .is_empty());
    }

    #[test]
    fn existing_target_requires_confirmation_and_rejects_toctou_changes() {
        let fixture = Fixture::new(b"source\n");
        let target = fixture.root.path().join("existing.md");
        fs::write(&target, b"old\n").unwrap();
        let proposal = fixture.proposal(target.clone(), None);
        assert_eq!(proposal.target_state, SaveCopyTargetState::Existing);

        let error = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "new\n".to_owned(), false)
            .unwrap_err();
        assert_eq!(
            error.code,
            DesktopErrorCode::SaveCopyOverwriteConfirmationRequired
        );
        assert_eq!(fs::read(&target).unwrap(), b"old\n");

        let proposal = fixture.proposal(target.clone(), None);
        fs::write(&target, b"external\n").unwrap();
        let error = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "new\n".to_owned(), true)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::SaveCopyTargetChanged);
        assert_eq!(fs::read(&target).unwrap(), b"external\n");

        let proposal = fixture.proposal(target.clone(), None);
        let result = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "committed\n".to_owned(), true)
            .unwrap();
        assert_eq!(fs::read(result.display_path).unwrap(), b"committed\n");
    }

    #[test]
    fn save_copy_fault_preserves_existing_target_and_removes_temp_file() {
        let fixture = Fixture::new(b"source\n");
        let target = fixture.root.path().join("fault.md");
        fs::write(&target, b"old\n").unwrap();
        let proposal = fixture.proposal(target.clone(), None);
        let error = fixture
            .service
            .confirm_save_copy_with_fault(
                &proposal.confirmation_id,
                "new\n".to_owned(),
                true,
                SaveCopyFault::BeforeCommit,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::SaveCopyFailed);
        assert_eq!(fs::read(&target).unwrap(), b"old\n");
        assert!(
            !fs::read_dir(fixture.root.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("plainroot-copy"))
        );
    }

    #[test]
    fn missing_parent_after_prepare_invalidates_the_single_target() {
        let fixture = Fixture::new(b"source\n");
        let target_parent = fixture.root.path().join("temporary-parent");
        fs::create_dir_all(&target_parent).unwrap();
        let target = target_parent.join("copy.md");
        let proposal = fixture.proposal(target.clone(), None);
        fs::remove_dir(&target_parent).unwrap();

        let error = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "content\n".to_owned(), false)
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::SaveCopyTargetChanged);
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inserted_after_prepare_cannot_redirect_a_save_copy() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new(b"source\n");
        let target = fixture.root.path().join("copy.md");
        let outside = fixture.root.path().join("outside.md");
        fs::write(&outside, b"outside\n").unwrap();
        let proposal = fixture.proposal(target.clone(), None);
        symlink(&outside, &target).unwrap();

        let error = fixture
            .service
            .confirm_save_copy(&proposal.confirmation_id, "content\n".to_owned(), false)
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::SaveCopyTargetChanged);
        assert_eq!(fs::read(&outside).unwrap(), b"outside\n");
        assert!(fs::symlink_metadata(target)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn concurrent_confirmation_consumes_a_save_copy_token_once() {
        let fixture = Fixture::new(b"source\n");
        let proposal = fixture.proposal(fixture.root.path().join("concurrent.md"), None);
        let barrier = Arc::new(Barrier::new(3));
        let handles = ["first\n", "second\n"].map(|content| {
            let service = fixture.service.clone();
            let confirmation_id = proposal.confirmation_id.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                service.confirm_save_copy(&confirmation_id, content.to_owned(), false)
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result.as_ref().is_err_and(|error| {
                    error.code == DesktopErrorCode::SaveCopyConfirmationNotFound
                }))
                .count(),
            1
        );
    }

    #[test]
    fn cancellation_and_expiry_remove_authority_without_writing() {
        let fixture = Fixture::new(b"source\n");
        let target = fixture.root.path().join("cancelled.md");
        let cancelled = fixture.proposal(target.clone(), None);
        assert!(fixture
            .service
            .cancel_save_copy(&cancelled.confirmation_id)
            .unwrap());
        assert!(!target.exists());

        let expired = fixture.proposal(target.clone(), None);
        {
            let mut pending = fixture.service.lock_pending().unwrap();
            pending
                .save_copies
                .get_mut(&expired.confirmation_id)
                .unwrap()
                .created_at = Instant::now() - EDITOR_SAVE_LIFETIME - Duration::from_secs(1);
        }
        assert_eq!(
            fixture
                .service
                .confirm_save_copy(&expired.confirmation_id, "content".to_owned(), false)
                .unwrap_err()
                .code,
            DesktopErrorCode::SaveCopyConfirmationNotFound
        );
        assert!(!target.exists());
    }

    #[test]
    fn pending_authority_is_bounded_and_oldest_tokens_expire_first() {
        let fixture = Fixture::new(b"source\n");
        let mut first_conflict = None;
        for index in 0..=MAX_PENDING_EDITOR_SAVES {
            let proposal = fixture
                .service
                .prepare_conflict_overwrite(
                    &fixture.workspace_id,
                    &fixture.workspace_root,
                    WorkspaceRelativePath::parse("note.md").unwrap(),
                    &format!("editor {index}"),
                )
                .unwrap();
            first_conflict.get_or_insert(proposal.confirmation_id);
        }
        let mut pending = fixture.service.lock_pending().unwrap();
        assert_eq!(pending.overwrites.len(), MAX_PENDING_EDITOR_SAVES);
        assert!(!pending
            .overwrites
            .contains_key(first_conflict.as_ref().unwrap()));
        let expiring = pending.overwrites.values_mut().next().unwrap();
        expiring.created_at = Instant::now() - EDITOR_SAVE_LIFETIME - Duration::from_secs(1);
        drop(pending);
        let replacement = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "replacement",
            )
            .unwrap();
        assert!(fixture
            .service
            .cancel_conflict_overwrite(&replacement.confirmation_id)
            .unwrap());
        assert!(
            fixture.service.lock_pending().unwrap().overwrites.len() < MAX_PENDING_EDITOR_SAVES
        );
    }

    #[cfg(unix)]
    #[test]
    fn readonly_conflict_still_returns_evidence_but_cannot_overwrite() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new(b"disk\n");
        let target = fixture.workspace_root.join("note.md");
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o444);
        fs::set_permissions(&target, permissions).unwrap();

        let proposal = fixture
            .service
            .prepare_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                WorkspaceRelativePath::parse("note.md").unwrap(),
                "editor\n",
            )
            .unwrap();
        assert!(!proposal.target_writable);
        let error = fixture
            .service
            .confirm_conflict_overwrite(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.confirmation_id,
                "editor\n".to_owned(),
                &fixture.safe_writes,
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::PermissionDenied);
        assert_eq!(fs::read(target).unwrap(), b"disk\n");
    }

    #[test]
    fn save_copy_contracts_and_enum_values_match_typescript() {
        let revision = FileRevision {
            modified_at: 1,
            size: 1,
            content_hash: content_hash("x"),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        };
        let conflict = ConflictOverwriteProposal {
            confirmation_id: "conflict-v1-test".to_owned(),
            relative_path: WorkspaceRelativePath::parse("note.md").unwrap(),
            latest_revision: revision.clone(),
            current_content_hash: content_hash("editor"),
            target_writable: true,
        };
        let proposal = SaveCopyProposal {
            confirmation_id: "save-copy-v1-test".to_owned(),
            display_path: PathBuf::from("copy.md"),
            file_name: "copy.md".to_owned(),
            target_state: SaveCopyTargetState::New,
            target_revision: None,
            output_encoding: TextEncoding::Utf8,
            output_line_ending: LineEnding::Lf,
            workspace_id: None,
            relative_path: None,
        };
        let result = SaveCopyResult {
            display_path: PathBuf::from("copy.md"),
            workspace_id: None,
            relative_path: None,
            revision,
            bytes_written: 1,
        };
        assert_interface_matches("ConflictOverwriteProposal", &conflict);
        assert_interface_matches("SaveCopyProposal", &proposal);
        assert_interface_matches("SaveCopyResult", &result);
        assert_eq!(
            SaveCopyFormatChoice::ALL
                .iter()
                .map(|value| serde_json::to_value(value)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("SAVE_COPY_FORMAT_CHOICES")
        );
        assert_eq!(
            SaveCopyTargetState::ALL
                .iter()
                .map(|value| serde_json::to_value(value)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("SAVE_COPY_TARGET_STATES")
        );
        let sources = [
            SaveCopySource::WorkspaceDocument {
                workspace_id: WorkspaceId::parse("workspace-contract").unwrap(),
                relative_path: WorkspaceRelativePath::parse("note.md").unwrap(),
                revision: result.revision.clone(),
            },
            SaveCopySource::NewDocument {
                suggested_name: "Untitled.md".to_owned(),
            },
        ];
        let source_json = sources
            .iter()
            .map(|source| serde_json::to_value(source).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            source_json
                .iter()
                .map(|source| source["kind"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("SAVE_COPY_SOURCE_KINDS")
        );
        assert_eq!(source_json[0]["workspaceId"], "workspace-contract");
        assert_eq!(source_json[0]["relativePath"], "note.md");
        assert_eq!(source_json[1]["suggestedName"], "Untitled.md");

        let outcomes = [
            SaveCopySelectionOutcome::Cancelled,
            SaveCopySelectionOutcome::Ready { proposal },
        ];
        let outcome_json = outcomes
            .iter()
            .map(|outcome| serde_json::to_value(outcome).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcome_json
                .iter()
                .map(|outcome| outcome["status"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("SAVE_COPY_SELECTION_STATUSES")
        );
        assert_eq!(
            outcome_json[0],
            serde_json::json!({ "status": "cancelled" })
        );
        assert!(outcome_json[1].get("proposal").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn serialized_save_copy_paths_hide_windows_extended_prefixes() {
        let revision = FileRevision {
            modified_at: 1,
            size: 1,
            content_hash: content_hash("x"),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::Lf,
        };
        let result = SaveCopyResult {
            display_path: PathBuf::from(r"\\?\C:\Users\Alice\copy.md"),
            workspace_id: None,
            relative_path: None,
            revision,
            bytes_written: 1,
        };

        let json = serde_json::to_value(result).unwrap();

        assert_eq!(json["displayPath"], r"C:\Users\Alice\copy.md");
        assert!(!json.to_string().contains(r"\\?\\"));
    }
}
