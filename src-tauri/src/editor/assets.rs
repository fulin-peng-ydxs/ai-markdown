use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{atomic, native_path_identity, WorkspaceId, WorkspaceRelativePath};
use crate::preferences::validate_asset_directory;

pub const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;
pub const ASSET_UPLOAD_HEADER: &str = "x-plainroot-asset-upload-id";
const MAX_PENDING_ASSET_ACTIONS: usize = 32;
const ASSET_ACTION_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_UNIQUE_NAME_ATTEMPTS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl AssetImageKind {
    pub const ALL: &'static [Self] = &[Self::Png, Self::Jpeg, Self::Gif, Self::Webp];

    fn from_declared_mime(value: &str) -> Result<Self, DesktopError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "image/png" => Ok(Self::Png),
            "image/jpeg" => Ok(Self::Jpeg),
            "image/gif" => Ok(Self::Gif),
            "image/webp" => Ok(Self::Webp),
            _ => Err(asset_error(DesktopErrorCode::AssetUnsupportedType, false)),
        }
    }

    pub(crate) fn media_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
}

pub(crate) fn read_workspace_image_bytes(
    canonical_root: &Path,
    relative_path: &WorkspaceRelativePath,
) -> Result<Vec<u8>, DesktopError> {
    let path = crate::fs::resolve_existing_workspace_path(canonical_root, relative_path)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| DesktopError::from_io(&error, &path, true))?;
    if metadata.file_type().is_symlink() {
        return Err(
            DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                .with_path_hint(&path),
        );
    }
    if !metadata.is_file() {
        return Err(DesktopError::new(DesktopErrorCode::NotFile, true, false).with_path_hint(&path));
    }
    if metadata.len() > MAX_ASSET_BYTES as u64 {
        return Err(asset_error(DesktopErrorCode::AssetTooLarge, false));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&path)
        .map_err(|error| DesktopError::from_io(&error, &path, true))?
        .take(MAX_ASSET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| DesktopError::from_io(&error, &path, true))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(asset_error(DesktopErrorCode::AssetTooLarge, false));
    }
    detect_image_kind(&bytes)?;
    Ok(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadTicket {
    pub upload_id: String,
    pub max_bytes: u64,
    pub accepted_kind: AssetImageKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportProposal {
    pub import_id: String,
    pub workspace_id: WorkspaceId,
    pub asset_path: WorkspaceRelativePath,
    pub file_name: String,
    pub image_kind: AssetImageKind,
    pub media_type: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AssetImportSelectionOutcome {
    Cancelled,
    Ready { proposal: AssetImportProposal },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    pub workspace_id: WorkspaceId,
    pub asset_path: WorkspaceRelativePath,
    pub file_name: String,
    pub image_kind: AssetImageKind,
    pub media_type: String,
    pub byte_length: u64,
}

#[derive(Debug)]
struct PendingAssetUpload {
    created_at: Instant,
    workspace_id: WorkspaceId,
    canonical_root: PathBuf,
    root_identity: String,
    asset_directory: WorkspaceRelativePath,
    expected_kind: AssetImageKind,
    readable_stem: String,
}

#[derive(Debug, Clone)]
struct AssetFileEvidence {
    native_identity: String,
    byte_length: u64,
    content_hash: String,
}

#[derive(Debug)]
struct PendingAssetImport {
    created_at: Instant,
    proposal: AssetImportProposal,
    canonical_root: PathBuf,
    root_identity: String,
    evidence: AssetFileEvidence,
}

#[derive(Debug, Default)]
struct PendingAssetActions {
    uploads: HashMap<String, PendingAssetUpload>,
    imports: HashMap<String, PendingAssetImport>,
}

#[derive(Debug)]
struct AssetImportInner {
    operation_lock: Arc<Mutex<()>>,
    pending: Mutex<PendingAssetActions>,
}

impl Drop for AssetImportInner {
    fn drop(&mut self) {
        let imports = self
            .pending
            .get_mut()
            .map(|pending| {
                pending
                    .imports
                    .drain()
                    .map(|(_, import)| import)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Ok(_guard) = self.operation_lock.lock() {
            for import in imports {
                let _ = remove_unchanged_import(&import);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct AssetImportService {
    inner: Arc<AssetImportInner>,
}

impl AssetImportService {
    pub(crate) fn with_operation_lock(operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            inner: Arc::new(AssetImportInner {
                operation_lock,
                pending: Mutex::new(PendingAssetActions::default()),
            }),
        }
    }

    pub fn begin_upload(
        &self,
        workspace_id: WorkspaceId,
        canonical_root: &Path,
        asset_directory: WorkspaceRelativePath,
        declared_mime: &str,
        suggested_name: &str,
    ) -> Result<AssetUploadTicket, DesktopError> {
        self.prune_expired()?;
        validate_asset_directory(canonical_root, &asset_directory)?;
        let expected_kind = AssetImageKind::from_declared_mime(declared_mime)?;
        let upload_id = self.next_id("asset-upload-v1-")?;
        let upload = PendingAssetUpload {
            created_at: Instant::now(),
            workspace_id,
            canonical_root: canonical_root.to_path_buf(),
            root_identity: native_path_identity(canonical_root)?,
            asset_directory,
            expected_kind,
            readable_stem: readable_asset_stem(suggested_name),
        };
        let mut pending = self.lock_pending()?;
        make_room(&mut pending.uploads);
        pending.uploads.insert(upload_id.clone(), upload);
        Ok(AssetUploadTicket {
            upload_id,
            max_bytes: MAX_ASSET_BYTES as u64,
            accepted_kind: expected_kind,
        })
    }

    pub fn upload_workspace_id(&self, upload_id: &str) -> Result<WorkspaceId, DesktopError> {
        self.prune_expired()?;
        self.lock_pending()?
            .uploads
            .get(upload_id)
            .map(|upload| upload.workspace_id.clone())
            .ok_or_else(asset_upload_not_found)
    }

    pub fn upload(
        &self,
        upload_id: &str,
        bytes: Vec<u8>,
    ) -> Result<AssetImportProposal, DesktopError> {
        self.prune_expired()?;
        let import_id = self.next_id("asset-import-v1-")?;
        let upload = self
            .lock_pending()?
            .uploads
            .remove(upload_id)
            .ok_or_else(asset_upload_not_found)?;
        self.import_bytes(import_id, upload, bytes, false)
    }

    pub fn import_selected_file(
        &self,
        selected_path: Option<PathBuf>,
        workspace_id: WorkspaceId,
        canonical_root: &Path,
        asset_directory: WorkspaceRelativePath,
    ) -> Result<AssetImportSelectionOutcome, DesktopError> {
        self.prune_expired()?;
        let Some(selected_path) = selected_path else {
            return Ok(AssetImportSelectionOutcome::Cancelled);
        };
        validate_asset_directory(canonical_root, &asset_directory)?;
        let metadata = fs::symlink_metadata(&selected_path)
            .map_err(|error| DesktopError::from_io(&error, &selected_path, true))?;
        if metadata.file_type().is_symlink() {
            return Err(
                DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                    .with_path_hint(&selected_path),
            );
        }
        if !metadata.is_file() {
            return Err(DesktopError::new(DesktopErrorCode::NotFile, true, false)
                .with_path_hint(&selected_path));
        }
        let mut bytes = Vec::new();
        File::open(&selected_path)
            .and_then(|file| {
                file.take((MAX_ASSET_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| DesktopError::from_io(&error, &selected_path, true))?;
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(asset_error(DesktopErrorCode::AssetTooLarge, false));
        }
        let kind = detect_image_kind(&bytes)?;
        let import_id = self.next_id("asset-import-v1-")?;
        let upload = PendingAssetUpload {
            created_at: Instant::now(),
            workspace_id,
            canonical_root: canonical_root.to_path_buf(),
            root_identity: native_path_identity(canonical_root)?,
            asset_directory,
            expected_kind: kind,
            readable_stem: readable_asset_stem(
                selected_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("image"),
            ),
        };
        let proposal = self.import_bytes(import_id, upload, bytes, false)?;
        Ok(AssetImportSelectionOutcome::Ready { proposal })
    }

    pub fn confirm(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        import_id: &str,
    ) -> Result<AssetImportResult, DesktopError> {
        self.prune_expired()?;
        let root_identity = native_path_identity(canonical_root)?;
        let import = {
            let mut pending = self.lock_pending()?;
            let import = pending
                .imports
                .get(import_id)
                .ok_or_else(asset_import_not_found)?;
            if import.proposal.workspace_id != *workspace_id
                || import.root_identity != root_identity
            {
                return Err(asset_import_not_found());
            }
            pending
                .imports
                .remove(import_id)
                .expect("the checked import token still exists while the lock is held")
        };
        validate_unchanged_import(&import)?;
        Ok(result_from_proposal(import.proposal))
    }

    pub fn cancel(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        import_id: &str,
    ) -> Result<bool, DesktopError> {
        self.prune_expired()?;
        let root_identity = native_path_identity(canonical_root)?;
        let import = {
            let mut pending = self.lock_pending()?;
            let import = pending
                .imports
                .get(import_id)
                .ok_or_else(asset_import_not_found)?;
            if import.proposal.workspace_id != *workspace_id
                || import.root_identity != root_identity
            {
                return Err(asset_import_not_found());
            }
            pending
                .imports
                .remove(import_id)
                .expect("the checked import token still exists while the lock is held")
        };
        let _guard = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))?;
        remove_unchanged_import(&import)?;
        Ok(true)
    }

    fn import_bytes(
        &self,
        import_id: String,
        upload: PendingAssetUpload,
        bytes: Vec<u8>,
        fail_before_commit: bool,
    ) -> Result<AssetImportProposal, DesktopError> {
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(asset_error(DesktopErrorCode::AssetTooLarge, false));
        }
        let detected = detect_image_kind(&bytes)?;
        if detected != upload.expected_kind {
            return Err(asset_error(DesktopErrorCode::AssetMimeMismatch, false));
        }
        let _guard = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))?;
        if native_path_identity(&upload.canonical_root)? != upload.root_identity {
            return Err(asset_error(DesktopErrorCode::AssetWriteFailed, true));
        }
        let asset_directory =
            ensure_asset_directory(&upload.canonical_root, &upload.asset_directory)?;
        let (path, file_name) = write_unique_asset(
            &asset_directory,
            &upload.readable_stem,
            detected,
            &bytes,
            fail_before_commit,
        )?;
        let asset_path = WorkspaceRelativePath::parse(&format!(
            "{}/{}",
            upload.asset_directory.as_str(),
            file_name
        ))?;
        let proposal = AssetImportProposal {
            import_id: import_id.clone(),
            workspace_id: upload.workspace_id,
            asset_path,
            file_name,
            image_kind: detected,
            media_type: detected.media_type().to_owned(),
            byte_length: bytes.len() as u64,
        };
        let evidence = inspect_asset_evidence(&path)?;
        let import = PendingAssetImport {
            created_at: Instant::now(),
            proposal: proposal.clone(),
            canonical_root: upload.canonical_root,
            root_identity: upload.root_identity,
            evidence,
        };
        let evicted = {
            let mut pending = match self.lock_pending() {
                Ok(pending) => pending,
                Err(error) => {
                    let _ = remove_unchanged_import(&import);
                    return Err(error);
                }
            };
            let evicted = take_oldest_if_full(&mut pending.imports);
            pending.imports.insert(import_id, import);
            evicted
        };
        if let Some(evicted) = evicted {
            let _ = remove_unchanged_import(&evicted);
        }
        Ok(proposal)
    }

    #[cfg(test)]
    fn upload_with_failure_before_commit(
        &self,
        upload_id: &str,
        bytes: Vec<u8>,
    ) -> Result<AssetImportProposal, DesktopError> {
        self.prune_expired()?;
        let import_id = self.next_id("asset-import-v1-")?;
        let upload = self
            .lock_pending()?
            .uploads
            .remove(upload_id)
            .ok_or_else(asset_upload_not_found)?;
        self.import_bytes(import_id, upload, bytes, true)
    }

    fn prune_expired(&self) -> Result<(), DesktopError> {
        let now = Instant::now();
        let expired = {
            let mut pending = self.lock_pending()?;
            pending.uploads.retain(|_, upload| {
                now.saturating_duration_since(upload.created_at) <= ASSET_ACTION_LIFETIME
            });
            let expired_ids = pending
                .imports
                .iter()
                .filter(|(_, import)| {
                    now.saturating_duration_since(import.created_at) > ASSET_ACTION_LIFETIME
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            expired_ids
                .into_iter()
                .filter_map(|id| pending.imports.remove(&id))
                .collect::<Vec<_>>()
        };
        if expired.is_empty() {
            return Ok(());
        }
        let _guard = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))?;
        for import in expired {
            let _ = remove_unchanged_import(&import);
        }
        Ok(())
    }

    fn next_id(&self, prefix: &str) -> Result<String, DesktopError> {
        for _ in 0..100 {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random)
                .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))?;
            let mut candidate = prefix.to_owned();
            for byte in random {
                write!(&mut candidate, "{byte:02x}")
                    .expect("writing random bytes to a String cannot fail");
            }
            let pending = self.lock_pending()?;
            if !pending.uploads.contains_key(&candidate)
                && !pending.imports.contains_key(&candidate)
            {
                return Ok(candidate);
            }
        }
        Err(asset_error(DesktopErrorCode::AssetWriteFailed, true))
    }

    fn lock_pending(&self) -> Result<std::sync::MutexGuard<'_, PendingAssetActions>, DesktopError> {
        self.inner
            .pending
            .lock()
            .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))
    }
}

