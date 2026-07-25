use tauri::{Runtime, State, WebviewWindow};

use crate::commands::workspace::WorkspaceAccessService;
use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{WorkspaceId, WorkspaceRelativePath};
use crate::window::WorkspaceWindowCoordinator;
use crate::window_session::{
    resolve_window_tab_session, WindowSessionRepository, WindowTabSession,
    WindowTabSessionSaveResult, WindowTabSessionSnapshot, WorkspaceTabPathContract,
};

#[tauri::command]
pub async fn resolve_workspace_tab_path<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    relative_path: String,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
) -> Result<WorkspaceTabPathContract, DesktopError> {
    authorize_window_workspace(&window, &workspace_id, &coordinator)?;
    let workspace = access.workspace(&workspace_id)?;
    let canonical_root = workspace.canonical_root().to_path_buf();
    let relative_path = WorkspaceRelativePath::parse(&relative_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::window_session::resolve_window_tab_path(
            &workspace_id,
            &canonical_root,
            &relative_path,
        )
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::WindowSessionReadFailed, true, true))?
}

#[tauri::command]
pub async fn get_workspace_tab_session<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    window_state_ref: Option<String>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    sessions: State<'_, WindowSessionRepository>,
) -> Result<WindowTabSession, DesktopError> {
    authorize_window_workspace(&window, &workspace_id, &coordinator)?;
    let workspace = access.workspace(&workspace_id)?;
    let canonical_root = workspace.canonical_root().to_path_buf();
    let repository = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let stored = repository.stored_session(&workspace_id, window_state_ref.as_deref())?;
        Ok(resolve_window_tab_session(stored, &canonical_root))
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::WindowSessionReadFailed, true, true))?
}

#[tauri::command]
// Tauri command parameters mirror the public IPC contract plus managed services.
#[allow(clippy::too_many_arguments)]
pub async fn save_workspace_tab_session<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    window_state_ref: Option<String>,
    expected_revision: u64,
    snapshot: WindowTabSessionSnapshot,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    sessions: State<'_, WindowSessionRepository>,
) -> Result<WindowTabSessionSaveResult, DesktopError> {
    authorize_window_workspace(&window, &workspace_id, &coordinator)?;
    access.workspace(&workspace_id)?;
    let repository = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.save(
            &workspace_id,
            window_state_ref.as_deref(),
            expected_revision,
            snapshot,
        )
    })
    .await
    .map_err(|_| DesktopError::new(DesktopErrorCode::WindowSessionWriteFailed, true, true))?
}

#[tauri::command]
pub async fn remove_workspace_tab_session<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    sessions: State<'_, WindowSessionRepository>,
) -> Result<bool, DesktopError> {
    authorize_window_workspace(&window, &workspace_id, &coordinator)?;
    access.workspace(&workspace_id)?;
    let repository = sessions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || repository.remove(&workspace_id))
        .await
        .map_err(|_| DesktopError::new(DesktopErrorCode::WindowSessionWriteFailed, true, true))?
}

fn authorize_window_workspace<R: Runtime>(
    window: &WebviewWindow<R>,
    workspace_id: &WorkspaceId,
    coordinator: &WorkspaceWindowCoordinator,
) -> Result<(), DesktopError> {
    if coordinator.workspace_for_window(window.label())?.as_ref() == Some(workspace_id) {
        Ok(())
    } else {
        Err(DesktopError::new(
            DesktopErrorCode::WorkspaceNotRegistered,
            true,
            false,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::error::DesktopErrorCode;
    use crate::fs::WorkspaceId;
    use crate::window::WorkspaceWindowCoordinator;

    #[test]
    fn unbound_window_cannot_access_another_workspace_session() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            app.handle(),
            "plainroot-window-1",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let error = super::authorize_window_workspace(
            &window,
            &WorkspaceId::parse("workspace-a").unwrap(),
            &WorkspaceWindowCoordinator::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::WorkspaceNotRegistered);
    }
}
