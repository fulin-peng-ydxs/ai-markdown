import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  SecondInstanceOpenRequest,
  WindowActionResult,
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceLauncherSnapshot,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceSelectionOutcome,
} from "./contracts";

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

export function createPlainrootWindow(): Promise<WindowActionResult> {
  return invoke<WindowActionResult>("create_plainroot_window");
}

export function closePlainrootWindow(): Promise<WindowActionResult> {
  return invoke<WindowActionResult>("close_plainroot_window");
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

export function removeRecentWorkspace(workspaceId: WorkspaceId): Promise<boolean> {
  return invoke<boolean>("remove_recent_workspace", { workspaceId });
}

export function removeWorkspaceSession(workspaceId: WorkspaceId): Promise<boolean> {
  return invoke<boolean>("remove_workspace_session", { workspaceId });
}

export type LauncherMenuAction = "file.open_folder" | "file.open_markdown";

export function listenForLauncherMenu(
  listener: (action: LauncherMenuAction) => void,
): Promise<UnlistenFn> {
  return listen<LauncherMenuAction>("plainroot://launcher-menu", (event) => {
    if (
      event.payload === "file.open_folder" ||
      event.payload === "file.open_markdown"
    ) {
      listener(event.payload);
    }
  });
}
