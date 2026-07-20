use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{DesktopError, DesktopErrorCode};

use super::mutate::supported_kind;
use super::{
    native_path_identity, resolve_existing_workspace_path, FsEntryKind, WorkspaceId,
    WorkspaceRelativePath,
};

const MAX_PENDING_CONFIRMATIONS: usize = 32;
const CONFIRMATION_LIFETIME: Duration = Duration::from_secs(5 * 60);
const PERMANENT_DELETE_CONSEQUENCE_KEY: &str = "confirm.permanentDelete.cannotUndo";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceDeleteKind {
    Trash,
    Permanent,
}

impl WorkspaceDeleteKind {
    pub const ALL: &'static [Self] = &[Self::Trash, Self::Permanent];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub kind: WorkspaceDeleteKind,
    pub relative_path: WorkspaceRelativePath,
    pub entry_kind: FsEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteProposal {
    pub confirmation_id: String,
    pub relative_path: WorkspaceRelativePath,
    pub name: String,
    pub entry_kind: FsEntryKind,
    pub consequence_key: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EntryIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows { volume: u32, index: u64 },
}

#[derive(Debug)]
struct PendingPermanentDelete {
    created_at: Instant,
    workspace_id: WorkspaceId,
    root_identity: String,
    relative_path: WorkspaceRelativePath,
    entry_kind: FsEntryKind,
    entry_identity: EntryIdentity,
}

#[derive(Debug)]
struct DeleteServiceInner {
    pending: Mutex<HashMap<String, PendingPermanentDelete>>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceDeleteService {
    operation_lock: Arc<Mutex<()>>,
    inner: Arc<DeleteServiceInner>,
}

impl Default for WorkspaceDeleteService {
    fn default() -> Self {
        Self::with_operation_lock(Arc::new(Mutex::new(())))
    }
}

impl WorkspaceDeleteService {
    pub(crate) fn with_operation_lock(operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            operation_lock,
            inner: Arc::new(DeleteServiceInner {
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn move_to_trash(
        &self,
        canonical_root: &Path,
        relative_path: &str,
    ) -> Result<DeleteResult, DesktopError> {
        self.move_to_trash_with(canonical_root, relative_path, platform_trash)
    }

    fn move_to_trash_with(
        &self,
        canonical_root: &Path,
        relative_path: &str,
        trash_entry: impl FnOnce(&Path) -> Result<(), ()>,
    ) -> Result<DeleteResult, DesktopError> {
        let _guard = self.lock_operations()?;
        let target = inspect_delete_target(canonical_root, relative_path)?;
        trash_entry(&target.path).map_err(|()| {
            DesktopError::new(DesktopErrorCode::TrashUnavailable, true, true)
                .with_path_hint(&target.path)
        })?;
        Ok(DeleteResult {
            kind: WorkspaceDeleteKind::Trash,
            relative_path: target.relative_path,
            entry_kind: target.entry_kind,
        })
    }

    pub fn prepare_permanent_delete(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        relative_path: &str,
    ) -> Result<PermanentDeleteProposal, DesktopError> {
        let target = inspect_delete_target(canonical_root, relative_path)?;
        let root_identity = native_path_identity(canonical_root)?;
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        if pending.len() >= MAX_PENDING_CONFIRMATIONS {
            if let Some(oldest_id) = pending
                .iter()
                .min_by_key(|(_, item)| item.created_at)
                .map(|(id, _)| id.clone())
            {
                pending.remove(&oldest_id);
            }
        }
        let confirmation_id = loop {
            let candidate = secure_confirmation_id()?;
            if !pending.contains_key(&candidate) {
                break candidate;
            }
        };
        let proposal = PermanentDeleteProposal {
            confirmation_id: confirmation_id.clone(),
            relative_path: target.relative_path.clone(),
            name: target
                .path
                .file_name()
                .expect("a workspace entry always has a name")
                .to_string_lossy()
                .into_owned(),
            entry_kind: target.entry_kind,
            consequence_key: PERMANENT_DELETE_CONSEQUENCE_KEY,
        };
        pending.insert(
            confirmation_id,
            PendingPermanentDelete {
                created_at: Instant::now(),
                workspace_id: workspace_id.clone(),
                root_identity,
                relative_path: target.relative_path,
                entry_kind: target.entry_kind,
                entry_identity: target.entry_identity,
            },
        );
        Ok(proposal)
    }

    pub fn confirm_permanent_delete(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        confirmation_id: &str,
    ) -> Result<DeleteResult, DesktopError> {
        self.confirm_permanent_delete_with(
            workspace_id,
            canonical_root,
            confirmation_id,
            permanently_remove,
        )
    }

    fn confirm_permanent_delete_with(
        &self,
        workspace_id: &WorkspaceId,
        canonical_root: &Path,
        confirmation_id: &str,
        remove_entry: impl FnOnce(&Path, FsEntryKind) -> Result<(), std::io::Error>,
    ) -> Result<DeleteResult, DesktopError> {
        let _guard = self.lock_operations()?;
        let pending = {
            let mut confirmations = self.lock_pending()?;
            prune_pending(&mut confirmations, Instant::now());
            confirmations.remove(confirmation_id).ok_or_else(|| {
                DesktopError::new(
                    DesktopErrorCode::PermanentDeleteConfirmationNotFound,
                    true,
                    true,
                )
            })?
        };
        let root_identity = native_path_identity(canonical_root)?;
        if &pending.workspace_id != workspace_id || pending.root_identity != root_identity {
            return Err(permanent_target_changed(canonical_root));
        }
        let current = inspect_delete_target(canonical_root, pending.relative_path.as_str())?;
        if current.entry_kind != pending.entry_kind
            || current.entry_identity != pending.entry_identity
        {
            return Err(permanent_target_changed(&current.path));
        }
        remove_entry(&current.path, current.entry_kind).map_err(|error| {
            let mapped = DesktopError::from_io(&error, &current.path, true);
            DesktopError {
                code: DesktopErrorCode::PermanentDeleteFailed,
                message_key: DesktopErrorCode::PermanentDeleteFailed
                    .message_key()
                    .to_owned(),
                path_hint: mapped.path_hint,
                // Recursive directory removal may have deleted a prefix before the platform
                // reports failure. Never claim that the original tree is certainly intact.
                content_safe: false,
                retryable: true,
            }
        })?;
        Ok(DeleteResult {
            kind: WorkspaceDeleteKind::Permanent,
            relative_path: current.relative_path,
            entry_kind: current.entry_kind,
        })
    }

    pub fn cancel_permanent_delete(&self, confirmation_id: &str) -> Result<bool, DesktopError> {
        let mut pending = self.lock_pending()?;
        prune_pending(&mut pending, Instant::now());
        Ok(pending.remove(confirmation_id).is_some())
    }

    fn lock_operations(&self) -> Result<std::sync::MutexGuard<'_, ()>, DesktopError> {
        self.operation_lock
            .lock()
            .map_err(|_| DesktopError::new(DesktopErrorCode::MutationUnavailable, true, true))
    }

    fn lock_pending(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, PendingPermanentDelete>>, DesktopError>
    {
        self.inner
            .pending
            .lock()
            .map_err(|_| DesktopError::new(DesktopErrorCode::MutationUnavailable, true, true))
    }
}

#[derive(Debug)]
struct InspectedDeleteTarget {
    path: PathBuf,
    relative_path: WorkspaceRelativePath,
    entry_kind: FsEntryKind,
    entry_identity: EntryIdentity,
}

fn inspect_delete_target(
    canonical_root: &Path,
    relative_path: &str,
) -> Result<InspectedDeleteTarget, DesktopError> {
    let relative_path = WorkspaceRelativePath::parse(relative_path)?;
    let path = resolve_existing_workspace_path(canonical_root, &relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| DesktopError::from_io(&error, &path, true))?;
    let entry_kind = supported_kind(&path, &metadata)?;
    Ok(InspectedDeleteTarget {
        path,
        relative_path,
        entry_kind,
        entry_identity: entry_identity(&metadata)?,
    })
}

#[cfg(unix)]
fn entry_identity(metadata: &fs::Metadata) -> Result<EntryIdentity, DesktopError> {
    use std::os::unix::fs::MetadataExt;

    Ok(EntryIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn entry_identity(metadata: &fs::Metadata) -> Result<EntryIdentity, DesktopError> {
    use std::os::windows::fs::MetadataExt;

    match (metadata.volume_serial_number(), metadata.file_index()) {
        (Some(volume), Some(index)) => Ok(EntryIdentity::Windows { volume, index }),
        _ => Err(DesktopError::new(
            DesktopErrorCode::PermanentDeleteFailed,
            true,
            true,
        )),
    }
}

fn platform_trash(path: &Path) -> Result<(), ()> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};

        let mut context = trash::TrashContext::default();
        // NSFileManager enters the system Trash without requesting Finder automation access.
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(path).map_err(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path).map_err(|_| ())
    }
}

fn permanently_remove(path: &Path, kind: FsEntryKind) -> Result<(), std::io::Error> {
    match kind {
        FsEntryKind::MarkdownFile => fs::remove_file(path),
        FsEntryKind::Directory => fs::remove_dir_all(path),
    }
}

pub fn reveal_workspace_entry(
    canonical_root: &Path,
    relative_path: &str,
) -> Result<(), DesktopError> {
    reveal_workspace_entry_with(canonical_root, relative_path, |path| {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| ())
    })
}

fn reveal_workspace_entry_with(
    canonical_root: &Path,
    relative_path: &str,
    reveal: impl FnOnce(&Path) -> Result<(), ()>,
) -> Result<(), DesktopError> {
    let target = inspect_delete_target(canonical_root, relative_path)?;
    reveal(&target.path).map_err(|()| {
        DesktopError::new(DesktopErrorCode::RevealUnavailable, true, true)
            .with_path_hint(&target.path)
    })
}

fn secure_confirmation_id() -> Result<String, DesktopError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| DesktopError::new(DesktopErrorCode::MutationUnavailable, true, true))?;
    let mut value = String::from("permanent-delete-v1-");
    for byte in random {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

fn prune_pending(pending: &mut HashMap<String, PendingPermanentDelete>, now: Instant) {
    pending
        .retain(|_, item| now.saturating_duration_since(item.created_at) <= CONFIRMATION_LIFETIME);
}

fn permanent_target_changed(path: &Path) -> DesktopError {
    DesktopError::new(DesktopErrorCode::PermanentDeleteTargetChanged, true, false)
        .with_path_hint(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::error::DesktopErrorCode;
    use crate::fs::mutate::WorkspaceMutationService;
    use crate::fs::WorkspaceId;

    use super::{
        reveal_workspace_entry_with, WorkspaceDeleteKind, WorkspaceDeleteService,
        CONFIRMATION_LIFETIME, MAX_PENDING_CONFIRMATIONS,
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plainroot-delete-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn workspace_id() -> WorkspaceId {
        WorkspaceId::parse("workspace-delete-test").unwrap()
    }

    #[test]
    fn trash_success_returns_disk_committed_result() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let result = WorkspaceDeleteService::default()
            .move_to_trash_with(root.path(), "note.md", |path| {
                fs::remove_file(path).map_err(|_| ())
            })
            .unwrap();
        assert_eq!(result.kind, WorkspaceDeleteKind::Trash);
        assert!(!root.path().join("note.md").exists());
        assert_interface_matches("DeleteResult", &result);
    }

    #[test]
    fn trash_failure_never_falls_through_to_permanent_delete() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let error = WorkspaceDeleteService::default()
            .move_to_trash_with(root.path(), "note.md", |_| Err(()))
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::TrashUnavailable);
        assert_eq!(
            fs::read_to_string(root.path().join("note.md")).unwrap(),
            "safe"
        );
    }

    #[test]
    fn permanent_delete_requires_live_one_time_confirmation() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let proposal = service
            .prepare_permanent_delete(&workspace_id, root.path(), "note.md")
            .unwrap();
        assert_interface_matches("PermanentDeleteProposal", &proposal);
        assert!(proposal.confirmation_id.starts_with("permanent-delete-v1-"));
        let result = service
            .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id)
            .unwrap();
        assert_eq!(result.kind, WorkspaceDeleteKind::Permanent);
        assert!(!root.path().join("note.md").exists());
        assert_eq!(
            service
                .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id,)
                .unwrap_err()
                .code,
            DesktopErrorCode::PermanentDeleteConfirmationNotFound
        );
    }

    #[test]
    fn cancel_consumes_confirmation_without_changing_disk() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("docs/child")).unwrap();
        fs::write(root.path().join("docs/child/note.md"), "safe").unwrap();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let proposal = service
            .prepare_permanent_delete(&workspace_id, root.path(), "docs")
            .unwrap();
        assert!(service
            .cancel_permanent_delete(&proposal.confirmation_id)
            .unwrap());
        assert!(root.path().join("docs/child/note.md").is_file());
        assert_eq!(
            service
                .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id,)
                .unwrap_err()
                .code,
            DesktopErrorCode::PermanentDeleteConfirmationNotFound
        );
    }

    #[test]
    fn permanent_delete_refuses_replaced_target() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "original").unwrap();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let proposal = service
            .prepare_permanent_delete(&workspace_id, root.path(), "note.md")
            .unwrap();
        fs::rename(root.path().join("note.md"), root.path().join("original.md")).unwrap();
        fs::write(root.path().join("note.md"), "replacement").unwrap();
        let error = service
            .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id)
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::PermanentDeleteTargetChanged);
        assert_eq!(
            fs::read_to_string(root.path().join("note.md")).unwrap(),
            "replacement"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("original.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn failed_permanent_delete_consumes_confirmation_and_preserves_target() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let proposal = service
            .prepare_permanent_delete(&workspace_id, root.path(), "note.md")
            .unwrap();
        let error = service
            .confirm_permanent_delete_with(
                &workspace_id,
                root.path(),
                &proposal.confirmation_id,
                |_, _| Err(std::io::Error::other("injected delete failure")),
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::PermanentDeleteFailed);
        assert!(!error.content_safe);
        assert!(root.path().join("note.md").is_file());
        assert_eq!(
            service
                .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id,)
                .unwrap_err()
                .code,
            DesktopErrorCode::PermanentDeleteConfirmationNotFound
        );
    }

    #[test]
    fn reveal_validates_target_and_maps_platform_failure() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let mut revealed = None;
        reveal_workspace_entry_with(root.path(), "note.md", |path| {
            revealed = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(revealed, Some(root.path().join("note.md")));
        assert_eq!(
            reveal_workspace_entry_with(root.path(), "note.md", |_| Err(()))
                .unwrap_err()
                .code,
            DesktopErrorCode::RevealUnavailable
        );
    }

    #[test]
    fn delete_contract_values_match_typescript() {
        let values = WorkspaceDeleteKind::ALL
            .iter()
            .map(|kind| {
                serde_json::to_value(kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            values,
            typescript_string_constant_values("WORKSPACE_DELETE_KINDS")
        );
    }

    #[test]
    fn permanent_delete_removes_a_non_empty_directory_only_after_confirmation() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("docs/nested")).unwrap();
        fs::write(root.path().join("docs/nested/note.md"), "safe").unwrap();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let proposal = service
            .prepare_permanent_delete(&workspace_id, root.path(), "docs")
            .unwrap();
        assert_eq!(
            proposal.consequence_key,
            "confirm.permanentDelete.cannotUndo"
        );
        let result = service
            .confirm_permanent_delete(&workspace_id, root.path(), &proposal.confirmation_id)
            .unwrap();
        assert_eq!(result.entry_kind, crate::fs::FsEntryKind::Directory);
        assert!(!root.path().join("docs").exists());
    }

    #[test]
    fn delete_rejects_traversal_and_internal_symlink_targets() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let service = WorkspaceDeleteService::default();
        assert_eq!(
            service
                .move_to_trash_with(root.path(), "../note.md", |_| Ok(()))
                .unwrap_err()
                .code,
            DesktopErrorCode::InvalidRelativePath
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("note.md"), root.path().join("link.md"))
                .unwrap();
            assert_eq!(
                service
                    .prepare_permanent_delete(&workspace_id(), root.path(), "link.md")
                    .unwrap_err()
                    .code,
                DesktopErrorCode::SymlinkNotAllowed
            );
        }
        assert_eq!(
            fs::read_to_string(root.path().join("note.md")).unwrap(),
            "safe"
        );
    }

    #[test]
    fn permanent_delete_confirmations_expire_and_remain_bounded() {
        let root = Fixture::new();
        let service = WorkspaceDeleteService::default();
        let workspace_id = workspace_id();
        let mut proposal_ids = Vec::new();
        for index in 0..=MAX_PENDING_CONFIRMATIONS {
            let name = format!("note-{index}.md");
            fs::write(root.path().join(&name), "safe").unwrap();
            proposal_ids.push(
                service
                    .prepare_permanent_delete(&workspace_id, root.path(), &name)
                    .unwrap()
                    .confirmation_id,
            );
        }
        assert_eq!(
            service.inner.pending.lock().unwrap().len(),
            MAX_PENDING_CONFIRMATIONS
        );
        assert!(!service.cancel_permanent_delete(&proposal_ids[0]).unwrap());

        let expiring_id = proposal_ids.last().unwrap();
        service
            .inner
            .pending
            .lock()
            .unwrap()
            .get_mut(expiring_id)
            .unwrap()
            .created_at = Instant::now() - CONFIRMATION_LIFETIME - Duration::from_secs(1);
        assert_eq!(
            service
                .confirm_permanent_delete(&workspace_id, root.path(), expiring_id)
                .unwrap_err()
                .code,
            DesktopErrorCode::PermanentDeleteConfirmationNotFound
        );
    }

    #[test]
    fn delete_and_other_workspace_mutations_share_one_serial_gate() {
        let root = Fixture::new();
        fs::write(root.path().join("note.md"), "safe").unwrap();
        let mutations = Arc::new(WorkspaceMutationService::default());
        let deletions = WorkspaceDeleteService::with_operation_lock(mutations.operation_lock());
        let (delete_started_tx, delete_started_rx) = mpsc::channel();
        let (release_delete_tx, release_delete_rx) = mpsc::channel();
        let delete_root = root.path().to_path_buf();
        let delete_thread = thread::spawn(move || {
            deletions
                .move_to_trash_with(&delete_root, "note.md", |path| {
                    delete_started_tx.send(()).unwrap();
                    release_delete_rx.recv().unwrap();
                    fs::remove_file(path).map_err(|_| ())
                })
                .unwrap()
        });
        delete_started_rx.recv().unwrap();

        let (mutation_done_tx, mutation_done_rx) = mpsc::channel();
        let mutation_root = root.path().to_path_buf();
        let mutation_service = Arc::clone(&mutations);
        let mutation_thread = thread::spawn(move || {
            let result = mutation_service.create_markdown_file(&mutation_root, None, "later");
            mutation_done_tx.send(result).unwrap();
        });
        assert!(mutation_done_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());

        release_delete_tx.send(()).unwrap();
        delete_thread.join().unwrap();
        assert!(mutation_done_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_ok());
        mutation_thread.join().unwrap();
        assert!(root.path().join("later.md").is_file());
    }
}
