use tauri::State;

use crate::editor::recovery::{
    RecoveryCleanupResult, RecoveryRepository, RecoverySnapshot, RecoverySnapshotMetadata,
    RecoveryUpsertResult,
};
use crate::error::{DesktopError, DesktopErrorCode};
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
    recovery: State<'_, RecoveryRepository>,
) -> Result<bool, DesktopError> {
    let service = recovery.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.delete(&snapshot_id))
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
