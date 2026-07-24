use std::fs;

use tauri::State;

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::delete::{DeleteResult, PermanentDeleteProposal, WorkspaceDeleteService};
use crate::fs::mutate::{WorkspaceMoveRisk, WorkspaceMutationResult, WorkspaceMutationService};
use crate::fs::read::{self, MarkdownReadResult};
use crate::fs::safe_write::{SafeWriteResult, WorkspaceSafeWriteService};
use crate::fs::scan::{WorkspaceScanBatch, WorkspaceScanService, WorkspaceScanStart};
use crate::fs::watch::{WorkspaceWatchBatch, WorkspaceWatchService, WorkspaceWatchStart};
use crate::fs::{
    resolve_existing_workspace_path, FileRevision, WorkspaceId, WorkspaceRelativePath,
};
use crate::preferences::{default_asset_directory, PreferencesRepository};

use super::workspace::WorkspaceAccessService;

#[tauri::command]
pub fn start_workspace_scan(
    workspace_id: WorkspaceId,
    directory: Option<String>,
    access: State<'_, WorkspaceAccessService>,
    scans: State<'_, WorkspaceScanService>,
) -> Result<WorkspaceScanStart, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let relative_directory = directory
        .as_deref()
        .map(WorkspaceRelativePath::parse)
        .transpose()?;
    let directory_path = match &relative_directory {
        Some(relative) => resolve_existing_workspace_path(workspace.canonical_root(), relative)?,
        None => workspace.canonical_root().to_path_buf(),
    };
    let metadata = fs::metadata(&directory_path)
        .map_err(|error| DesktopError::from_io(&error, &directory_path, true))?;
    if !metadata.is_dir() {
        return Err(
            DesktopError::new(DesktopErrorCode::NotDirectory, true, false)
                .with_path_hint(&directory_path),
        );
    }
    scans.start(workspace_id, relative_directory, directory_path)
}

#[tauri::command]
pub fn poll_workspace_scan(
    scan_id: String,
    scans: State<'_, WorkspaceScanService>,
) -> Result<WorkspaceScanBatch, DesktopError> {
    scans.poll(&scan_id)
}

#[tauri::command]
pub fn cancel_workspace_scan(
    scan_id: String,
    scans: State<'_, WorkspaceScanService>,
) -> Result<bool, DesktopError> {
    scans.cancel(&scan_id)
}

#[tauri::command]
pub fn start_workspace_watch(
    workspace_id: WorkspaceId,
    access: State<'_, WorkspaceAccessService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceWatchStart, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    watches.start(workspace_id, workspace.canonical_root().to_path_buf())
}

#[tauri::command]
pub fn restart_workspace_watch(
    workspace_id: WorkspaceId,
    access: State<'_, WorkspaceAccessService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceWatchStart, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    watches.start(workspace_id, workspace.canonical_root().to_path_buf())
}

#[tauri::command]
pub fn poll_workspace_watch(
    watch_id: String,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceWatchBatch, DesktopError> {
    watches.poll(&watch_id)
}

#[tauri::command]
pub fn stop_workspace_watch(
    watch_id: String,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<bool, DesktopError> {
    watches.stop(&watch_id)
}

#[tauri::command]
pub async fn read_markdown_file(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
) -> Result<MarkdownReadResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    let path = resolve_existing_workspace_path(workspace.canonical_root(), &relative_path)?;
    tauri::async_runtime::spawn_blocking(move || read::read_markdown_file(&path, relative_path))
        .await
        .map_err(|_| DesktopError::new(DesktopErrorCode::IoFailure, true, true))?
}

#[tauri::command]
pub async fn safe_write_markdown_file(
    workspace_id: WorkspaceId,
    relative_path: String,
    content: String,
    expected_revision: FileRevision,
    access: State<'_, WorkspaceAccessService>,
    safe_writes: State<'_, WorkspaceSafeWriteService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<SafeWriteResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    let service = safe_writes.inner().clone();
    let write_path = relative_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.write_markdown(&root, write_path, content, expected_revision)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::SafeWriteFailed, true, true))??;
    watches.record_write(&workspace_id, &result.relative_path);
    Ok(result)
}

#[tauri::command]
pub fn create_markdown_file(
    workspace_id: WorkspaceId,
    parent: Option<String>,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let result =
        mutations.create_markdown_file(workspace.canonical_root(), parent.as_deref(), &name)?;
    watches.record_mutation(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub fn create_workspace_directory(
    workspace_id: WorkspaceId,
    parent: Option<String>,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let result =
        mutations.create_directory(workspace.canonical_root(), parent.as_deref(), &name)?;
    watches.record_mutation(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub fn rename_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let result = mutations.rename(workspace.canonical_root(), &relative_path, &name)?;
    watches.record_mutation(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub async fn inspect_workspace_move_risk(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
    preferences: State<'_, PreferencesRepository>,
) -> Result<WorkspaceMoveRisk, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    let (asset_directory, preference_unavailable) = match preferences.get(&workspace_id) {
        Ok(preference) => (preference.asset_directory, false),
        Err(_) => (default_asset_directory(), true),
    };
    let service = mutations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.inspect_move_risk(
            &root,
            &relative_path,
            &asset_directory,
            preference_unavailable,
        )
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::MutationUnavailable, true, true))?
}

#[tauri::command]
pub fn move_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    target_directory: Option<String>,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let result = mutations.move_entry(
        workspace.canonical_root(),
        &relative_path,
        target_directory.as_deref(),
    )?;
    watches.record_mutation(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub async fn trash_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    deletions: State<'_, WorkspaceDeleteService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<DeleteResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    let service = deletions.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || service.move_to_trash(&root, &relative_path))
            .await
            .map_err(|_| DesktopError::new(DesktopErrorCode::TrashUnavailable, true, true))??;
    watches.record_delete(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub fn prepare_permanent_delete(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
    deletions: State<'_, WorkspaceDeleteService>,
) -> Result<PermanentDeleteProposal, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    deletions.prepare_permanent_delete(&workspace_id, workspace.canonical_root(), &relative_path)
}

#[tauri::command]
pub async fn confirm_permanent_delete(
    workspace_id: WorkspaceId,
    confirmation_id: String,
    access: State<'_, WorkspaceAccessService>,
    deletions: State<'_, WorkspaceDeleteService>,
    watches: State<'_, WorkspaceWatchService>,
) -> Result<DeleteResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    let service = deletions.inner().clone();
    let delete_workspace_id = workspace_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        service.confirm_permanent_delete(&delete_workspace_id, &root, &confirmation_id)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::PermanentDeleteFailed, true, true))??;
    watches.record_delete(&workspace_id, &result);
    Ok(result)
}

#[tauri::command]
pub fn cancel_permanent_delete(
    confirmation_id: String,
    deletions: State<'_, WorkspaceDeleteService>,
) -> Result<bool, DesktopError> {
    deletions.cancel_permanent_delete(&confirmation_id)
}

#[tauri::command]
pub async fn reveal_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    access: State<'_, WorkspaceAccessService>,
) -> Result<(), DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    let root = workspace.canonical_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        crate::fs::delete::reveal_workspace_entry(&root, &relative_path)
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::RevealUnavailable, true, true))?
}