fn ensure_asset_directory(
    canonical_root: &Path,
    relative: &WorkspaceRelativePath,
) -> Result<PathBuf, DesktopError> {
    validate_asset_directory(canonical_root, relative)?;
    let mut current = canonical_root.to_path_buf();
    for segment in relative.as_str().split('/') {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(
                    DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                        .with_path_hint(&current),
                );
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(
                    DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                        .with_path_hint(&current),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|error| DesktopError::from_io(&error, &current, true))?;
            }
            Err(error) => return Err(DesktopError::from_io(&error, &current, true)),
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| DesktopError::from_io(&error, &current, true))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(
                DesktopError::new(DesktopErrorCode::SymlinkNotAllowed, true, false)
                    .with_path_hint(&current),
            );
        }
    }
    let canonical = fs::canonicalize(&current)
        .map_err(|error| DesktopError::from_io(&error, &current, true))?;
    if !canonical.starts_with(canonical_root) {
        return Err(
            DesktopError::new(DesktopErrorCode::PathOutsideWorkspace, true, false)
                .with_path_hint(&current),
        );
    }
    Ok(canonical)
}

fn write_unique_asset(
    directory: &Path,
    readable_stem: &str,
    kind: AssetImageKind,
    bytes: &[u8],
    fail_before_commit: bool,
) -> Result<(PathBuf, String), DesktopError> {
    let temp_path = next_temp_path(directory)?;
    let mut guard = TempGuard::new(temp_path.clone());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .map_err(|error| map_asset_io(error, &temp_path))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| map_asset_io(error, &temp_path))?;
    drop(file);
    if fail_before_commit {
        return Err(asset_error(DesktopErrorCode::AssetWriteFailed, true));
    }

    for index in 1..=MAX_UNIQUE_NAME_ATTEMPTS {
        let file_name = if index == 1 {
            format!("{readable_stem}.{}", kind.extension())
        } else {
            format!("{readable_stem}-{index}.{}", kind.extension())
        };
        let target = directory.join(&file_name);
        match atomic::rename_without_replace(&temp_path, &target) {
            Ok(()) => {
                guard.disarm();
                let _ = atomic::sync_parent_directory(&target);
                return Ok((target, file_name));
            }
            Err(error) if target.exists() || error.kind() == io::ErrorKind::AlreadyExists => {
                continue;
            }
            Err(error) => return Err(map_asset_io(error, &target)),
        }
    }
    Err(asset_error(DesktopErrorCode::AssetWriteFailed, true))
}

