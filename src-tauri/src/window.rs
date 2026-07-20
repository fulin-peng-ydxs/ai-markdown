use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::workspace::WorkspaceAccessService;
use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{WorkspaceDescriptor, WorkspaceId};
use crate::state::{
    PersistentAppState, PlainrootStateV1, RecentWorkspace, WorkspaceAvailability,
    WorkspaceSessionRoot, MAX_RECENT_WORKSPACES,
};

pub const APP_NAME: &str = "Plainroot";
pub const DEFAULT_WINDOW_WIDTH: f64 = 1100.0;
pub const DEFAULT_WINDOW_HEIGHT: f64 = 720.0;
pub const MIN_WINDOW_WIDTH: f64 = 720.0;
pub const MIN_WINDOW_HEIGHT: f64 = 520.0;
pub const WINDOW_LABEL_PREFIX: &str = "plainroot-window-";
pub const INITIAL_WINDOW_LABEL: &str = "plainroot-window-1";

const MAX_SECOND_INSTANCE_REQUESTS: usize = 16;
const MAX_SECOND_INSTANCE_ARGUMENTS: usize = 16;
const MAX_SECOND_INSTANCE_VALUE_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceOpenDisposition {
    CurrentWindow,
    NewWindow,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceOpenOutcome {
    DecisionRequired {
        workspace: WorkspaceDescriptor,
        current_workspace_id: WorkspaceId,
        current_workspace_name: String,
    },
    OpenedCurrent {
        workspace: WorkspaceDescriptor,
        window_label: String,
    },
    OpenedNew {
        workspace: WorkspaceDescriptor,
        window_label: String,
    },
    FocusedExisting {
        workspace_id: WorkspaceId,
        window_label: String,
    },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionResult {
    pub window_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondInstanceOpenRequest {
    pub request_id: u64,
    pub arguments: Vec<String>,
    pub working_directory: String,
}

#[derive(Debug, Default)]
struct CoordinatorState {
    workspace_windows: HashMap<WorkspaceId, String>,
    window_workspaces: HashMap<String, WorkspaceId>,
    restorable_labels: HashMap<WorkspaceId, String>,
    reserved_labels: HashSet<String>,
    pending_second_instance_requests: VecDeque<SecondInstanceOpenRequest>,
    next_request_id: u64,
}

#[derive(Debug, Default)]
pub struct WorkspaceWindowCoordinator {
    state: Mutex<CoordinatorState>,
}

struct WorkspaceOpenContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    source_window_label: &'a str,
    access: &'a WorkspaceAccessService,
    persistent_state: &'a PersistentAppState,
    opened_at: u64,
}

impl WorkspaceWindowCoordinator {
    pub fn from_sessions(sessions: &[WorkspaceSessionRoot]) -> Self {
        let mut state = CoordinatorState::default();
        for session in sessions {
            state.reserved_labels.insert(session.window_label.clone());
            state
                .restorable_labels
                .insert(session.workspace_id.clone(), session.window_label.clone());
        }
        Self {
            state: Mutex::new(state),
        }
    }

    pub fn create_launcher<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<WindowActionResult, DesktopError> {
        let label = {
            let state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            next_window_label(app, &state.reserved_labels)
        };
        let window = create_window_with_label(app, &label, &launcher_title())?;
        Ok(WindowActionResult {
            window_label: window.label().to_owned(),
        })
    }

    fn coordinate_open<R: Runtime>(
        &self,
        context: WorkspaceOpenContext<'_, R>,
        workspace_id: &WorkspaceId,
        disposition: Option<WorkspaceOpenDisposition>,
    ) -> Result<WorkspaceOpenOutcome, DesktopError> {
        let WorkspaceOpenContext {
            app,
            source_window_label,
            access,
            persistent_state,
            opened_at,
        } = context;
        let workspace = access.workspace(workspace_id)?;
        let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;

        if let Some(existing_label) = state.workspace_windows.get(workspace_id).cloned() {
            if let Err(error) = focus_window(app, &existing_label) {
                if error.code == DesktopErrorCode::WindowNotFound {
                    state.workspace_windows.remove(workspace_id);
                    state.window_workspaces.remove(&existing_label);
                    state.reserved_labels.remove(&existing_label);
                    state.restorable_labels.remove(workspace_id);
                    let _ = persistent_state.update(|current| {
                        current
                            .workspace_sessions
                            .retain(|session| session.workspace_id != *workspace_id);
                    });
                    let _ = access.release_workspace(workspace_id);
                }
                return Err(error);
            }
            return Ok(WorkspaceOpenOutcome::FocusedExisting {
                workspace_id: workspace_id.clone(),
                window_label: existing_label,
            });
        }

        let current_workspace_id = state.window_workspaces.get(source_window_label).cloned();
        let disposition = match (disposition, current_workspace_id.as_ref()) {
            (Some(disposition), _) => disposition,
            (None, Some(current_workspace_id)) if current_workspace_id != workspace_id => {
                let current_workspace = access.workspace(current_workspace_id)?;
                return Ok(WorkspaceOpenOutcome::DecisionRequired {
                    workspace,
                    current_workspace_id: current_workspace_id.clone(),
                    current_workspace_name: current_workspace.display_name().to_owned(),
                });
            }
            (None, _) => WorkspaceOpenDisposition::CurrentWindow,
        };

        match disposition {
            WorkspaceOpenDisposition::Cancel => {
                access.release_workspace(workspace_id)?;
                Ok(WorkspaceOpenOutcome::Cancelled)
            }
            WorkspaceOpenDisposition::CurrentWindow => {
                if let Err(error) = focus_window(app, source_window_label) {
                    let _ = access.release_workspace(workspace_id);
                    return Err(error);
                }
                if let Err(error) = persist_workspace_binding(
                    persistent_state,
                    &workspace,
                    source_window_label,
                    opened_at,
                ) {
                    let _ = access.release_workspace(workspace_id);
                    return Err(error);
                }

                if let Some(previous_workspace_id) = current_workspace_id {
                    state.workspace_windows.remove(&previous_workspace_id);
                    if previous_workspace_id != *workspace_id {
                        access.release_workspace(&previous_workspace_id)?;
                    }
                }
                state
                    .window_workspaces
                    .insert(source_window_label.to_owned(), workspace_id.clone());
                state
                    .workspace_windows
                    .insert(workspace_id.clone(), source_window_label.to_owned());
                state.restorable_labels.remove(workspace_id);
                state.reserved_labels.insert(source_window_label.to_owned());

                Ok(WorkspaceOpenOutcome::OpenedCurrent {
                    workspace,
                    window_label: source_window_label.to_owned(),
                })
            }
            WorkspaceOpenDisposition::NewWindow => {
                let label = preferred_workspace_label(app, &state, workspace_id);
                let window = match create_window_with_label(
                    app,
                    &label,
                    &document_title(workspace.display_name(), None),
                ) {
                    Ok(window) => window,
                    Err(error) => {
                        let _ = access.release_workspace(workspace_id);
                        return Err(error);
                    }
                };

                if let Err(error) = persist_workspace_binding(
                    persistent_state,
                    &workspace,
                    window.label(),
                    opened_at,
                ) {
                    // This window has never been committed to user-visible state. Destroying it
                    // avoids leaving an orphan shell if persistence rejects the new session.
                    let _ = window
                        .destroy()
                        .map_err(|_| window_error(DesktopErrorCode::WindowCloseFailed));
                    let _ = access.release_workspace(workspace_id);
                    return Err(error);
                }

                state
                    .window_workspaces
                    .insert(window.label().to_owned(), workspace_id.clone());
                state
                    .workspace_windows
                    .insert(workspace_id.clone(), window.label().to_owned());
                state.restorable_labels.remove(workspace_id);
                state.reserved_labels.insert(window.label().to_owned());

                Ok(WorkspaceOpenOutcome::OpenedNew {
                    workspace,
                    window_label: window.label().to_owned(),
                })
            }
        }
    }

    pub fn close_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        label: &str,
        access: &WorkspaceAccessService,
        persistent_state: &PersistentAppState,
    ) -> Result<WindowActionResult, DesktopError> {
        let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
        let workspace_id = state.window_workspaces.get(label).cloned();
        let removed_session = workspace_id.as_ref().and_then(|workspace_id| {
            persistent_state.snapshot().ok().and_then(|snapshot| {
                snapshot
                    .workspace_sessions
                    .into_iter()
                    .find(|session| &session.workspace_id == workspace_id)
            })
        });

        if workspace_id.is_some() {
            persistent_state.update(|current| {
                current
                    .workspace_sessions
                    .retain(|session| session.window_label != label);
            })?;
        }

        if let Err(error) = close_window(app, label) {
            if let Some(session) = removed_session {
                let _ = persistent_state.update(|current| {
                    current.workspace_sessions.retain(|candidate| {
                        candidate.workspace_id != session.workspace_id
                            && candidate.window_label != session.window_label
                    });
                    current.workspace_sessions.push(session);
                });
            }
            return Err(error);
        }

        if let Some(workspace_id) = workspace_id {
            state.window_workspaces.remove(label);
            state.workspace_windows.remove(&workspace_id);
            state.reserved_labels.remove(label);
            state.restorable_labels.remove(&workspace_id);
            access.release_workspace(&workspace_id)?;
        }

        Ok(WindowActionResult {
            window_label: label.to_owned(),
        })
    }

    pub fn enqueue_second_instance_request(
        &self,
        arguments: Vec<String>,
        working_directory: String,
    ) -> Result<(), DesktopError> {
        let arguments = arguments
            .into_iter()
            .skip(1)
            .take(MAX_SECOND_INSTANCE_ARGUMENTS)
            .map(|argument| truncate_utf8(argument, MAX_SECOND_INSTANCE_VALUE_BYTES))
            .collect::<Vec<_>>();
        let working_directory = truncate_utf8(working_directory, MAX_SECOND_INSTANCE_VALUE_BYTES);
        let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
        state.next_request_id = state.next_request_id.saturating_add(1);
        let request_id = state.next_request_id;
        if state.pending_second_instance_requests.len() >= MAX_SECOND_INSTANCE_REQUESTS {
            state.pending_second_instance_requests.pop_front();
        }
        state
            .pending_second_instance_requests
            .push_back(SecondInstanceOpenRequest {
                request_id,
                arguments,
                working_directory,
            });
        Ok(())
    }

    pub fn take_second_instance_requests(
        &self,
    ) -> Result<Vec<SecondInstanceOpenRequest>, DesktopError> {
        let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
        Ok(state.pending_second_instance_requests.drain(..).collect())
    }

    #[cfg(test)]
    fn active_window_for(&self, workspace_id: &WorkspaceId) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.workspace_windows.get(workspace_id).cloned())
    }
}

