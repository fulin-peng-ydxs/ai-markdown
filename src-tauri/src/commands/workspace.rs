use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{
    inspect_workspace_root, native_path_identity, resolve_existing_workspace_path,
    WorkspaceDescriptor, WorkspaceId, WorkspaceRelativePath, WorkspaceRootResolution,
};
use crate::state::{
    PersistentAppState, PlainrootStateV1, RecentWorkspace, WorkspaceAvailability, WorkspaceRegistry,
};

const MAX_PENDING_SELECTIONS: usize = 32;
const PENDING_SELECTION_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSelectionKind {
    Folder,
    MarkdownFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSelectionProposal {
    pub selection_id: String,
    pub kind: WorkspaceSelectionKind,
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub selected_path: PathBuf,
    #[serde(serialize_with = "crate::fs::serialize_public_path")]
    pub canonical_root: PathBuf,
    pub display_name: String,
    pub initial_file: Option<WorkspaceRelativePath>,
    pub root_is_symlink: bool,
    pub scope_confirmation_required: bool,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceSelectionOutcome {
    Cancelled,
    AlreadyOpen {
        workspace_id: WorkspaceId,
        initial_file: Option<WorkspaceRelativePath>,
    },
    Ready {
        proposal: WorkspaceSelectionProposal,
    },
    ConfirmationRequired {
        proposal: WorkspaceSelectionProposal,
    },
}

#[derive(Debug, Clone)]
struct ResolvedSelection {
    kind: WorkspaceSelectionKind,
    source_path: PathBuf,
    resolution: WorkspaceRootResolution,
    initial_file: Option<WorkspaceRelativePath>,
    scope_confirmation_required: bool,
}

impl ResolvedSelection {
    fn requires_confirmation(&self) -> bool {
        self.scope_confirmation_required || self.resolution.requires_confirmation()
    }
}

#[derive(Debug)]
struct PendingSelection {
    sequence: u64,
    created_at: Instant,
    resolved: ResolvedSelection,
}

#[derive(Debug, Default)]
struct PendingSelectionState {
    by_id: HashMap<String, PendingSelection>,
}

#[derive(Debug)]
pub struct WorkspaceAccessService {
    registry: WorkspaceRegistry,
    pending: Mutex<PendingSelectionState>,
    next_selection_sequence: AtomicU64,
}

impl Default for WorkspaceAccessService {
    fn default() -> Self {
        Self {
            registry: WorkspaceRegistry::default(),
            pending: Mutex::new(PendingSelectionState::default()),
            next_selection_sequence: AtomicU64::new(1),
        }
    }
}

impl WorkspaceAccessService {
    pub fn workspace(&self, id: &WorkspaceId) -> Result<WorkspaceDescriptor, DesktopError> {
        self.registry.workspace(id)
    }

    fn prepare_folder(
        &self,
        selected_path: Option<PathBuf>,
    ) -> Result<WorkspaceSelectionOutcome, DesktopError> {
        let Some(selected_path) = selected_path else {
            return Ok(WorkspaceSelectionOutcome::Cancelled);
        };
        self.prepare_resolved(resolve_folder_selection(selected_path)?)
    }

    fn prepare_markdown_file(
        &self,
        selected_path: Option<PathBuf>,
    ) -> Result<WorkspaceSelectionOutcome, DesktopError> {
        let Some(selected_path) = selected_path else {
            return Ok(WorkspaceSelectionOutcome::Cancelled);
        };
        self.prepare_resolved(resolve_markdown_selection(selected_path)?)
    }

    fn prepare_resolved(
        &self,
        resolved: ResolvedSelection,
    ) -> Result<WorkspaceSelectionOutcome, DesktopError> {
        if let Some(workspace_id) = self
            .registry
            .workspace_id_for_root(resolved.resolution.canonical_root())?
        {
            return Ok(WorkspaceSelectionOutcome::AlreadyOpen {
                workspace_id,
                initial_file: resolved.initial_file,
            });
        }

        let requires_confirmation = resolved.requires_confirmation();
        let sequence = self.next_selection_sequence.fetch_add(1, Ordering::Relaxed);
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| selection_error(DesktopErrorCode::SelectionUnavailable, true))?;
        prune_pending(&mut pending, Instant::now());
        if pending.by_id.len() >= MAX_PENDING_SELECTIONS {
            if let Some(oldest_id) = pending
                .by_id
                .iter()
                .min_by_key(|(_, selection)| selection.sequence)
                .map(|(id, _)| id.clone())
            {
                pending.by_id.remove(&oldest_id);
            }
        }
        let selection_id = loop {
            let candidate = secure_selection_id()?;
            if !pending.by_id.contains_key(&candidate) {
                break candidate;
            }
        };
        let proposal = proposal_from_resolved(&selection_id, &resolved);
        pending.by_id.insert(
            selection_id,
            PendingSelection {
                sequence,
                created_at: Instant::now(),
                resolved,
            },
        );

        if requires_confirmation {
            Ok(WorkspaceSelectionOutcome::ConfirmationRequired { proposal })
        } else {
            Ok(WorkspaceSelectionOutcome::Ready { proposal })
        }
    }

    /// `confirmed` acknowledges that the trusted local UI completed its confirmation flow. It is
    /// not a filesystem authority: every call still consumes a pending capability and revalidates
    /// the canonical root, file type, extension, and link boundary before registry insertion.
    pub fn authorize(
        &self,
        selection_id: &str,
        confirmed: bool,
    ) -> Result<WorkspaceDescriptor, DesktopError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| selection_error(DesktopErrorCode::SelectionUnavailable, true))?;
        prune_pending(&mut pending, Instant::now());
        let requires_confirmation = pending
            .by_id
            .get(selection_id)
            .ok_or_else(|| selection_error(DesktopErrorCode::SelectionNotFound, true))?
            .resolved
            .requires_confirmation();
        if requires_confirmation && !confirmed {
            return Err(selection_error(
                DesktopErrorCode::SelectionConfirmationRequired,
                false,
            ));
        }
        let pending_selection = pending
            .by_id
            .remove(selection_id)
            .expect("selection was checked while holding the same lock");
        drop(pending);

        let current = resolve_selection(
            pending_selection.resolved.kind,
            pending_selection.resolved.source_path.clone(),
        )?;
        ensure_selection_unchanged(&pending_selection.resolved, &current)?;
        if self
            .registry
            .workspace_id_for_root(current.resolution.canonical_root())?
            .is_some()
        {
            return Err(selection_error(
                DesktopErrorCode::WorkspaceAlreadyRegistered,
                false,
            ));
        }

        let workspace_id = workspace_id_for_root(current.resolution.canonical_root())?;
        let root_metadata = fs::metadata(current.resolution.canonical_root()).map_err(|error| {
            DesktopError::from_io(&error, current.resolution.canonical_root(), true)
        })?;
        let writable = workspace_writable_hint(&root_metadata);
        let descriptor = WorkspaceDescriptor::from_resolution(
            workspace_id,
            current.resolution,
            writable,
            current.initial_file,
            confirmed || !requires_confirmation,
        )?;
        self.registry.register(descriptor.clone())?;
        Ok(descriptor)
    }

    pub fn cancel(&self, selection_id: &str) -> Result<bool, DesktopError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| selection_error(DesktopErrorCode::SelectionUnavailable, true))?;
        prune_pending(&mut pending, Instant::now());
        Ok(pending.by_id.remove(selection_id).is_some())
    }

    pub fn release_workspace(&self, workspace_id: &WorkspaceId) -> Result<bool, DesktopError> {
        self.registry.unregister(workspace_id)
    }

    pub fn record_workspace_opened(
        &self,
        workspace_id: &WorkspaceId,
        state: &PersistentAppState,
        opened_at: u64,
    ) -> Result<PlainrootStateV1, DesktopError> {
        let workspace = self.registry.workspace(workspace_id)?;
        state.update(|current| {
            let recent = RecentWorkspace {
                workspace_id: workspace.id().clone(),
                canonical_root: workspace.canonical_root().to_path_buf(),
                display_name: workspace.display_name().to_owned(),
                last_opened_at: opened_at,
                availability: WorkspaceAvailability::Available,
            };
            if let Some(existing) = current
                .recent_workspaces
                .iter_mut()
                .find(|entry| entry.workspace_id == recent.workspace_id)
            {
                *existing = recent;
            } else {
                current.recent_workspaces.push(recent);
            }
            current
                .recent_workspaces
                .sort_by_key(|entry| std::cmp::Reverse(entry.last_opened_at));
        })
    }

    fn prepare_recent_workspace(
        &self,
        workspace_id: &WorkspaceId,
        state: &PersistentAppState,
    ) -> Result<WorkspaceSelectionOutcome, DesktopError> {
        if let Some(error) = state.current_error() {
            return Err(error);
        }
        let snapshot = state.snapshot()?;
        let recent = snapshot
            .recent_workspaces
            .into_iter()
            .find(|entry| &entry.workspace_id == workspace_id)
            .ok_or_else(|| selection_error(DesktopErrorCode::RecentWorkspaceNotFound, false))?;
        let resolved = resolve_folder_selection(recent.canonical_root)?;
        if workspace_id_for_root(resolved.resolution.canonical_root())? != recent.workspace_id {
            return Err(selection_error(DesktopErrorCode::InvalidStateData, false));
        }
        self.prepare_resolved(resolved)
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().by_id.len()
    }
}