fn next_temp_path(directory: &Path) -> Result<PathBuf, DesktopError> {
    for _ in 0..100 {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| asset_error(DesktopErrorCode::AssetWriteFailed, true))?;
        let mut token = String::new();
        for byte in random {
            write!(&mut token, "{byte:02x}").expect("writing random bytes to a String cannot fail");
        }
        let candidate = directory.join(format!(".plainroot-asset-{token}.tmp"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(asset_error(DesktopErrorCode::AssetWriteFailed, true))
}

fn detect_image_kind(bytes: &[u8]) -> Result<AssetImageKind, DesktopError> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Ok(AssetImageKind::Png)
    } else if bytes.len() >= 4
        && bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        && bytes.ends_with(&[0xFF, 0xD9])
    {
        Ok(AssetImageKind::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(AssetImageKind::Gif)
    } else if bytes.len() >= 12
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
        && u32::from_le_bytes(bytes[4..8].try_into().expect("four-byte slice")) as usize + 8
            == bytes.len()
    {
        Ok(AssetImageKind::Webp)
    } else {
        Err(asset_error(DesktopErrorCode::AssetUnsupportedType, false))
    }
}

fn readable_asset_stem(suggested_name: &str) -> String {
    let name = Path::new(suggested_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("image");
    let mut output = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            if separator && !output.is_empty() {
                output.push('-');
            }
            separator = false;
            output.push(character);
        } else {
            separator = true;
        }
        if output.encode_utf16().count() >= 80 {
            break;
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        "image".to_owned()
    } else {
        output.to_owned()
    }
}

fn inspect_asset_evidence(path: &Path) -> Result<AssetFileEvidence, DesktopError> {
    let metadata = fs::metadata(path).map_err(|error| DesktopError::from_io(&error, path, true))?;
    let bytes = fs::read(path).map_err(|error| DesktopError::from_io(&error, path, true))?;
    Ok(AssetFileEvidence {
        native_identity: native_file_identity(path, &metadata)?,
        byte_length: metadata.len(),
        content_hash: format!("sha256:{:x}", Sha256::digest(&bytes)),
    })
}

fn validate_unchanged_import(import: &PendingAssetImport) -> Result<PathBuf, DesktopError> {
    let path = import
        .canonical_root
        .join(import.proposal.asset_path.to_path_buf());
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| asset_error(DesktopErrorCode::AssetTargetChanged, true))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(asset_error(DesktopErrorCode::AssetTargetChanged, true));
    }
    let evidence = inspect_asset_evidence(&path)?;
    if evidence.native_identity != import.evidence.native_identity
        || evidence.byte_length != import.evidence.byte_length
        || evidence.content_hash != import.evidence.content_hash
    {
        return Err(asset_error(DesktopErrorCode::AssetTargetChanged, true));
    }
    Ok(path)
}