pub fn launcher_title() -> String {
    APP_NAME.to_owned()
}

pub fn document_title(workspace_name: &str, file_name: Option<&str>) -> String {
    let workspace_name = workspace_name.trim();
    let file_name = file_name.map(str::trim).filter(|name| !name.is_empty());

    match (workspace_name.is_empty(), file_name) {
        (false, Some(file_name)) => format!("{workspace_name} — {file_name} — {APP_NAME}"),
        (false, None) => format!("{workspace_name} — {APP_NAME}"),
        (true, _) => launcher_title(),
    }
}

fn create_window_with_label<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
) -> Result<WebviewWindow<R>, DesktopError> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
        .decorations(true)
        .focused(true)
        .center()
        .prevent_overflow()
        .build()
        .map_err(|_| window_error(DesktopErrorCode::WindowCreateFailed))
}

pub fn focus_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;

    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|_| window_error(DesktopErrorCode::WindowFocusFailed))
}

pub fn focus_any_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), DesktopError> {
    let windows = app.webview_windows();
    let label = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_owned())
        .or_else(|| windows.keys().min().cloned())
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;
    focus_window(app, &label)
}

pub fn close_window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;

    window
        .close()
        .map_err(|_| window_error(DesktopErrorCode::WindowCloseFailed))
}