#[tauri::command]
pub async fn select_workspace_folder(
    window: WebviewWindow,
    access: State<'_, WorkspaceAccessService>,
) -> Result<WorkspaceSelectionOutcome, DesktopError> {
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("打开工作区文件夹")
        .blocking_pick_folder();
    access.prepare_folder(dialog_path(selected)?)
}

#[tauri::command]
pub async fn select_markdown_file(
    window: WebviewWindow,
    access: State<'_, WorkspaceAccessService>,
) -> Result<WorkspaceSelectionOutcome, DesktopError> {
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("打开 Markdown 文件")
        .add_filter("Markdown", &["md"])
        .blocking_pick_file();
    access.prepare_markdown_file(dialog_path(selected)?)
}

#[tauri::command]
pub fn authorize_workspace_selection(
    selection_id: String,
    confirmed: bool,
    access: State<'_, WorkspaceAccessService>,
) -> Result<WorkspaceDescriptor, DesktopError> {
    access.authorize(&selection_id, confirmed)
}

#[tauri::command]
pub fn cancel_workspace_selection(
    selection_id: String,
    access: State<'_, WorkspaceAccessService>,
) -> Result<bool, DesktopError> {
    access.cancel(&selection_id)
}

#[tauri::command]
pub fn validate_recent_workspace(
    workspace_id: WorkspaceId,
    access: State<'_, WorkspaceAccessService>,
    state: State<'_, PersistentAppState>,
) -> Result<WorkspaceSelectionOutcome, DesktopError> {
    access.prepare_recent_workspace(&workspace_id, &state)
}