fn remove_unchanged_import(import: &PendingAssetImport) -> Result<(), DesktopError> {
    let path = validate_unchanged_import(import)?;
    fs::remove_file(&path).map_err(|error| map_asset_io(error, &path))?;
    Ok(())
}

#[cfg(unix)]
fn native_file_identity(_path: &Path, metadata: &fs::Metadata) -> Result<String, DesktopError> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn native_file_identity(path: &Path, _metadata: &fs::Metadata) -> Result<String, DesktopError> {
    let identity =
        crate::fs::windows_file_identity(path).map_err(|error| map_asset_io(error, path))?;
    Ok(format!(
        "{}:{}",
        identity.volume_serial, identity.file_index
    ))
}

#[cfg(not(any(unix, windows)))]
fn native_file_identity(path: &Path, metadata: &fs::Metadata) -> Result<String, DesktopError> {
    Ok(format!(
        "{}:{}",
        native_path_identity(path)?,
        metadata.len()
    ))
}

fn result_from_proposal(proposal: AssetImportProposal) -> AssetImportResult {
    AssetImportResult {
        workspace_id: proposal.workspace_id,
        asset_path: proposal.asset_path,
        file_name: proposal.file_name,
        image_kind: proposal.image_kind,
        media_type: proposal.media_type,
        byte_length: proposal.byte_length,
    }
}

