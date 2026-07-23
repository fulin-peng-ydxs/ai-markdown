use std::path::PathBuf;

use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::editor::recovery::{
    RecoveryCleanupResult, RecoveryRepository, RecoverySnapshot, RecoverySnapshotMetadata,
    RecoveryUpsertResult,
};
use crate::editor::save_copy::{
    ConflictOverwriteProposal, EditorSaveService, SaveCopyFormatChoice, SaveCopyResult,
    SaveCopySelectionOutcome, SaveCopySource,
};
use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::safe_write::{SafeWriteResult, WorkspaceSafeWriteService};
use crate::fs::watch::WorkspaceWatchService;
use crate::fs::{FileRevision, WorkspaceId, WorkspaceRelativePath};

use super::workspace::WorkspaceAccessService;

#[tauri::command]
pub fn list_recovery_snapshots(
    recovery: State<'_, RecoveryRepository>,
) -> Result<Vec<RecoverySnapshotMetadata>, DesktopError> {
    // Listing exposes only workspace-relative metadata. Reading snapshot content still requires
    // a currently authorized workspace in `get_recovery_snapshot`.
    recovery.list()
}

#[tauri::command]
pub async fn get_recovery_snapshot(
    snapshot_id: String,
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    recovery: State<'_, RecoveryRepository>,
) -> Result<RecoverySnapshot, DesktopError> {
    access.workspace(&workspace_id)?;
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    let service = recovery.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.get(&snapshot_id, &workspace_id, &relative_path)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::RecoveryReadFailed, true, true))?
}

#[tauri::command]
pub async fn upsert_recovery_snapshot(
    workspace_id: WorkspaceId,
    relative_path: String,
    content: String,
    base_revision: FileRevision,
    access: State<'_, WorkspaceAccessService>,
    recovery: State<'_, RecoveryRepository>,
) -> Result<RecoveryUpsertResult, DesktopError> {
    access.workspace(&workspace_id)?;
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    let service = recovery.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.upsert(workspace_id, relative_path, content, base_revision)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::RecoveryWriteFailed, true, true))?
}

#[tauri::command]
pub async fn delete_recovery_snapshot(
    snapshot_id: String,
    workspace_id: WorkspaceId,
    access: State<'_, WorkspaceAccessService>,
    recovery: State<'_, RecoveryRepository>,
) -> Result<bool, DesktopError> {
    access.workspace(&workspace_id)?;
    let service = recovery.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.delete(&snapshot_id, &workspace_id))
        .await
        .map_err(|_| DesktopError::new(DesktopErrorCode::RecoveryWriteFailed, true, true))?
}

#[tauri::command]
pub async fn cleanup_recovery_snapshots(
    recovery: State<'_, RecoveryRepository>,
) -> Result<RecoveryCleanupResult, DesktopError> {
    let service = recovery.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.cleanup())
        .await
        .map_err(|_| DesktopError::new(DesktopErrorCode::RecoveryWriteFailed, true, true))?
}

#[tauri::command]
pub fn register_active_recovery_session(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    recovery: State<'_, RecoveryRepository>,
) -> Result<bool, DesktopError> {
    access.workspace(&workspace_id)?;
    recovery.register_active(workspace_id, WorkspaceRelativePath::parse(&relative_path)?)
}

#[tauri::command]
pub fn release_active_recovery_session(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    recovery: State<'_, RecoveryRepository>,
) -> Result<bool, DesktopError> {
    access.workspace(&workspace_id)?;
    recovery.release_active(workspace_id, WorkspaceRelativePath::parse(&relative_path)?)
}

#[tauri::command]
pub async fn prepare_conflict_overwrite(
    workspace_id: WorkspaceId,
    relative_path: String,
    content: String,
    access: State<'_, WorkspaceAccessService>,
    editor_saves: State<'_, EditorSaveService>,
) -> Result<ConflictOverwriteProposal, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    let root = workspace.canonical_root().to_path_buf();
    let service = editor_saves.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.prepare_conflict_overwrite(&workspace_id, &root, relative_path, &content)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::EditorSaveUnavailable, true, true))?
}

#[tauri::command]
pub async fn confirm_conflict_overwrite(
    workspace_id: WorkspaceId,
    confirmation_id: String,
    content: String,
    access: State<'_, WorkspaceAccessService>,
    editor_saves: State<'_, EditorSaveService>,
    safe_writes: State<'_, WorkspaceSafeWriteService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<SafeWriteResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    let service = editor_saves.inner().clone();
    let safe_writes = safe_writes.inner().clone();
    let write_workspace_id = workspace_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.confirm_conflict_overwrite(
            &write_workspace_id,
            &root,
            &confirmation_id,
            content,
            &safe_writes,
        )
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::EditorSaveUnavailable, true, true))??;
    watches.record_write(&workspace_id, &result.relative_path);
    Ok(result)
}

#[tauri::command]
pub fn cancel_conflict_overwrite(
    confirmation_id: String,
    editor_saves: State<'_, EditorSaveService>,
) -> Result<bool, DesktopError> {
    editor_saves.cancel_conflict_overwrite(&confirmation_id)
}

#[tauri::command]
pub async fn prepare_save_copy<R: Runtime>(
    window: WebviewWindow<R>,
    source: SaveCopySource,
    format_choice: Option<SaveCopyFormatChoice>,
    access: State<'_, WorkspaceAccessService>,
    editor_saves: State<'_, EditorSaveService>,
) -> Result<SaveCopySelectionOutcome, DesktopError> {
    let source_root = match &source {
        SaveCopySource::WorkspaceDocument { workspace_id, .. } => Some(
            access
                .workspace(workspace_id)?
                .canonical_root()
                .to_path_buf(),
        ),
        SaveCopySource::NewDocument { .. } => None,
    };
    let selected = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("另存 Markdown 副本")
        .set_file_name(source.suggested_name())
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    let selected = dialog_path(selected)?;
    let service = editor_saves.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.prepare_save_copy(selected, source, source_root.as_deref(), format_choice)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::EditorSaveUnavailable, true, true))?
}

#[tauri::command]
pub async fn confirm_save_copy(
    confirmation_id: String,
    content: String,
    overwrite_existing: bool,
    editor_saves: State<'_, EditorSaveService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<SaveCopyResult, DesktopError> {
    let service = editor_saves.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.confirm_save_copy(&confirmation_id, content, overwrite_existing)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::EditorSaveUnavailable, true, true))??;
    if let (Some(workspace_id), Some(relative_path)) = (&result.workspace_id, &result.relative_path)
    {
        watches.record_write(workspace_id, relative_path);
    }
    Ok(result)
}

#[tauri::command]
pub fn cancel_save_copy(
    confirmation_id: String,
    editor_saves: State<'_, EditorSaveService>,
) -> Result<bool, DesktopError> {
    editor_saves.cancel_save_copy(&confirmation_id)
}

fn dialog_path(selected: Option<FilePath>) -> Result<Option<PathBuf>, DesktopError> {
    selected
        .map(|path| {
            path.into_path()
                .map_err(|_| DesktopError::new(DesktopErrorCode::DialogUnavailable, true, true))
        })
        .transpose()
}