pub fn migrate_legacy_window_labels(
    state: &PersistentAppState,
) -> Result<PlainrootStateV1, DesktopError> {
    let snapshot = state.snapshot()?;
    if snapshot
        .workspace_sessions
        .iter()
        .all(|session| is_plainroot_window_label(&session.window_label))
    {
        return Ok(snapshot);
    }

    state.update(|current| {
        let mut used = current
            .workspace_sessions
            .iter()
            .filter(|session| is_plainroot_window_label(&session.window_label))
            .map(|session| session.window_label.clone())
            .collect::<HashSet<_>>();
        let mut next = 1_u64;
        for session in &mut current.workspace_sessions {
            if is_plainroot_window_label(&session.window_label) {
                continue;
            }
            while used.contains(&format!("{WINDOW_LABEL_PREFIX}{next}")) {
                next += 1;
            }
            session.window_label = format!("{WINDOW_LABEL_PREFIX}{next}");
            used.insert(session.window_label.clone());
            next += 1;
        }
    })
}

#[tauri::command]
pub fn coordinate_workspace_open<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    disposition: Option<WorkspaceOpenDisposition>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    persistent_state: State<'_, PersistentAppState>,
) -> Result<WorkspaceOpenOutcome, DesktopError> {
    coordinator.coordinate_open(
        WorkspaceOpenContext {
            app: window.app_handle(),
            source_window_label: window.label(),
            access: &access,
            persistent_state: &persistent_state,
            opened_at: unix_timestamp_millis(),
        },
        &workspace_id,
        disposition,
    )
}