fn dialog_path(selected: Option<FilePath>) -> Result<Option<PathBuf>, DesktopError> {
    selected
        .map(|path| {
            path.into_path()
                .map_err(|_| selection_error(DesktopErrorCode::DialogUnavailable, true))
        })
        .transpose()
}

fn resolve_selection(
    kind: WorkspaceSelectionKind,
    source_path: PathBuf,
) -> Result<ResolvedSelection, DesktopError> {
    match kind {
        WorkspaceSelectionKind::Folder => resolve_folder_selection(source_path),
        WorkspaceSelectionKind::MarkdownFile => resolve_markdown_selection(source_path),
    }
}

fn resolve_folder_selection(selected_root: PathBuf) -> Result<ResolvedSelection, DesktopError> {
    let resolution = inspect_workspace_root(&selected_root)?;
    Ok(ResolvedSelection {
        kind: WorkspaceSelectionKind::Folder,
        source_path: selected_root,
        resolution,
        initial_file: None,
        scope_confirmation_required: false,
    })
}

fn resolve_markdown_selection(selected_file: PathBuf) -> Result<ResolvedSelection, DesktopError> {
    if !selected_file.is_absolute() {
        return Err(
            selection_error(DesktopErrorCode::InvalidSelectedRoot, false)
                .with_path_hint(&selected_file),
        );
    }
    let metadata = fs::symlink_metadata(&selected_file)
        .map_err(|error| DesktopError::from_io(&error, &selected_file, true))?;
    if metadata.file_type().is_symlink() {
        return Err(selection_error(DesktopErrorCode::SymlinkNotAllowed, false)
            .with_path_hint(&selected_file));
    }
    if !metadata.is_file() {
        return Err(
            selection_error(DesktopErrorCode::NotFile, false).with_path_hint(&selected_file)
        );
    }
    let supported = selected_file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if !supported {
        return Err(
            selection_error(DesktopErrorCode::UnsupportedMarkdownFile, false)
                .with_path_hint(&selected_file),
        );
    }

    let selected_root = selected_file.parent().ok_or_else(|| {
        selection_error(DesktopErrorCode::InvalidSelectedRoot, false).with_path_hint(&selected_file)
    })?;
    let resolution = inspect_workspace_root(selected_root)?;
    let file_name = selected_file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            selection_error(DesktopErrorCode::InvalidRelativePath, false)
                .with_path_hint(&selected_file)
        })?;
    let initial_file = WorkspaceRelativePath::parse(file_name)?;
    let _ = resolve_existing_workspace_path(resolution.canonical_root(), &initial_file)?;

    Ok(ResolvedSelection {
        kind: WorkspaceSelectionKind::MarkdownFile,
        source_path: selected_file,
        resolution,
        initial_file: Some(initial_file),
        scope_confirmation_required: true,
    })
}

