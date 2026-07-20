use std::fs;

use tauri::State;

use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::mutate::{WorkspaceMutationResult, WorkspaceMutationService};
use crate::fs::read::{self, MarkdownReadResult};
use crate::fs::scan::{WorkspaceScanBatch, WorkspaceScanService, WorkspaceScanStart};
use crate::fs::{resolve_existing_workspace_path, WorkspaceId, WorkspaceRelativePath};

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
pub fn create_markdown_file(
    workspace_id: WorkspaceId,
    parent: Option<String>,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    mutations.create_markdown_file(workspace.canonical_root(), parent.as_deref(), &name)
}

#[tauri::command]
pub fn create_workspace_directory(
    workspace_id: WorkspaceId,
    parent: Option<String>,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    mutations.create_directory(workspace.canonical_root(), parent.as_deref(), &name)
}

#[tauri::command]
pub fn rename_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    name: String,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    mutations.rename(workspace.canonical_root(), &relative_path, &name)
}

#[tauri::command]
pub fn move_workspace_entry(
    workspace_id: WorkspaceId,
    relative_path: String,
    target_directory: Option<String>,
    access: State<'_, WorkspaceAccessService>,
    mutations: State<'_, WorkspaceMutationService>,
) -> Result<WorkspaceMutationResult, DesktopError> {
    let workspace = access.workspace(&workspace_id)?;
    mutations.move_entry(
        workspace.canonical_root(),
        &relative_path,
        target_directory.as_deref(),
    )
}
