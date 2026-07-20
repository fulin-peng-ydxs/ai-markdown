import { invoke } from "@tauri-apps/api/core";

import type {
  MarkdownReadResult,
  WorkspaceId,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
  WorkspaceMutationResult,
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

export function createMarkdownFile(
  workspaceId: WorkspaceId,
  name: string,
  parent: WorkspaceRelativePath | null = null,
): Promise<WorkspaceMutationResult> {
  return invoke<WorkspaceMutationResult>("create_markdown_file", {
    workspaceId,
    parent,
    name,
  });
}

export function createWorkspaceDirectory(
  workspaceId: WorkspaceId,
  name: string,
  parent: WorkspaceRelativePath | null = null,
): Promise<WorkspaceMutationResult> {
  return invoke<WorkspaceMutationResult>("create_workspace_directory", {
    workspaceId,
    parent,
    name,
  });
}

export function renameWorkspaceEntry(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
  name: string,
): Promise<WorkspaceMutationResult> {
  return invoke<WorkspaceMutationResult>("rename_workspace_entry", {
    workspaceId,
    relativePath,
    name,
  });
}

export function moveWorkspaceEntry(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
  targetDirectory: WorkspaceRelativePath | null,
): Promise<WorkspaceMutationResult> {
  return invoke<WorkspaceMutationResult>("move_workspace_entry", {
    workspaceId,
    relativePath,
    targetDirectory,
  });
}