fn make_room<T>(pending: &mut HashMap<String, T>)
where
    T: CreatedAt,
{
    while pending.len() >= MAX_PENDING_ASSET_ACTIONS {
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

fn take_oldest_if_full(
    pending: &mut HashMap<String, PendingAssetImport>,
) -> Option<PendingAssetImport> {
    if pending.len() < MAX_PENDING_ASSET_ACTIONS {
        return None;
    }
    let oldest = pending
        .iter()
        .min_by_key(|(_, value)| value.created_at)
        .map(|(id, _)| id.clone())?;
    pending.remove(&oldest)
}

trait CreatedAt {
    fn created_at(&self) -> Instant;
}

impl CreatedAt for PendingAssetUpload {
    fn created_at(&self) -> Instant {
        self.created_at
    }
}

fn map_asset_io(error: io::Error, path: &Path) -> DesktopError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        DesktopError::new(DesktopErrorCode::PermissionDenied, true, true).with_path_hint(path)
    } else {
        asset_error(DesktopErrorCode::AssetWriteFailed, true).with_path_hint(path)
    }
}

fn asset_upload_not_found() -> DesktopError {
    asset_error(DesktopErrorCode::AssetUploadNotFound, true)
}

fn asset_import_not_found() -> DesktopError {
    asset_error(DesktopErrorCode::AssetImportNotFound, true)
}

