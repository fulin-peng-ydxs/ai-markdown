import { invoke } from "@tauri-apps/api/core";

import type {
  WorkspaceDescriptor,
  WorkspaceId,
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
