use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::workspace::WorkspaceAccessService;
use crate::error::{DesktopError, DesktopErrorCode};
use crate::fs::{WorkspaceDescriptor, WorkspaceId, WorkspaceRelativePath};
use crate::state::{
    PersistentAppState, PlainrootStateV1, RecentWorkspace, WorkspaceAvailability,
    WorkspaceSessionRoot, MAX_RECENT_WORKSPACES,
};
use crate::window_session::WindowSessionRepository;

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
pub const WINDOW_SETTLEMENT_EVENT: &str = "plainroot://window-settlement";

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
    SettlementRequired {
        intent_id: String,
        workspace: WorkspaceDescriptor,
        window_label: String,
    },
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowSettlementIntentKind {
    CloseWindow,
    ReplaceWorkspace,
    QuitApp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSettlementIntent {
    pub intent_id: String,
    pub kind: WindowSettlementIntentKind,
    pub window_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WindowSettlementResolution {
    Closed {
        window_label: String,
    },
    Cancelled,
    Pending,
    OpenedCurrent {
        workspace: WorkspaceDescriptor,
        window_label: String,
    },
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingSettlementAction {
    CloseWindow,
    ReplaceWorkspace { workspace_id: WorkspaceId },
    QuitApp { quit_intent_id: String },
}

#[derive(Debug, Clone)]
struct PendingWindowSettlement {
    intent: WindowSettlementIntent,
    action: PendingSettlementAction,
}

#[derive(Debug, Default)]
struct WindowSettlementState {
    next_intent_id: u64,
    pending_by_window: HashMap<String, PendingWindowSettlement>,
    close_bypass: HashSet<String>,
    quit_intent_id: Option<String>,
    quit_pending_windows: HashSet<String>,
    exit_bypass: bool,
}

#[derive(Debug, Default)]
pub struct WindowSettlementCoordinator {
    state: Mutex<WindowSettlementState>,
}

struct WorkspaceOpenContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    source_window_label: &'a str,
    access: &'a WorkspaceAccessService,
    persistent_state: &'a PersistentAppState,
    window_sessions: Option<&'a WindowSessionRepository>,
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
            let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            let label = next_window_label(app, &state.reserved_labels);
            state.reserved_labels.insert(label.clone());
            label
        };
        let window = match create_window_with_label(app, &label, &launcher_title()) {
            Ok(window) => window,
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    state.reserved_labels.remove(&label);
                }
                return Err(error);
            }
        };
        Ok(WindowActionResult {
            window_label: window.label().to_owned(),
        })
    }

    pub fn workspace_for_window(&self, label: &str) -> Result<Option<WorkspaceId>, DesktopError> {
        self.state
            .lock()
            .map(|state| state.window_workspaces.get(label).cloned())
            .map_err(|_| coordinator_unavailable())
    }

    pub fn window_for_workspace(
        &self,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<String>, DesktopError> {
        self.state
            .lock()
            .map(|state| state.workspace_windows.get(workspace_id).cloned())
            .map_err(|_| coordinator_unavailable())
    }

    pub fn active_workspace_ids(&self) -> Result<Vec<WorkspaceId>, DesktopError> {
        self.state
            .lock()
            .map(|state| state.workspace_windows.keys().cloned().collect())
            .map_err(|_| coordinator_unavailable())
    }

    pub fn active_window_labels(&self) -> Result<Vec<String>, DesktopError> {
        self.state
            .lock()
            .map(|state| state.window_workspaces.keys().cloned().collect())
            .map_err(|_| coordinator_unavailable())
    }

    pub fn discard_restorable_session(
        &self,
        workspace_id: &WorkspaceId,
        persistent_state: &PersistentAppState,
    ) -> Result<bool, DesktopError> {
        self.discard_auxiliary_workspace_state(workspace_id, persistent_state, false)
    }

    pub fn discard_recent_workspace(
        &self,
        workspace_id: &WorkspaceId,
        persistent_state: &PersistentAppState,
    ) -> Result<bool, DesktopError> {
        self.discard_auxiliary_workspace_state(workspace_id, persistent_state, true)
    }

    fn discard_auxiliary_workspace_state(
        &self,
        workspace_id: &WorkspaceId,
        persistent_state: &PersistentAppState,
        include_recent: bool,
    ) -> Result<bool, DesktopError> {
        let restorable_label = {
            let state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            state.restorable_labels.get(workspace_id).cloned()
        };
        let snapshot = persistent_state.snapshot()?;
        let had_session = snapshot
            .workspace_sessions
            .iter()
            .any(|session| session.workspace_id == *workspace_id);
        let had_recent = include_recent
            && snapshot
                .recent_workspaces
                .iter()
                .any(|recent| recent.workspace_id == *workspace_id);
        if !had_session && !had_recent {
            return Ok(false);
        }
        persistent_state.update(|current| {
            current
                .workspace_sessions
                .retain(|session| session.workspace_id != *workspace_id);
            if include_recent {
                current
                    .recent_workspaces
                    .retain(|recent| recent.workspace_id != *workspace_id);
            }
        })?;

        let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
        if state.workspace_windows.contains_key(workspace_id) {
            // Removing auxiliary history is allowed while the workspace remains open. Keep the
            // live in-memory authority and window label, but respect the user's choice not to
            // restore this root after a crash or restart.
            return Ok(true);
        }
        if let Some(label) = state.restorable_labels.remove(workspace_id) {
            state.reserved_labels.remove(&label);
        } else if let Some(label) = restorable_label {
            state.reserved_labels.remove(&label);
        }
        Ok(true)
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
            window_sessions,
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
                    window_sessions,
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
                let stale_for_source = state
                    .restorable_labels
                    .iter()
                    .filter(|(candidate_id, label)| {
                        *candidate_id != workspace_id && label.as_str() == source_window_label
                    })
                    .map(|(candidate_id, _)| candidate_id.clone())
                    .collect::<Vec<_>>();
                for candidate_id in stale_for_source {
                    state.restorable_labels.remove(&candidate_id);
                }
                if let Some(previous_label) = state.restorable_labels.remove(workspace_id) {
                    if previous_label != source_window_label {
                        state.reserved_labels.remove(&previous_label);
                    }
                }
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
                    window_sessions,
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

impl WindowSettlementCoordinator {
    pub fn request_close<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
    ) -> Result<WindowSettlementIntent, DesktopError> {
        self.request(
            app,
            window_label,
            WindowSettlementIntentKind::CloseWindow,
            PendingSettlementAction::CloseWindow,
        )
    }

    pub fn request_replace<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        workspace_id: WorkspaceId,
    ) -> Result<WindowSettlementIntent, DesktopError> {
        self.request(
            app,
            window_label,
            WindowSettlementIntentKind::ReplaceWorkspace,
            PendingSettlementAction::ReplaceWorkspace { workspace_id },
        )
    }

    pub fn request_quit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        coordinator: &WorkspaceWindowCoordinator,
    ) -> Result<(), DesktopError> {
        let window_labels = coordinator.active_window_labels()?;
        if window_labels.is_empty() {
            self.allow_next_exit()?;
            app.exit(0);
            return Ok(());
        }
        let intents = {
            let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            if state.quit_intent_id.is_some() {
                return Ok(());
            }
            if window_labels
                .iter()
                .any(|label| state.pending_by_window.contains_key(label))
            {
                return Err(coordinator_unavailable());
            }
            state.next_intent_id = state.next_intent_id.saturating_add(1);
            let intent_id = format!("settlement-{}", state.next_intent_id);
            state.quit_intent_id = Some(intent_id.clone());
            state.quit_pending_windows = window_labels.iter().cloned().collect();
            window_labels
                .iter()
                .map(|window_label| {
                    let intent = WindowSettlementIntent {
                        intent_id: intent_id.clone(),
                        kind: WindowSettlementIntentKind::QuitApp,
                        window_label: window_label.clone(),
                    };
                    state.pending_by_window.insert(
                        window_label.clone(),
                        PendingWindowSettlement {
                            intent: intent.clone(),
                            action: PendingSettlementAction::QuitApp {
                                quit_intent_id: intent_id.clone(),
                            },
                        },
                    );
                    intent
                })
                .collect::<Vec<_>>()
        };
        for intent in intents {
            let Some(window) = app.get_webview_window(&intent.window_label) else {
                self.cancel_quit(&intent.intent_id);
                return Err(window_error(DesktopErrorCode::WindowNotFound));
            };
            if window.emit(WINDOW_SETTLEMENT_EVENT, &intent).is_err() {
                self.cancel_quit(&intent.intent_id);
                return Err(window_error(DesktopErrorCode::WindowFocusFailed));
            }
        }
        Ok(())
    }

    fn request<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window_label: &str,
        kind: WindowSettlementIntentKind,
        action: PendingSettlementAction,
    ) -> Result<WindowSettlementIntent, DesktopError> {
        let intent = {
            let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            if let Some(existing) = state.pending_by_window.get(window_label) {
                if existing.action == action {
                    return Ok(existing.intent.clone());
                }
                return Err(coordinator_unavailable());
            }
            state.next_intent_id = state.next_intent_id.saturating_add(1);
            let intent = WindowSettlementIntent {
                intent_id: format!("settlement-{}", state.next_intent_id),
                kind,
                window_label: window_label.to_owned(),
            };
            state.pending_by_window.insert(
                window_label.to_owned(),
                PendingWindowSettlement {
                    intent: intent.clone(),
                    action,
                },
            );
            intent
        };
        let Some(window) = app.get_webview_window(window_label) else {
            if let Ok(mut state) = self.state.lock() {
                state.pending_by_window.remove(window_label);
            }
            return Err(window_error(DesktopErrorCode::WindowNotFound));
        };
        if window.emit(WINDOW_SETTLEMENT_EVENT, &intent).is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.pending_by_window.remove(window_label);
            }
            return Err(window_error(DesktopErrorCode::WindowFocusFailed));
        }
        Ok(intent)
    }

    fn resolve<R: Runtime>(
        &self,
        context: WorkspaceOpenContext<'_, R>,
        intent_id: &str,
        allow: bool,
        coordinator: &WorkspaceWindowCoordinator,
    ) -> Result<WindowSettlementResolution, DesktopError> {
        let pending = {
            let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
            let Some(pending) = state
                .pending_by_window
                .get(context.source_window_label)
                .cloned()
            else {
                return Ok(WindowSettlementResolution::Cancelled);
            };
            if pending.intent.intent_id != intent_id {
                return Ok(WindowSettlementResolution::Pending);
            }
            state.pending_by_window.remove(context.source_window_label);
            pending
        };

        if !allow {
            match pending.action {
                PendingSettlementAction::ReplaceWorkspace { workspace_id } => {
                    let _ = context.access.release_workspace(&workspace_id);
                }
                PendingSettlementAction::QuitApp { quit_intent_id } => {
                    self.cancel_quit(&quit_intent_id);
                }
                PendingSettlementAction::CloseWindow => {}
            }
            return Ok(WindowSettlementResolution::Cancelled);
        }

        match pending.action {
            PendingSettlementAction::CloseWindow => {
                self.allow_next_close(context.source_window_label)?;
                if let Err(error) = coordinator.close_window(
                    context.app,
                    context.source_window_label,
                    context.access,
                    context.persistent_state,
                ) {
                    self.revoke_close_bypass(context.source_window_label);
                    return Err(error);
                }
                Ok(WindowSettlementResolution::Closed {
                    window_label: context.source_window_label.to_owned(),
                })
            }
            PendingSettlementAction::ReplaceWorkspace { workspace_id } => {
                let outcome = coordinator.coordinate_open(
                    context,
                    &workspace_id,
                    Some(WorkspaceOpenDisposition::CurrentWindow),
                )?;
                let WorkspaceOpenOutcome::OpenedCurrent {
                    workspace,
                    window_label,
                } = outcome
                else {
                    return Err(coordinator_unavailable());
                };
                Ok(WindowSettlementResolution::OpenedCurrent {
                    workspace,
                    window_label,
                })
            }
            PendingSettlementAction::QuitApp { quit_intent_id } => {
                let should_exit = {
                    let mut state = self.state.lock().map_err(|_| coordinator_unavailable())?;
                    if state.quit_intent_id.as_deref() != Some(quit_intent_id.as_str()) {
                        return Ok(WindowSettlementResolution::Cancelled);
                    }
                    state
                        .quit_pending_windows
                        .remove(context.source_window_label);
                    if state.quit_pending_windows.is_empty() {
                        state.quit_intent_id = None;
                        state.exit_bypass = true;
                        true
                    } else {
                        false
                    }
                };
                if should_exit {
                    context.app.exit(0);
                }
                Ok(WindowSettlementResolution::Pending)
            }
        }
    }

    pub fn take_close_bypass(&self, window_label: &str) -> bool {
        self.state
            .lock()
            .map(|mut state| state.close_bypass.remove(window_label))
            .unwrap_or(false)
    }

    pub fn take_exit_bypass(&self) -> bool {
        self.state
            .lock()
            .map(|mut state| std::mem::take(&mut state.exit_bypass))
            .unwrap_or(false)
    }

    fn allow_next_close(&self, window_label: &str) -> Result<(), DesktopError> {
        self.state
            .lock()
            .map(|mut state| {
                state.close_bypass.insert(window_label.to_owned());
            })
            .map_err(|_| coordinator_unavailable())
    }

    fn revoke_close_bypass(&self, window_label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.close_bypass.remove(window_label);
        }
    }

    fn allow_next_exit(&self) -> Result<(), DesktopError> {
        self.state
            .lock()
            .map(|mut state| state.exit_bypass = true)
            .map_err(|_| coordinator_unavailable())
    }

    fn cancel_quit(&self, quit_intent_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.quit_intent_id.as_deref() != Some(quit_intent_id) {
                return;
            }
            state.pending_by_window.retain(|_, pending| {
                !matches!(
                    &pending.action,
                    PendingSettlementAction::QuitApp {
                        quit_intent_id: candidate
                    } if candidate == quit_intent_id
                )
            });
            state.quit_intent_id = None;
            state.quit_pending_windows.clear();
        }
    }

    #[cfg(test)]
    fn pending_for(&self, window_label: &str) -> Option<WindowSettlementIntent> {
        self.state.lock().ok().and_then(|state| {
            state
                .pending_by_window
                .get(window_label)
                .map(|pending| pending.intent.clone())
        })
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

fn workbench_window_title(workspace_name: &str, file_name: Option<&str>) -> String {
    #[cfg(feature = "e2e")]
    if std::env::var_os("PLAINROOT_E2E_FIXED_WINDOW_TITLE").is_some() {
        // WDIO selects a WebView2 renderer through its native title. The
        // Windows E2E processes freeze that unrelated title boundary so WDIO
        // can keep inspecting the real renderer across document changes.
        return document_title(workspace_name, None);
    }
    document_title(workspace_name, file_name)
}

#[tauri::command]
pub fn set_workbench_window_title<R: Runtime>(
    window: WebviewWindow<R>,
    relative_path: Option<String>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    access: State<'_, WorkspaceAccessService>,
) -> Result<WindowActionResult, DesktopError> {
    let workspace_id = coordinator
        .workspace_for_window(window.label())?
        .ok_or_else(|| window_error(DesktopErrorCode::WindowNotFound))?;
    let workspace = access.workspace(&workspace_id)?;
    let file_name = relative_path
        .as_deref()
        .map(WorkspaceRelativePath::parse)
        .transpose()?
        .and_then(|path| {
            std::path::Path::new(path.as_str())
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        });
    window
        .set_title(&workbench_window_title(
            workspace.display_name(),
            file_name.as_deref(),
        ))
        .map_err(|_| window_error(DesktopErrorCode::WindowTitleFailed))?;
    Ok(WindowActionResult {
        window_label: window.label().to_owned(),
    })
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
// Tauri command parameters mirror the public IPC contract plus managed services.
#[allow(clippy::too_many_arguments)]
pub fn coordinate_workspace_open<R: Runtime>(
    window: WebviewWindow<R>,
    workspace_id: WorkspaceId,
    disposition: Option<WorkspaceOpenDisposition>,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    settlement: State<'_, WindowSettlementCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    persistent_state: State<'_, PersistentAppState>,
    window_sessions: State<'_, WindowSessionRepository>,
) -> Result<WorkspaceOpenOutcome, DesktopError> {
    if disposition == Some(WorkspaceOpenDisposition::CurrentWindow) {
        let current_workspace_id = coordinator.workspace_for_window(window.label())?;
        let target_already_open = coordinator.window_for_workspace(&workspace_id)?.is_some();
        if current_workspace_id
            .as_ref()
            .is_some_and(|current| current != &workspace_id)
            && !target_already_open
        {
            let workspace = access.workspace(&workspace_id)?;
            let intent =
                settlement.request_replace(window.app_handle(), window.label(), workspace_id)?;
            return Ok(WorkspaceOpenOutcome::SettlementRequired {
                intent_id: intent.intent_id,
                workspace,
                window_label: window.label().to_owned(),
            });
        }
    }
    coordinator.coordinate_open(
        WorkspaceOpenContext {
            app: window.app_handle(),
            source_window_label: window.label(),
            access: &access,
            persistent_state: &persistent_state,
            window_sessions: Some(&window_sessions),
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
    settlement: State<'_, WindowSettlementCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    persistent_state: State<'_, PersistentAppState>,
) -> Result<WindowSettlementResolution, DesktopError> {
    if coordinator.workspace_for_window(window.label())?.is_some() {
        settlement.request_close(window.app_handle(), window.label())?;
        return Ok(WindowSettlementResolution::Pending);
    }
    coordinator
        .close_window(
            window.app_handle(),
            window.label(),
            &access,
            &persistent_state,
        )
        .map(|result| WindowSettlementResolution::Closed {
            window_label: result.window_label,
        })
}

#[tauri::command]
// Tauri command parameters mirror the public IPC contract plus managed services.
#[allow(clippy::too_many_arguments)]
pub fn resolve_window_settlement<R: Runtime>(
    window: WebviewWindow<R>,
    intent_id: String,
    allow: bool,
    coordinator: State<'_, WorkspaceWindowCoordinator>,
    settlement: State<'_, WindowSettlementCoordinator>,
    access: State<'_, WorkspaceAccessService>,
    persistent_state: State<'_, PersistentAppState>,
    window_sessions: State<'_, WindowSessionRepository>,
) -> Result<WindowSettlementResolution, DesktopError> {
    settlement.resolve(
        WorkspaceOpenContext {
            app: window.app_handle(),
            source_window_label: window.label(),
            access: &access,
            persistent_state: &persistent_state,
            window_sessions: Some(&window_sessions),
            opened_at: unix_timestamp_millis(),
        },
        &intent_id,
        allow,
        &coordinator,
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
    window_sessions: Option<&WindowSessionRepository>,
    workspace: &WorkspaceDescriptor,
    window_label: &str,
    opened_at: u64,
) -> Result<PlainrootStateV1, DesktopError> {
    let window_state_ref = window_sessions
        .map(|repository| repository.ensure_reference(workspace.id()))
        .transpose()?
        .map(|summary| summary.window_state_ref);
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
            window_state_ref,
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
    use std::path::Path;

    use tauri::test::mock_app;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    use super::{
        close_window, document_title, focus_window, launcher_title, migrate_legacy_window_labels,
        SecondInstanceOpenRequest, WindowSettlementCoordinator, WindowSettlementIntentKind,
        WindowSettlementResolution, WorkspaceOpenContext, WorkspaceOpenDisposition,
        WorkspaceOpenOutcome, WorkspaceWindowCoordinator, INITIAL_WINDOW_LABEL,
    };
    use crate::commands::workspace::WorkspaceAccessService;
    use crate::contract_test::{assert_interface_matches, typescript_string_constant_values};
    use crate::error::DesktopErrorCode;
    use crate::fs::WorkspaceId;
    use crate::state::{PersistentAppState, WorkspaceSessionRoot};
    use crate::test_support::TestDirectory;
    use crate::window_session::WindowSessionRepository;

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
            window_sessions: None,
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
    fn committed_workspace_binding_persists_a_real_window_session_reference() {
        let root = TestDirectory::create("window-session-binding");
        let app_data = TestDirectory::create("window-session-binding-data");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let window_sessions = WindowSessionRepository::initialize_at(app_data.path());
        let coordinator = WorkspaceWindowCoordinator::default();

        coordinator
            .coordinate_open(
                WorkspaceOpenContext {
                    app: app.handle(),
                    source_window_label: INITIAL_WINDOW_LABEL,
                    access: &access,
                    persistent_state: &persistent,
                    window_sessions: Some(&window_sessions),
                    opened_at: 10,
                },
                workspace.id(),
                None,
            )
            .unwrap();

        let root_session = persistent
            .snapshot()
            .unwrap()
            .workspace_sessions
            .into_iter()
            .next()
            .unwrap();
        let summary = window_sessions.summaries().unwrap().remove(0);
        assert_eq!(
            root_session.window_state_ref.as_deref(),
            Some(summary.window_state_ref.as_str())
        );
        assert_eq!(summary.workspace_id, *workspace.id());
        assert_eq!(summary.revision, 0);
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
    fn replacement_settlement_is_non_destructive_until_frontend_allows_it() {
        let first_root = TestDirectory::create("settlement-first");
        let second_root = TestDirectory::create("settlement-second");
        let app_data = TestDirectory::create("settlement-state");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        let settlement = WindowSettlementCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();

        let intent = settlement
            .request_replace(app.handle(), INITIAL_WINDOW_LABEL, second.id().clone())
            .unwrap();
        assert_eq!(intent.kind, WindowSettlementIntentKind::ReplaceWorkspace);
        assert_eq!(
            coordinator.active_window_for(first.id()).as_deref(),
            Some(INITIAL_WINDOW_LABEL)
        );
        assert!(settlement.pending_for(INITIAL_WINDOW_LABEL).is_some());

        let cancelled = settlement
            .resolve(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                &intent.intent_id,
                false,
                &coordinator,
            )
            .unwrap();
        assert_eq!(cancelled, WindowSettlementResolution::Cancelled);
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
    fn repeated_close_reuses_one_intent_and_only_an_allowed_resolution_closes() {
        let root = TestDirectory::create("settlement-close");
        let app_data = TestDirectory::create("settlement-close-state");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        let settlement = WindowSettlementCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                workspace.id(),
                None,
            )
            .unwrap();

        let first = settlement
            .request_close(app.handle(), INITIAL_WINDOW_LABEL)
            .unwrap();
        let repeated = settlement
            .request_close(app.handle(), INITIAL_WINDOW_LABEL)
            .unwrap();
        assert_eq!(first, repeated);
        let cancelled = settlement
            .resolve(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 20),
                &first.intent_id,
                false,
                &coordinator,
            )
            .unwrap();
        assert_eq!(cancelled, WindowSettlementResolution::Cancelled);
        assert!(app.get_webview_window(INITIAL_WINDOW_LABEL).is_some());

        let allowed = settlement
            .request_close(app.handle(), INITIAL_WINDOW_LABEL)
            .unwrap();
        let closed = settlement
            .resolve(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 30),
                &allowed.intent_id,
                true,
                &coordinator,
            )
            .unwrap();
        assert!(matches!(closed, WindowSettlementResolution::Closed { .. }));
        assert_eq!(coordinator.active_window_for(workspace.id()), None);
        assert!(persistent.snapshot().unwrap().workspace_sessions.is_empty());
        assert_eq!(
            access.workspace(workspace.id()).unwrap_err().code,
            DesktopErrorCode::WorkspaceNotRegistered
        );
        assert!(settlement.take_close_bypass(INITIAL_WINDOW_LABEL));
    }

    #[test]
    fn missing_window_does_not_leave_a_stale_settlement_intent() {
        let app = mock_app();
        let settlement = WindowSettlementCoordinator::default();

        let error = settlement
            .request_close(app.handle(), "missing-window")
            .unwrap_err();

        assert_eq!(error.code, DesktopErrorCode::WindowNotFound);
        assert_eq!(settlement.pending_for("missing-window"), None);
    }

    #[test]
    fn multi_window_quit_waits_for_every_window_and_one_rejection_cancels_the_group() {
        let first_root = TestDirectory::create("quit-first");
        let second_root = TestDirectory::create("quit-second");
        let app_data = TestDirectory::create("quit-state");
        let app = mock_app();
        create_initial_window(app.handle());
        WebviewWindowBuilder::new(
            app.handle(),
            "plainroot-window-2",
            WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let access = WorkspaceAccessService::default();
        let first = authorize_root(&access, first_root.path());
        let second = authorize_root(&access, second_root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        let settlement = WindowSettlementCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                first.id(),
                None,
            )
            .unwrap();
        coordinator
            .coordinate_open(
                open_context(app.handle(), "plainroot-window-2", &access, &persistent, 20),
                second.id(),
                None,
            )
            .unwrap();

        settlement.request_quit(app.handle(), &coordinator).unwrap();
        let first_intent = settlement.pending_for(INITIAL_WINDOW_LABEL).unwrap();
        let second_intent = settlement.pending_for("plainroot-window-2").unwrap();
        assert_eq!(first_intent.intent_id, second_intent.intent_id);
        let first_resolution = settlement
            .resolve(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 30),
                &first_intent.intent_id,
                true,
                &coordinator,
            )
            .unwrap();
        assert_eq!(first_resolution, WindowSettlementResolution::Pending);
        assert!(!settlement.take_exit_bypass());

        let cancelled = settlement
            .resolve(
                open_context(app.handle(), "plainroot-window-2", &access, &persistent, 40),
                &second_intent.intent_id,
                false,
                &coordinator,
            )
            .unwrap();
        assert_eq!(cancelled, WindowSettlementResolution::Cancelled);
        assert!(!settlement.take_exit_bypass());
        assert_eq!(persistent.snapshot().unwrap().workspace_sessions.len(), 2);
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
    fn discarding_a_restorable_session_releases_its_label_once() {
        let app_data = TestDirectory::create("discard-session");
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let workspace_id = WorkspaceId::parse("workspace-discard").unwrap();
        persistent
            .update(|state| {
                state.workspace_sessions.push(WorkspaceSessionRoot {
                    workspace_id: workspace_id.clone(),
                    window_label: "plainroot-window-2".to_owned(),
                    window_state_ref: None,
                    last_active_at: 10,
                });
            })
            .unwrap();
        let coordinator = WorkspaceWindowCoordinator::from_sessions(
            &persistent.snapshot().unwrap().workspace_sessions,
        );

        assert!(coordinator
            .discard_restorable_session(&workspace_id, &persistent)
            .unwrap());
        assert!(!coordinator
            .discard_restorable_session(&workspace_id, &persistent)
            .unwrap());
        let app = mock_app();
        create_initial_window(app.handle());
        let launcher = coordinator.create_launcher(app.handle()).unwrap();
        assert_eq!(launcher.window_label, "plainroot-window-2");
    }

    #[test]
    fn removing_active_history_keeps_live_authority_but_disables_restore() {
        let root = TestDirectory::create("active-history");
        let app_data = TestDirectory::create("state-active-history");
        let app = mock_app();
        create_initial_window(app.handle());
        let access = WorkspaceAccessService::default();
        let workspace = authorize_root(&access, root.path());
        let persistent = PersistentAppState::initialize_at(app_data.path().join("state.json"));
        let coordinator = WorkspaceWindowCoordinator::default();
        coordinator
            .coordinate_open(
                open_context(app.handle(), INITIAL_WINDOW_LABEL, &access, &persistent, 10),
                workspace.id(),
                None,
            )
            .unwrap();

        assert!(coordinator
            .discard_recent_workspace(workspace.id(), &persistent)
            .unwrap());
        let snapshot = persistent.snapshot().unwrap();
        assert!(snapshot.workspace_sessions.is_empty());
        assert!(snapshot.recent_workspaces.is_empty());
        assert_eq!(
            coordinator.active_window_for(workspace.id()).as_deref(),
            Some(INITIAL_WINDOW_LABEL)
        );
        assert!(access.workspace(workspace.id()).is_ok());
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
                workspace: workspace.clone(),
                window_label: "plainroot-window-2".to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::FocusedExisting {
                workspace_id,
                window_label: INITIAL_WINDOW_LABEL.to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WorkspaceOpenOutcome::SettlementRequired {
                intent_id: "settlement-1".to_owned(),
                workspace: workspace.clone(),
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
        assert_eq!(outcomes[4]["intentId"], "settlement-1");
        assert_eq!(outcomes[5], serde_json::json!({ "status": "cancelled" }));
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
        let intent = super::WindowSettlementIntent {
            intent_id: "settlement-1".to_owned(),
            kind: WindowSettlementIntentKind::CloseWindow,
            window_label: INITIAL_WINDOW_LABEL.to_owned(),
        };
        assert_interface_matches("WindowSettlementIntent", &intent);
        let intent_kinds = [
            WindowSettlementIntentKind::CloseWindow,
            WindowSettlementIntentKind::ReplaceWorkspace,
            WindowSettlementIntentKind::QuitApp,
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
            intent_kinds,
            typescript_string_constant_values("WINDOW_SETTLEMENT_INTENT_KINDS")
        );
        let resolutions = [
            serde_json::to_value(WindowSettlementResolution::Closed {
                window_label: INITIAL_WINDOW_LABEL.to_owned(),
            })
            .unwrap(),
            serde_json::to_value(WindowSettlementResolution::Cancelled).unwrap(),
            serde_json::to_value(WindowSettlementResolution::Pending).unwrap(),
            serde_json::to_value(WindowSettlementResolution::OpenedCurrent {
                workspace,
                window_label: INITIAL_WINDOW_LABEL.to_owned(),
            })
            .unwrap(),
        ];
        assert_eq!(
            resolutions
                .iter()
                .map(|value| value["status"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            typescript_string_constant_values("WINDOW_SETTLEMENT_RESOLUTION_STATUSES")
        );
    }
}