#[tauri::command]
pub fn create_plainroot_window<R: Runtime>(
    app: AppHandle<R>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
) -> Result<WindowActionResult, DesktopError> {
    coordinator.create_launcher(&app)
}

#[tauri::command]
pub fn close_plainroot_window<R: Runtime>(
    window: WebviewWindow<R>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    persistent_state: State<'_, PersistentAppState>,
) -> Result<WindowActionResult, DesktopError> {
    coordinator.close_window(
        window.app_handle(),
        window.label(),
        &access,
        &persistent_state,
    )
}

#[tauri::command]
pub fn take_second_instance_open_requests(
    coordinator: State<'_, WorkspaceWindowCoordinator>,
) -> Result<Vec<SecondInstanceOpenRequest>, DesktopError> {
    coordinator.take_second_instance_requests()
}

fn persist_workspace_binding(
    state: &PersistentAppState,
    workspace: &WorkspaceDescriptor,
    window_label: &str,
    opened_at: u64,
) -> Result<PlainrootStateV1, DesktopError> {
    state.update(|current| {
        let recent = RecentWorkspace {
            workspace_id: workspace.id().clone(),
            canonical_root: workspace.canonical_root().to_path_buf(),
            display_name: workspace.display_name().to_owned(),
            last_opened_at: opened_at,
            availability: WorkspaceAvailability::Available,
        };
        current
            .recent_workspaces
            .retain(|entry| entry.workspace_id != recent.workspace_id);
        current.recent_workspaces.push(recent);
        current
            .recent_workspaces
            .sort_by_key(|entry| std::cmp::Reverse(entry.last_opened_at));
        current.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);

        current.workspace_sessions.retain(|session| {
            session.workspace_id != *workspace.id() && session.window_label != window_label
        });
        current.workspace_sessions.push(WorkspaceSessionRoot {
            workspace_id: workspace.id().clone(),
            window_label: window_label.to_owned(),
            window_state_ref: None,
            last_active_at: opened_at,
        });
        current
            .workspace_sessions
            .sort_by_key(|session| std::cmp::Reverse(session.last_active_at));
    })
}

fn preferred_workspace_label<R: Runtime>(
    app: &AppHandle<R>,
    state: &CoordinatorState,
    workspace_id: &WorkspaceId,
) -> String {
    if let Some(label) = state.restorable_labels.get(workspace_id) {
        if app.get_webview_window(label).is_none() {
            return label.clone();
        }
    }
    next_window_label(app, &state.reserved_labels)
}

fn next_window_label<R: Runtime>(app: &AppHandle<R>, reserved: &HashSet<String>) -> String {
    (1_u64..)
        .map(|index| format!("{WINDOW_LABEL_PREFIX}{index}"))
        .find(|label| app.get_webview_window(label).is_none() && !reserved.contains(label))
        .expect("Plainroot window label space should not be exhausted")
}

