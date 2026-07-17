import { invoke } from "@tauri-apps/api/core";

import type {
  MarkdownReadResult,
  WorkspaceId,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
} from "./contracts";

export function startWorkspaceScan(
  workspaceId: WorkspaceId,
  directory: WorkspaceRelativePath | null = null,
): Promise<WorkspaceScanStart> {
  return invoke<WorkspaceScanStart>("start_workspace_scan", {
    workspaceId,
    directory,
  });
}

export function pollWorkspaceScan(
  scanId: string,
): Promise<WorkspaceScanBatch> {
  return invoke<WorkspaceScanBatch>("poll_workspace_scan", { scanId });
}

export function cancelWorkspaceScan(scanId: string): Promise<boolean> {
  return invoke<boolean>("cancel_workspace_scan", { scanId });
}

export function readMarkdownFile(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<MarkdownReadResult> {
  return invoke<MarkdownReadResult>("read_markdown_file", {
    workspaceId,
    relativePath,
  });
}