fn proposal_from_resolved(
    selection_id: &str,
    resolved: &ResolvedSelection,
) -> WorkspaceSelectionProposal {
    WorkspaceSelectionProposal {
        selection_id: selection_id.to_owned(),
        kind: resolved.kind,
        selected_path: resolved.resolution.selected_path().to_path_buf(),
        canonical_root: resolved.resolution.canonical_root().to_path_buf(),
        display_name: resolved.resolution.display_name().to_owned(),
        initial_file: resolved.initial_file.clone(),
        root_is_symlink: resolved.resolution.root_is_symlink(),
        scope_confirmation_required: resolved.scope_confirmation_required,
        requires_confirmation: resolved.requires_confirmation(),
    }
}

fn ensure_selection_unchanged(
    original: &ResolvedSelection,
    current: &ResolvedSelection,
) -> Result<(), DesktopError> {
    let original_identity = native_path_identity(original.resolution.canonical_root())?;
    let current_identity = native_path_identity(current.resolution.canonical_root())?;
    if original_identity != current_identity || original.initial_file != current.initial_file {
        return Err(selection_error(DesktopErrorCode::InvalidSelectedRoot, true));
    }
    // Link syntax is not part of the authorization identity: replacing a selected folder with a
    // link to the same canonical target preserves the exact scope the user selected. A different
    // target still fails the identity comparison above before the workspace is registered.
    Ok(())
}

