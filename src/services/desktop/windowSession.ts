import { invoke } from "@tauri-apps/api/core";

import type {
  WindowTabSession,
  WindowTabSessionSaveResult,
  WindowTabSessionSnapshot,
  WorkspaceId,
  WorkspaceRelativePath,
  WorkspaceTabPathContract,
} from "./contracts";

export function resolveWorkspaceTabPath(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<WorkspaceTabPathContract> {
  return invoke<WorkspaceTabPathContract>("resolve_workspace_tab_path", {
    workspaceId,
    relativePath,
  });
}

export function getWorkspaceTabSession(
  workspaceId: WorkspaceId,
  windowStateRef?: string | null,
): Promise<WindowTabSession> {
  return invoke<WindowTabSession>("get_workspace_tab_session", {
    workspaceId,
    windowStateRef: windowStateRef ?? null,
  });
}

export function saveWorkspaceTabSession(
  workspaceId: WorkspaceId,
  windowStateRef: string | null,
  expectedRevision: number,
  snapshot: WindowTabSessionSnapshot,
): Promise<WindowTabSessionSaveResult> {
  return invoke<WindowTabSessionSaveResult>("save_workspace_tab_session", {
    workspaceId,
    windowStateRef,
    expectedRevision,
    snapshot,
  });
}

export function removeWorkspaceTabSession(
  workspaceId: WorkspaceId,
): Promise<boolean> {
  return invoke<boolean>("remove_workspace_tab_session", { workspaceId });
}