fn asset_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

struct TempGuard {
    path: Option<PathBuf>,
}

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::test_support::TestDirectory;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const GIF: &[u8] = b"GIF89afixture";
    const JPEG: &[u8] = b"\xff\xd8\xfffixture\xff\xd9";
    const WEBP: &[u8] = b"RIFF\x04\x00\x00\x00WEBP";

    struct Fixture {
        root: TestDirectory,
        workspace_root: PathBuf,
        workspace_id: WorkspaceId,
        service: AssetImportService,
    }

    impl Fixture {
        fn new() -> Self {
            let root = TestDirectory::create("asset-import");
            let workspace_root = root.path().join("workspace");
            fs::create_dir_all(&workspace_root).unwrap();
            let workspace_root = fs::canonicalize(workspace_root).unwrap();
            Self {
                root,
                workspace_root,
                workspace_id: WorkspaceId::parse("workspace-assets").unwrap(),
                service: AssetImportService::with_operation_lock(Arc::new(Mutex::new(()))),
            }
        }

        fn ticket(&self, mime: &str, name: &str) -> AssetUploadTicket {
            self.service
                .begin_upload(
                    self.workspace_id.clone(),
                    &self.workspace_root,
                    WorkspaceRelativePath::parse("assets").unwrap(),
                    mime,
                    name,
                )
                .unwrap()
        }
    }

    #[test]
    fn raw_upload_validates_signature_writes_unique_name_and_confirms() {
        let fixture = Fixture::new();
        let first = fixture.ticket("image/png", "My screenshot.png");
        let first = fixture
            .service
            .upload(&first.upload_id, PNG.to_vec())
            .unwrap();
        assert_eq!(first.file_name, "My-screenshot.png");
        assert_eq!(first.asset_path.as_str(), "assets/My-screenshot.png");
        assert_eq!(
            fs::read(fixture.workspace_root.join(first.asset_path.to_path_buf())).unwrap(),
            PNG
        );
        let result = fixture
            .service
            .confirm(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &first.import_id,
            )
            .unwrap();
        assert_eq!(result.asset_path, first.asset_path);

        let second = fixture.ticket("image/png", "My screenshot.png");
        let second = fixture
            .service
            .upload(&second.upload_id, PNG.to_vec())
            .unwrap();
        assert_eq!(second.file_name, "My-screenshot-2.png");
    }

    #[test]
    fn workspace_image_read_is_bounded_signature_checked_and_root_scoped() {
        let fixture = Fixture::new();
        let assets = fixture.workspace_root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("valid.png"), PNG).unwrap();
        assert_eq!(
            read_workspace_image_bytes(
                &fixture.workspace_root,
                &WorkspaceRelativePath::parse("assets/valid.png").unwrap(),
            )
            .unwrap(),
            PNG
        );

        fs::write(assets.join("active.svg"), b"<svg><script/></svg>").unwrap();
        assert_eq!(
            read_workspace_image_bytes(
                &fixture.workspace_root,
                &WorkspaceRelativePath::parse("assets/active.svg").unwrap(),
            )
            .unwrap_err()
            .code,
            DesktopErrorCode::AssetUnsupportedType
        );

        let oversized = File::create(assets.join("large.png")).unwrap();
        oversized.set_len(MAX_ASSET_BYTES as u64 + 1).unwrap();
        assert_eq!(
            read_workspace_image_bytes(
                &fixture.workspace_root,
                &WorkspaceRelativePath::parse("assets/large.png").unwrap(),
            )
            .unwrap_err()
            .code,
            DesktopErrorCode::AssetTooLarge
        );
    }

    #[test]
    fn mime_mismatch_unsupported_svg_and_oversized_payload_are_rejected() {
        let fixture = Fixture::new();
        let mismatch = fixture.ticket("image/png", "wrong.png");
        assert_eq!(
            fixture
                .service
                .upload(&mismatch.upload_id, GIF.to_vec())
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetMimeMismatch
        );
        assert_eq!(
            fixture
                .service
                .begin_upload(
                    fixture.workspace_id.clone(),
                    &fixture.workspace_root,
                    WorkspaceRelativePath::parse("assets").unwrap(),
                    "image/svg+xml",
                    "active.svg",
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetUnsupportedType
        );
        let boundary = fixture.ticket("image/png", "boundary.png");
        let mut boundary_bytes = vec![0_u8; MAX_ASSET_BYTES];
        boundary_bytes[..8].copy_from_slice(&PNG[..8]);
        let boundary = fixture
            .service
            .upload(&boundary.upload_id, boundary_bytes)
            .unwrap();
        fixture
            .service
            .cancel(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &boundary.import_id,
            )
            .unwrap();
        let oversized = fixture.ticket("image/png", "large.png");
        assert_eq!(
            fixture
                .service
                .upload(&oversized.upload_id, vec![0; MAX_ASSET_BYTES + 1])
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetTooLarge
        );
    }

    #[test]
    fn cancellation_deletes_only_the_unchanged_import_file() {
        let fixture = Fixture::new();
        let ticket = fixture.ticket("image/gif", "cancel.gif");
        let proposal = fixture
            .service
            .upload(&ticket.upload_id, GIF.to_vec())
            .unwrap();
        let path = fixture
            .workspace_root
            .join(proposal.asset_path.to_path_buf());
        fixture
            .service
            .cancel(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.import_id,
            )
            .unwrap();
        assert!(!path.exists());

        let ticket = fixture.ticket("image/jpeg", "changed.jpg");
        let proposal = fixture
            .service
            .upload(&ticket.upload_id, JPEG.to_vec())
            .unwrap();
        let path = fixture
            .workspace_root
            .join(proposal.asset_path.to_path_buf());
        fs::write(&path, b"external replacement").unwrap();
        assert_eq!(
            fixture
                .service
                .cancel(
                    &fixture.workspace_id,
                    &fixture.workspace_root,
                    &proposal.import_id,
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetTargetChanged
        );
        assert_eq!(fs::read(path).unwrap(), b"external replacement");
    }

    #[test]
    fn wrong_workspace_cannot_consume_an_import_token() {
        let fixture = Fixture::new();
        let ticket = fixture.ticket("image/png", "authority.png");
        let proposal = fixture
            .service
            .upload(&ticket.upload_id, PNG.to_vec())
            .unwrap();
        let other_workspace = WorkspaceId::parse("workspace-other").unwrap();
        assert_eq!(
            fixture
                .service
                .confirm(
                    &other_workspace,
                    &fixture.workspace_root,
                    &proposal.import_id,
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetImportNotFound
        );
        fixture
            .service
            .confirm(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.import_id,
            )
            .unwrap();
    }

    #[test]
    fn interrupted_write_removes_the_private_temp_file_and_creates_no_asset() {
        let fixture = Fixture::new();
        let ticket = fixture.ticket("image/png", "interrupted.png");
        assert_eq!(
            fixture
                .service
                .upload_with_failure_before_commit(&ticket.upload_id, PNG.to_vec())
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetWriteFailed
        );
        let assets = fixture.workspace_root.join("assets");
        assert!(assets.is_dir());
        assert!(fs::read_dir(assets).unwrap().next().is_none());
    }

    #[test]
    fn selected_file_is_bounded_cancelable_and_source_is_never_deleted() {
        let fixture = Fixture::new();
        let source = fixture.root.path().join("chosen.webp");
        fs::write(&source, WEBP).unwrap();
        let outcome = fixture
            .service
            .import_selected_file(
                Some(source.clone()),
                fixture.workspace_id.clone(),
                &fixture.workspace_root,
                WorkspaceRelativePath::parse("media").unwrap(),
            )
            .unwrap();
        let AssetImportSelectionOutcome::Ready { proposal } = outcome else {
            panic!("selected source should create a proposal");
        };
        fixture
            .service
            .cancel(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.import_id,
            )
            .unwrap();
        assert_eq!(fs::read(source).unwrap(), WEBP);
    }

    #[test]
    fn nested_directory_creation_rejects_symlink_redirection() {
        let fixture = Fixture::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = fixture.root.path().join("outside");
            fs::create_dir_all(&outside).unwrap();
            symlink(&outside, fixture.workspace_root.join("linked")).unwrap();
            assert_eq!(
                fixture
                    .service
                    .begin_upload(
                        fixture.workspace_id.clone(),
                        &fixture.workspace_root,
                        WorkspaceRelativePath::parse("linked/images").unwrap(),
                        "image/png",
                        "image.png",
                    )
                    .unwrap_err()
                    .code,
                DesktopErrorCode::SymlinkNotAllowed
            );
        }
    }

    #[test]
    fn upload_and_import_tokens_are_single_use_bounded_and_expire() {
        let fixture = Fixture::new();
        let ticket = fixture.ticket("image/png", "single.png");
        let proposal = fixture
            .service
            .upload(&ticket.upload_id, PNG.to_vec())
            .unwrap();
        assert_eq!(
            fixture
                .service
                .upload(&ticket.upload_id, PNG.to_vec())
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetUploadNotFound
        );
        fixture
            .service
            .confirm(
                &fixture.workspace_id,
                &fixture.workspace_root,
                &proposal.import_id,
            )
            .unwrap();
        assert_eq!(
            fixture
                .service
                .confirm(
                    &fixture.workspace_id,
                    &fixture.workspace_root,
                    &proposal.import_id,
                )
                .unwrap_err()
                .code,
            DesktopErrorCode::AssetImportNotFound
        );

        for index in 0..=MAX_PENDING_ASSET_ACTIONS {
            fixture.ticket("image/png", &format!("bounded-{index}.png"));
        }
        assert_eq!(
            fixture.service.lock_pending().unwrap().uploads.len(),
            MAX_PENDING_ASSET_ACTIONS
        );
        let mut pending = fixture.service.lock_pending().unwrap();
        pending.uploads.values_mut().next().unwrap().created_at =
            Instant::now() - ASSET_ACTION_LIFETIME - Duration::from_secs(1);
        drop(pending);
        fixture.ticket("image/png", "prune.png");
        assert_eq!(
            fixture.service.lock_pending().unwrap().uploads.len(),
            MAX_PENDING_ASSET_ACTIONS
        );
    }

    #[test]
    fn concurrent_upload_consumes_the_ticket_once() {
        use std::sync::Barrier;
        use std::thread;

        let fixture = Fixture::new();
        let ticket = fixture.ticket("image/png", "concurrent.png");
        let barrier = Arc::new(Barrier::new(3));
        let handles = [(), ()].map(|()| {
            let service = fixture.service.clone();
            let upload_id = ticket.upload_id.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                service.upload(&upload_id, PNG.to_vec())
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result
                    .as_ref()
                    .is_err_and(|error| error.code == DesktopErrorCode::AssetUploadNotFound))
                .count(),
            1
        );
    }

    #[test]
    fn asset_contracts_and_image_kinds_match_typescript() {
        let workspace_id = WorkspaceId::parse("workspace-contract").unwrap();
        let asset_path = WorkspaceRelativePath::parse("assets/image.png").unwrap();
        let ticket = AssetUploadTicket {
            upload_id: "asset-upload-v1-contract".to_owned(),
            max_bytes: MAX_ASSET_BYTES as u64,
            accepted_kind: AssetImageKind::Png,
        };
        let proposal = AssetImportProposal {
            import_id: "asset-import-v1-contract".to_owned(),
            workspace_id: workspace_id.clone(),
            asset_path: asset_path.clone(),
            file_name: "image.png".to_owned(),
            image_kind: AssetImageKind::Png,
            media_type: "image/png".to_owned(),
            byte_length: 10,
        };
        let result = AssetImportResult {
            workspace_id,
            asset_path,
            file_name: "image.png".to_owned(),
            image_kind: AssetImageKind::Png,
            media_type: "image/png".to_owned(),
            byte_length: 10,
        };
        assert_interface_matches("AssetUploadTicket", &ticket);
        assert_interface_matches("AssetImportProposal", &proposal);
        assert_interface_matches("AssetImportResult", &result);
        assert_eq!(
            AssetImageKind::ALL
                .iter()
                .map(|kind| serde_json::to_value(kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("ASSET_IMAGE_KINDS")
        );
        let outcomes = [
            AssetImportSelectionOutcome::Cancelled,
            AssetImportSelectionOutcome::Ready { proposal },
        ];
        let values = outcomes
            .iter()
            .map(|outcome| serde_json::to_value(outcome).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            values
                .iter()
                .map(|value| value["status"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("ASSET_IMPORT_SELECTION_STATUSES")
        );
        assert_eq!(values[0], serde_json::json!({ "status": "cancelled" }));
        assert_eq!(values[1]["status"], "ready");
        assert!(values[1].get("proposal").is_some());
    }
}