fn workspace_id_for_root(canonical_root: &Path) -> Result<WorkspaceId, DesktopError> {
    let identity = native_path_identity(canonical_root)?;
    let digest = Sha256::digest(identity.as_bytes());
    let mut value = String::from("workspace-v1-");
    for byte in &digest[..16] {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    WorkspaceId::parse(value)
}

fn secure_selection_id() -> Result<String, DesktopError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| selection_error(DesktopErrorCode::SelectionUnavailable, true))?;
    let mut value = String::from("selection-v1-");
    for byte in random {
        write!(&mut value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(value)
}

#[cfg(not(windows))]
fn workspace_writable_hint(metadata: &fs::Metadata) -> bool {
    !metadata.permissions().readonly()
}

#[cfg(windows)]
fn workspace_writable_hint(_metadata: &fs::Metadata) -> bool {
    // Windows' read-only directory attribute is not an access-control decision. File commands
    // remain authoritative and must report the actual permission result for every mutation.
    true
}

fn prune_pending(state: &mut PendingSelectionState, now: Instant) {
    state.by_id.retain(|_, selection| {
        now.saturating_duration_since(selection.created_at) <= PENDING_SELECTION_LIFETIME
    });
}

fn selection_error(code: DesktopErrorCode, retryable: bool) -> DesktopError {
    DesktopError::new(code, true, retryable)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::error::DesktopErrorCode;
    use crate::fs::{WorkspaceId, WorkspaceRelativePath};
    use crate::state::{PersistentAppState, StateRepositoryStatus};

    use super::{
        resolve_markdown_selection, workspace_id_for_root, WorkspaceAccessService,
        WorkspaceSelectionKind, WorkspaceSelectionOutcome, WorkspaceSelectionProposal,
        MAX_PENDING_SELECTIONS, PENDING_SELECTION_LIFETIME,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plainroot-selection-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn proposal_id(outcome: &WorkspaceSelectionOutcome) -> String {
        match outcome {
            WorkspaceSelectionOutcome::Ready { proposal }
            | WorkspaceSelectionOutcome::ConfirmationRequired { proposal } => {
                proposal.selection_id.clone()
            }
            _ => panic!("outcome should contain a proposal"),
        }
    }

    #[test]
    fn cancelling_native_picker_has_no_pending_or_state_side_effect() {
        let access = WorkspaceAccessService::default();

        assert_eq!(
            access.prepare_folder(None).unwrap(),
            WorkspaceSelectionOutcome::Cancelled
        );
        assert_eq!(access.pending_count(), 0);
    }

    #[test]
    fn selection_kind_and_tagged_outcome_match_typescript_contract() {
        let rust_kinds = [
            WorkspaceSelectionKind::Folder,
            WorkspaceSelectionKind::MarkdownFile,
        ]
        .into_iter()
        .map(|kind| {
            serde_json::to_value(kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
        assert_eq!(
            rust_kinds,
            typescript_string_constant_values("WORKSPACE_SELECTION_KINDS")
        );

        let proposal = WorkspaceSelectionProposal {
            selection_id: "selection-v1-contract".to_owned(),
            kind: WorkspaceSelectionKind::MarkdownFile,
            selected_path: PathBuf::from("contract-root"),
            canonical_root: PathBuf::from("contract-root"),
            display_name: "contract-root".to_owned(),
            initial_file: Some(WorkspaceRelativePath::parse("note.md").unwrap()),
            root_is_symlink: false,
            scope_confirmation_required: true,
            requires_confirmation: true,
        };
        let workspace_id = WorkspaceId::parse("workspace-v1-contract").unwrap();
        let outcomes = [
            WorkspaceSelectionOutcome::Cancelled,
            WorkspaceSelectionOutcome::AlreadyOpen {
                workspace_id,
                initial_file: Some(WorkspaceRelativePath::parse("note.md").unwrap()),
            },
            WorkspaceSelectionOutcome::Ready {
                proposal: proposal.clone(),
            },
            WorkspaceSelectionOutcome::ConfirmationRequired { proposal },
        ];
        let serialized = outcomes
            .iter()
            .map(|outcome| serde_json::to_value(outcome).unwrap())
            .collect::<Vec<_>>();
        let rust_statuses = serialized
            .iter()
            .map(|outcome| outcome["status"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            rust_statuses,
            typescript_string_constant_values("WORKSPACE_SELECTION_STATUSES")
        );
        assert_eq!(serialized[0], serde_json::json!({ "status": "cancelled" }));
        assert_eq!(
            serialized[1],
            serde_json::json!({
                "status": "already_open",
                "workspaceId": "workspace-v1-contract",
                "initialFile": "note.md"
            })
        );
        assert_eq!(serialized[2]["status"], "ready");
        assert!(serialized[2].get("proposal").is_some());
        assert_eq!(serialized[3]["status"], "confirmation_required");
        assert!(serialized[3].get("proposal").is_some());
    }

    #[test]
    fn folder_selection_is_one_time_and_records_recent_only_after_commit() {
        let root = TestDirectory::create("folder");
        let app_data = TestDirectory::create("state");
        let state = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let access = WorkspaceAccessService::default();

        let outcome = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let WorkspaceSelectionOutcome::Ready { proposal } = &outcome else {
            panic!("ordinary folder should be ready without another confirmation");
        };
        assert_interface_matches("WorkspaceSelectionProposal", proposal);
        assert!(proposal.selection_id.starts_with("selection-v1-"));
        assert_eq!(proposal.selection_id.len(), "selection-v1-".len() + 32);
        assert!(proposal
            .selection_id
            .strip_prefix("selection-v1-")
            .unwrap()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert!(!proposal.requires_confirmation);
        assert!(state.snapshot().unwrap().recent_workspaces.is_empty());

        let workspace = access.authorize(&proposal.selection_id, false).unwrap();
        assert_eq!(
            workspace.id(),
            &workspace_id_for_root(workspace.canonical_root()).unwrap()
        );
        assert_eq!(
            access
                .authorize(&proposal.selection_id, false)
                .unwrap_err()
                .code,
            DesktopErrorCode::SelectionNotFound
        );
        assert!(state.snapshot().unwrap().recent_workspaces.is_empty());

        access
            .record_workspace_opened(workspace.id(), &state, 20)
            .unwrap();
        access
            .record_workspace_opened(workspace.id(), &state, 30)
            .unwrap();
        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.recent_workspaces.len(), 1);
        assert_eq!(snapshot.recent_workspaces[0].last_opened_at, 30);
        assert_eq!(state.status().unwrap(), StateRepositoryStatus::Ready);
    }

    #[test]
    fn selection_capability_ids_are_unique_for_separate_proposals() {
        let root = TestDirectory::create("selection-id");
        let access = WorkspaceAccessService::default();

        let first = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let second = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();

        assert_ne!(proposal_id(&first), proposal_id(&second));
    }

    #[test]
    fn markdown_selection_requires_parent_scope_confirmation_and_can_cancel() {
        let root = TestDirectory::create("markdown");
        let file = root.path().join("note.md");
        fs::write(&file, "# Note").unwrap();
        let access = WorkspaceAccessService::default();

        let outcome = access.prepare_markdown_file(Some(file)).unwrap();
        let WorkspaceSelectionOutcome::ConfirmationRequired { proposal } = &outcome else {
            panic!("single file must require parent scope confirmation");
        };
        assert!(proposal.scope_confirmation_required);
        assert_eq!(proposal.initial_file.as_ref().unwrap().as_str(), "note.md");
        assert_eq!(
            access
                .authorize(&proposal.selection_id, false)
                .unwrap_err()
                .code,
            DesktopErrorCode::SelectionConfirmationRequired
        );
        assert!(access.cancel(&proposal.selection_id).unwrap());
        assert!(!access.cancel(&proposal.selection_id).unwrap());
    }

    #[test]
    fn markdown_selection_rejects_unsupported_extension_and_directory() {
        let root = TestDirectory::create("unsupported");
        let text = root.path().join("note.txt");
        fs::write(&text, "text").unwrap();

        assert_eq!(
            resolve_markdown_selection(text).unwrap_err().code,
            DesktopErrorCode::UnsupportedMarkdownFile
        );
        assert_eq!(
            resolve_markdown_selection(root.path().to_path_buf())
                .unwrap_err()
                .code,
            DesktopErrorCode::NotFile
        );
    }

    #[cfg(unix)]
    #[test]
    fn readonly_posix_root_is_exposed_as_an_initial_writability_hint() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDirectory::create("readonly-root");
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let access = WorkspaceAccessService::default();
        let outcome = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let workspace = access.authorize(&proposal_id(&outcome), false).unwrap();

        assert!(!workspace.writable());
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_folder_and_file_cannot_bypass_confirmation_boundary() {
        use std::os::unix::fs::symlink;

        let parent = TestDirectory::create("links");
        let target = parent.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("note.md"), "# Note").unwrap();
        let root_link = parent.path().join("root-link");
        let file_link = parent.path().join("note.md");
        symlink(&target, &root_link).unwrap();
        symlink(target.join("note.md"), &file_link).unwrap();
        let access = WorkspaceAccessService::default();

        let outcome = access.prepare_folder(Some(root_link)).unwrap();
        let WorkspaceSelectionOutcome::ConfirmationRequired { proposal } = &outcome else {
            panic!("linked root should require confirmation");
        };
        assert!(proposal.root_is_symlink);
        assert!(access.authorize(&proposal.selection_id, true).is_ok());
        assert_eq!(
            access
                .prepare_markdown_file(Some(file_link))
                .unwrap_err()
                .code,
            DesktopErrorCode::SymlinkNotAllowed
        );
    }

    #[test]
    fn selecting_an_authorized_root_returns_existing_workspace() {
        let root = TestDirectory::create("existing");
        let access = WorkspaceAccessService::default();
        let first = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let selection_id = proposal_id(&first);
        let workspace = access.authorize(&selection_id, false).unwrap();

        let second = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        assert_eq!(
            second,
            WorkspaceSelectionOutcome::AlreadyOpen {
                workspace_id: workspace.id().clone(),
                initial_file: None
            }
        );
    }

    #[test]
    fn releasing_failed_open_allows_the_same_root_to_be_authorized_again() {
        let root = TestDirectory::create("release");
        let access = WorkspaceAccessService::default();
        let first = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let selection_id = proposal_id(&first);
        let workspace = access.authorize(&selection_id, false).unwrap();

        assert!(access.release_workspace(workspace.id()).unwrap());
        assert!(!access.release_workspace(workspace.id()).unwrap());
        assert!(matches!(
            access
                .prepare_folder(Some(root.path().to_path_buf()))
                .unwrap(),
            WorkspaceSelectionOutcome::Ready { .. }
        ));
    }

    #[test]
    fn pending_selections_expire_and_are_bounded() {
        let root = TestDirectory::create("pending-bound");
        let access = WorkspaceAccessService::default();
        let first = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let first_id = proposal_id(&first);
        {
            let mut pending = access.pending.lock().unwrap();
            pending.by_id.get_mut(&first_id).unwrap().created_at =
                std::time::Instant::now() - PENDING_SELECTION_LIFETIME - Duration::from_secs(1);
        }
        assert_eq!(
            access.authorize(&first_id, false).unwrap_err().code,
            DesktopErrorCode::SelectionNotFound
        );

        let mut oldest_live_id = None;
        for index in 0..=MAX_PENDING_SELECTIONS {
            let outcome = access
                .prepare_folder(Some(root.path().to_path_buf()))
                .unwrap();
            if index == 0 {
                oldest_live_id = Some(proposal_id(&outcome));
            }
        }
        assert_eq!(access.pending_count(), MAX_PENDING_SELECTIONS);
        assert_eq!(
            access
                .authorize(oldest_live_id.as_deref().unwrap(), false)
                .unwrap_err()
                .code,
            DesktopErrorCode::SelectionNotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn changed_symlink_target_invalidates_the_pending_authorization() {
        use std::os::unix::fs::symlink;

        let parent = TestDirectory::create("retarget");
        let first_target = parent.path().join("first");
        let second_target = parent.path().join("second");
        let selected = parent.path().join("selected");
        fs::create_dir(&first_target).unwrap();
        fs::create_dir(&second_target).unwrap();
        symlink(&first_target, &selected).unwrap();
        let access = WorkspaceAccessService::default();
        let outcome = access.prepare_folder(Some(selected.clone())).unwrap();
        let selection_id = proposal_id(&outcome);

        fs::remove_file(&selected).unwrap();
        symlink(&second_target, &selected).unwrap();

        assert_eq!(
            access.authorize(&selection_id, true).unwrap_err().code,
            DesktopErrorCode::InvalidSelectedRoot
        );
        assert_eq!(access.pending_count(), 0);
    }

    #[test]
    fn stable_workspace_id_depends_on_canonical_root() {
        let root = TestDirectory::create("stable-id");
        let canonical = fs::canonicalize(root.path()).unwrap();

        let first = workspace_id_for_root(&canonical).unwrap();
        let second = workspace_id_for_root(&canonical).unwrap();

        assert_eq!(first, second);
        assert!(first.as_str().starts_with("workspace-v1-"));
        assert_eq!(first.as_str().len(), "workspace-v1-".len() + 32);
    }

    #[test]
    fn recent_workspace_is_revalidated_without_accepting_a_frontend_path() {
        let root = TestDirectory::create("recent");
        let app_data = TestDirectory::create("recent-state");
        let state = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let access = WorkspaceAccessService::default();
        let first = access
            .prepare_folder(Some(root.path().to_path_buf()))
            .unwrap();
        let workspace = access.authorize(&proposal_id(&first), false).unwrap();
        access
            .record_workspace_opened(workspace.id(), &state, 10)
            .unwrap();
        access.release_workspace(workspace.id()).unwrap();

        assert!(matches!(
            access
                .prepare_recent_workspace(workspace.id(), &state)
                .unwrap(),
            WorkspaceSelectionOutcome::Ready { .. }
        ));
        fs::remove_dir_all(root.path()).unwrap();
        assert_eq!(
            access
                .prepare_recent_workspace(workspace.id(), &state)
                .unwrap_err()
                .code,
            DesktopErrorCode::PathNotFound
        );
    }
}