fn is_plainroot_window_label(label: &str) -> bool {
    label
        .strip_prefix(WINDOW_LABEL_PREFIX)
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn coordinator_unavailable() -> DesktopError {
    DesktopError::new(DesktopErrorCode::RegistryUnavailable, true, true)
}

fn window_error(code: DesktopErrorCode) -> DesktopError {
    DesktopError::new(code, true, true)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::test::mock_app;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    use super::{
        close_window, document_title, focus_window, launcher_title, migrate_legacy_window_labels,
        SecondInstanceOpenRequest, WorkspaceOpenContext, WorkspaceOpenDisposition,
        WorkspaceOpenOutcome, WorkspaceWindowCoordinator, INITIAL_WINDOW_LABEL,
    };
    use crate::commands::workspace::WorkspaceAccessService;
    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::error::DesktopErrorCode;
    use crate::fs::WorkspaceId;
    use crate::state::{PersistentAppState, WorkspaceSessionRoot};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plainroot-window-{label}-{}-{nonce}",
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

    fn authorize_root(
        access: &WorkspaceAccessService,
        root: &Path,
    ) -> crate::fs::WorkspaceDescriptor {
        let outcome = access
            .prepare_folder_for_test(Some(root.to_path_buf()))
            .unwrap();
        let selection_id = match outcome {
            crate::commands::workspace::WorkspaceSelectionOutcome::Ready { proposal } => {
                proposal.selection_id
            }
            other => panic!("unexpected selection outcome: {other:?}"),
        };
        access.authorize(&selection_id, false).unwrap()
    }

    fn create_initial_window(app: &tauri::AppHandle<tauri::test::MockRuntime>) {
        WebviewWindowBuilder::new(
            app,
            INITIAL_WINDOW_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
    }

    fn open_context<'a>(
        app: &'a tauri::AppHandle<tauri::test::MockRuntime>,
        source_window_label: &'a str,
        access: &'a WorkspaceAccessService,
        persistent_state: &'a PersistentAppState,
        opened_at: u64,
    ) -> WorkspaceOpenContext<'a, tauri::test::MockRuntime> {
        WorkspaceOpenContext {
            app,
            source_window_label,
            access,
            persistent_state,
            opened_at,
        }
    }

    #[test]
    fn titles_follow_launcher_and_workspace_contract() {
        assert_eq!(launcher_title(), "Plainroot");
        assert_eq!(document_title("notes", None), "notes — Plainroot");
        assert_eq!(
            document_title("notes", Some("roadmap.md")),
            "notes — roadmap.md — Plainroot"
        );
        assert_eq!(document_title("  ", Some("ignored.md")), "Plainroot");
    }

    #[test]
    fn launcher_windows_receive_one_unified_label_family() {
        let app = mock_app();
        let coordinator = WorkspaceWindowCoordinator::default();

        let first = coordinator
            .create_launcher(app.handle())
            .expect("first launcher should be created");
        let second = coordinator
            .create_launcher(app.handle())
            .expect("second launcher should be created");

        assert_eq!(first.window_label, "plainroot-window-1");
        assert_eq!(second.window_label, "plainroot-window-2");
        focus_window(app.handle(), &first.window_label).expect("launcher should be focusable");
        close_window(app.handle(), &first.window_label).expect("launcher should be closable");
    }

    #[test]
    fn missing_window_returns_stable_error_instead_of_claiming_success() {
        let app = mock_app();

        let error = focus_window(app.handle(), "missing").expect_err("window should be missing");

        assert_eq!(error.code, DesktopErrorCode::WindowNotFound);
        assert!(error.content_safe);
        assert!(error.retryable);
    }

    #[test]
    fn duplicate_native_label_returns_window_create_failed() {
        let app = mock_app();
        create_initial_window(app.handle());

        let error =
            super::create_window_with_label(app.handle(), INITIAL_WINDOW_LABEL, "Duplicate")
                .expect_err("duplicate label must not replace the existing window");

        assert_eq!(error.code, DesktopErrorCode::WindowCreateFailed);
        assert!(app.get_webview_window(INITIAL_WINDOW_LABEL).is_some());
    }

    #[test]
    fn first_workspace_binds_current_window_and_same_workspace_focuses_it() {
        let root = TestDirectory::create("current");
        let app_data = TestDirectory::create("state-current");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();

        let opened = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                workspace.id(),
                None,
            )
            .unwrap();
        assert!(matches!(opened, WorkspaceOpenOutcome::OpenedCurrent { .. }));

        let focused = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                workspace.id(),
                None,
            )
            .unwrap();
        assert!(matches!(
            focused,
            WorkspaceOpenOutcome::FocusedExisting { .. }
        ));
        assert_eq!(
            coordinator.active_window_for(workspace.id()).as_deref(),
            Some(INITIAL_WINDOW_LABEL)
        );
        let snapshot = persistent.snapshot().unwrap();
        assert_eq!(snapshot.workspace_sessions.len(), 1);
        assert_eq!(snapshot.recent_workspaces.len(), 1);
    }

    #[test]
    fn occupied_window_requires_decision_and_cancel_keeps_original_binding() {
        let first_root = TestDirectory::create("decision-first");
        let second_root = TestDirectory::create("decision-second");
        let app_data = TestDirectory::create("state-decision");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();

        let decision = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                second.id(),
                None,
            )
            .unwrap();
        assert!(matches!(
            decision,
            WorkspaceOpenOutcome::DecisionRequired { .. }
        ));
        let cancelled = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 30),
                second.id(),
                Some(WorkspaceOpenDisposition::Cancel),
            )
            .unwrap();
        assert_eq!(cancelled, WorkspaceOpenOutcome::Cancelled);
        assert_eq!(
            coordinator.active_window_for(first.id()).as_deref(),
            Some(INITIAL_WINDOW_LABEL)
        );
        assert_eq!(
            access.workspace(second.id()).unwrap_err().code,
            DesktopErrorCode::WorkspaceNotRegistered
        );
    }

    #[test]
    fn current_window_replacement_commits_one_session_and_releases_old_authority() {
        let first_root = TestDirectory::create("replace-first");
        let second_root = TestDirectory::create("replace-second");
        let app_data = TestDirectory::create("state-replace");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();

        let opened = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                second.id(),
                Some(WorkspaceOpenDisposition::CurrentWindow),
            )
            .unwrap();

        assert!(matches!(opened, WorkspaceOpenOutcome::OpenedCurrent { .. }));
        assert_eq!(coordinator.active_window_for(first.id()), None);
        assert_eq!(
            coordinator.active_window_for(second.id()).as_deref(),
            Some(INITIAL_WINDOW_LABEL)
        );
        assert_eq!(
            access.workspace(first.id()).unwrap_err().code,
            DesktopErrorCode::WorkspaceNotRegistered
        );
        let snapshot = persistent.snapshot().unwrap();
        assert_eq!(snapshot.workspace_sessions.len(), 1);
        assert_eq!(snapshot.workspace_sessions[0].workspace_id, *second.id());
        assert_eq!(snapshot.recent_workspaces.len(), 2);
    }

    #[test]
    fn missing_source_window_releases_uncommitted_workspace_authority() {
        let root = TestDirectory::create("missing-source");
        let app_data = TestDirectory::create("state-missing-source");
        let app = mock_app();
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();

        let error = coordinator
            .coordinate_open(
                open_context(app.handle(), "missing-window", &access, &persistent, 10),
                workspace.id(),
                Some(WorkspaceOpenDisposition::CurrentWindow),
            )
            .expect_err("a missing source window must reject the open");

        assert_eq!(error.code, DesktopErrorCode::WindowNotFound);
        assert_eq!(
            access.workspace(workspace.id()).unwrap_err().code,
            DesktopErrorCode::WorkspaceNotRegistered
        );
        assert!(persistent.snapshot().unwrap().workspace_sessions.is_empty());
    }

    #[test]
    fn new_window_preserves_original_and_uses_distinct_session_label() {
        let first_root = TestDirectory::create("new-first");
        let second_root = TestDirectory::create("new-second");
        let app_data = TestDirectory::create("state-new");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();

        let opened = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                second.id(),
                Some(WorkspaceOpenDisposition::NewWindow),
            )
            .unwrap();
        let WorkspaceOpenOutcome::OpenedNew { window_label, .. } = opened else {
            panic!("workspace should open in a new window");
        };
        assert_eq!(window_label, "plainroot-window-2");
        assert!(app.get_webview_window(INITIAL_WINDOW_LABEL).is_some());
        assert!(app.get_webview_window(&window_label).is_some());
        assert_eq!(persistent.snapshot().unwrap().workspace_sessions.len(), 2);
    }

    #[test]
    fn state_failure_after_new_window_creation_closes_new_window_and_releases_workspace() {
        let first_root = TestDirectory::create("failure-first");
        let second_root = TestDirectory::create("failure-second");
        let app_data = TestDirectory::create("state-failure");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();
        fs::remove_file(app_data.path().join("state.json")).unwrap();
        fs::create_dir(app_data.path().join("state.json")).unwrap();

        let error = coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                second.id(),
                Some(WorkspaceOpenDisposition::NewWindow),
            )
            .unwrap_err();
        assert_eq!(error.code, DesktopErrorCode::StateWriteFailed);
        assert!(app.get_webview_window(INITIAL_WINDOW_LABEL).is_some());
        assert_eq!(coordinator.active_window_for(second.id()), None);
        assert_eq!(
            access.workspace(second.id()).unwrap_err().code,
            DesktopErrorCode::WorkspaceNotRegistered
        );
    }

    #[test]
    fn legacy_labels_migrate_without_collisions_and_are_reserved_for_restore() {
        let app_data = TestDirectory::create("state-migration");
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        persistent
            .update(|state| {
                state.workspace_sessions = vec![
                    WorkspaceSessionRoot {
                        workspace_id: WorkspaceId::parse("workspace-a").unwrap(),
                        window_label: "main".to_owned(),
                        window_state_ref: None,
                        last_active_at: 2,
                    },
                    WorkspaceSessionRoot {
                        workspace_id: WorkspaceId::parse("workspace-b").unwrap(),
                        window_label: "launcher-1".to_owned(),
                        window_state_ref: None,
                        last_active_at: 1,
                    },
                ];
            })
            .unwrap();

        let migrated = migrate_legacy_window_labels(&persistent).unwrap();
        let labels = migrated
            .workspace_sessions
            .iter()
            .map(|session| session.window_label.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(labels.len(), 2);
        assert!(labels.contains("plainroot-window-1"));
        assert!(labels.contains("plainroot-window-2"));
        let coordinator = WorkspaceWindowCoordinator::from_sessions(&migrated.workspace_sessions);
        let app = mock_app();
        create_initial_window(app.handle());
        let launcher = coordinator.create_launcher(app.handle()).unwrap();
        assert_eq!(launcher.window_label, "plainroot-window-3");
    }

    #[test]
    fn second_instance_requests_are_bounded_sanitized_and_drained_once() {
        let coordinator = WorkspaceWindowCoordinator::default();
        for index in 0..20 {
            coordinator
                .enqueue_second_instance_request(
                    vec!["plainroot".to_owned(), format!("note-{index}.md")],
                    "/tmp".to_owned(),
                )
                .unwrap();
        }

        let requests = coordinator.take_second_instance_requests().unwrap();
        assert_eq!(requests.len(), 16);
        assert_eq!(requests[0].arguments, vec!["note-4.md"]);
        assert_eq!(requests[15].arguments, vec!["note-19.md"]);
        assert!(coordinator
            .take_second_instance_requests()
            .unwrap()
            .is_empty());
        assert_interface_matches("SecondInstanceOpenRequest", &requests[0]);
    }

    #[test]
    fn window_coordination_tagged_contract_matches_typescript() {
        let root = TestDirectory::create("contract");
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let workspace_id = WorkspaceId::parse("workspace-contract").unwrap();
        let outcomes = [
            serde_json::to_value(WorkspaceOpenOutcome::DecisionRequired {
                workspace: workspace.clone(),
                current_workspace_id: workspace_id.clone(),
                current_workspace_name: "Current".to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::OpenedCurrent {
                workspace: workspace.clone(),
                window_label: INITIAL_WINDOW_LABEL.to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::OpenedNew {
                workspace,
                window_label: "plainroot-window-2".to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::FocusedExisting {
                workspace_id,
                window_label: INITIAL_WINDOW_LABEL.to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::Cancelled).unwrap(),
        ];
        let statuses = outcomes
            .iter()
            .map(|value| value["status"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            typescript_string_constant_values("WORKSPACE_OPEN_STATUSES")
        );
        assert_eq!(outcomes[0]["currentWorkspaceName"], "Current");
        assert_eq!(outcomes[1]["windowLabel"], INITIAL_WINDOW_LABEL);
        assert_eq!(outcomes[3]["workspaceId"], "workspace-contract");
        assert_eq!(outcomes[4], serde_json::json!({ "status": "cancelled" }));
        let dispositions = [
            WorkspaceOpenDisposition::CurrentWindow,
            WorkspaceOpenDisposition::NewWindow,
            WorkspaceOpenDisposition::Cancel,
        ]
        .into_iter()
        .map(|value| {
            serde_json::to_value(value)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
        assert_eq!(
            dispositions,
            typescript_string_constant_values("WORKSPACE_OPEN_DISPOSITIONS")
        );
        let action = super::WindowActionResult {
            window_label: "plainroot-window-1".to_owned(),
        };
        assert_interface_matches("WindowActionResult", &action);
        let request = SecondInstanceOpenRequest {
            request_id: 1,
            arguments: vec![],
            working_directory: ".".to_owned(),
        };
        assert_interface_matches("SecondInstanceOpenRequest", &request);
    }
}
