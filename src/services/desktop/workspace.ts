import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  EditorMenuState,
  SecondInstanceOpenRequest,
  WindowActionResult,
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceLauncherSnapshot,
  WorkspaceWorkbenchSnapshot,
  WorkspaceOpenDisposition,
  WorkspaceOpenPreference,
  WorkspaceOpenPreferenceState,
  WorkspaceOpenOutcome,
  WorkspaceSelectionOutcome,
  WindowSettlementIntent,
  WindowSettlementResolution,
  WorkbenchMenuAction,
} from "./contracts";
import { WORKBENCH_MENU_ACTIONS } from "./contracts";

export function selectWorkspaceFolder(): Promise<WorkspaceSelectionOutcome> {
  return invoke<WorkspaceSelectionOutcome>("select_workspace_folder");
}

export function selectMarkdownFile(): Promise<WorkspaceSelectionOutcome> {
  return invoke<WorkspaceSelectionOutcome>("select_markdown_file");
}

export function authorizeWorkspaceSelection(
  selectionId: string,
  confirmed: boolean,
): Promise<WorkspaceDescriptor> {
  return invoke<WorkspaceDescriptor>("authorize_workspace_selection", {
    selectionId,
    confirmed,
  });
}

export function cancelWorkspaceSelection(
  selectionId: string,
): Promise<boolean> {
  return invoke<boolean>("cancel_workspace_selection", { selectionId });
}

export function validateRecentWorkspace(
  workspaceId: WorkspaceId,
): Promise<WorkspaceSelectionOutcome> {
  return invoke<WorkspaceSelectionOutcome>("validate_recent_workspace", {
    workspaceId,
  });
}

export function coordinateWorkspaceOpen(
  workspaceId: WorkspaceId,
  disposition?: WorkspaceOpenDisposition,
): Promise<WorkspaceOpenOutcome> {
  return invoke<WorkspaceOpenOutcome>("coordinate_workspace_open", {
    workspaceId,
    disposition: disposition ?? null,
  });
}

export function getWorkspaceOpenPreference(): Promise<WorkspaceOpenPreferenceState> {
  return invoke<WorkspaceOpenPreferenceState>("get_workspace_open_preference");
}

export function setWorkspaceOpenPreference(
  disposition: WorkspaceOpenPreference,
): Promise<WorkspaceOpenPreferenceState> {
  return invoke<WorkspaceOpenPreferenceState>("set_workspace_open_preference", {
    disposition,
  });
}

export function resetWorkspaceOpenPreference(): Promise<WorkspaceOpenPreferenceState> {
  return invoke<WorkspaceOpenPreferenceState>("reset_workspace_open_preference");
}

export async function coordinateWorkspaceOpenUsingPreference(
  workspaceId: WorkspaceId,
  disposition?: WorkspaceOpenDisposition,
): Promise<WorkspaceOpenOutcome> {
  if (disposition) return coordinateWorkspaceOpen(workspaceId, disposition);
  const preference = await getWorkspaceOpenPreference().catch(
    () => ({ disposition: "ask" as const }),
  );
  return coordinateWorkspaceOpen(
    workspaceId,
    preference.disposition === "ask" ? undefined : preference.disposition,
  );
}

export function createPlainrootWindow(): Promise<WindowActionResult> {
  return invoke<WindowActionResult>("create_plainroot_window");
}

export function closePlainrootWindow(): Promise<WindowSettlementResolution> {
  return invoke<WindowSettlementResolution>("close_plainroot_window");
}

export function resolveWindowSettlement(
  intentId: string,
  allow: boolean,
): Promise<WindowSettlementResolution> {
  return invoke<WindowSettlementResolution>("resolve_window_settlement", {
    intentId,
    allow,
  });
}

export function takeSecondInstanceOpenRequests(): Promise<
  SecondInstanceOpenRequest[]
> {
  return invoke<SecondInstanceOpenRequest[]>(
    "take_second_instance_open_requests",
  );
}

export function getWorkspaceLauncherSnapshot(): Promise<WorkspaceLauncherSnapshot> {
  return invoke<WorkspaceLauncherSnapshot>("get_workspace_launcher_snapshot");
}

export function getWorkspaceWorkbenchSnapshot(): Promise<WorkspaceWorkbenchSnapshot | null> {
  return invoke<WorkspaceWorkbenchSnapshot | null>("get_workspace_workbench_snapshot");
}

export function setWorkbenchWindowTitle(
  relativePath: string | null,
): Promise<WindowActionResult> {
  return invoke<WindowActionResult>("set_workbench_window_title", {
    relativePath,
  });
}

export function removeRecentWorkspace(workspaceId: WorkspaceId): Promise<boolean> {
  return invoke<boolean>("remove_recent_workspace", { workspaceId });
}

export function removeWorkspaceSession(workspaceId: WorkspaceId): Promise<boolean> {
  return invoke<boolean>("remove_workspace_session", { workspaceId });
}

export type LauncherMenuAction =
  | "file.open_folder"
  | "file.open_markdown"
  | "app.workspace_open_preferences";

export function listenForLauncherMenu(
  listener: (action: LauncherMenuAction) => void,
): Promise<UnlistenFn> {
  return listen<LauncherMenuAction>("plainroot://launcher-menu", (event) => {
    if (
      event.payload === "file.open_folder" ||
      event.payload === "file.open_markdown" ||
      event.payload === "app.workspace_open_preferences"
    ) {
      listener(event.payload);
    }
  });
}

export function listenForWindowSettlement(
  listener: (intent: WindowSettlementIntent) => void,
): Promise<UnlistenFn> {
  return listen<WindowSettlementIntent>(
    "plainroot://window-settlement",
    (event) => listener(event.payload),
  );
}

export function updateEditorMenuState(state: EditorMenuState): Promise<void> {
  return invoke<void>("update_editor_menu_state", { state });
}

export function resetEditorMenuState(): Promise<void> {
  return invoke<void>("reset_editor_menu_state");
}

export function listenForWorkbenchMenu(
  listener: (action: WorkbenchMenuAction) => void,
): Promise<UnlistenFn> {
  return listen<WorkbenchMenuAction>("plainroot://workbench-menu", (event) => {
    if (WORKBENCH_MENU_ACTIONS.includes(event.payload)) {
      listener(event.payload);
    }
  });
}
