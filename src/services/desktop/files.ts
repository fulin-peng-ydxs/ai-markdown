import { invoke } from "@tauri-apps/api/core";

import type {
  MarkdownReadResult,
  FileRevision,
  SafeWriteResult,
  WorkspaceId,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
  WorkspaceMoveRisk,
  WorkspaceMutationResult,
  DeleteResult,
  PermanentDeleteProposal,
  WorkspaceWatchBatch,
  WorkspaceWatchStart,
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

export function startWorkspaceWatch(
  workspaceId: WorkspaceId,
): Promise<WorkspaceWatchStart> {
  return invoke<WorkspaceWatchStart>("start_workspace_watch", { workspaceId });
}

export function restartWorkspaceWatch(
  workspaceId: WorkspaceId,
): Promise<WorkspaceWatchStart> {
  return invoke<WorkspaceWatchStart>("restart_workspace_watch", {
    workspaceId,
  });
}

export function pollWorkspaceWatch(
  watchId: string,
): Promise<WorkspaceWatchBatch> {
  return invoke<WorkspaceWatchBatch>("poll_workspace_watch", { watchId });
}

export function stopWorkspaceWatch(watchId: string): Promise<boolean> {
  return invoke<boolean>("stop_workspace_watch", { watchId });
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

export function safeWriteMarkdownFile(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
  content: string,
  expectedRevision: FileRevision,
): Promise<SafeWriteResult> {
  return invoke<SafeWriteResult>("safe_write_markdown_file", {
    workspaceId,
    relativePath,
    content,
    expectedRevision,
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

export function inspectWorkspaceMoveRisk(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<WorkspaceMoveRisk> {
  return invoke<WorkspaceMoveRisk>("inspect_workspace_move_risk", {
    workspaceId,
    relativePath,
  });
}

export function trashWorkspaceEntry(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<DeleteResult> {
  return invoke<DeleteResult>("trash_workspace_entry", {
    workspaceId,
    relativePath,
  });
}

export function preparePermanentDelete(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<PermanentDeleteProposal> {
  return invoke<PermanentDeleteProposal>("prepare_permanent_delete", {
    workspaceId,
    relativePath,
  });
}

export function confirmPermanentDelete(
  workspaceId: WorkspaceId,
  confirmationId: string,
): Promise<DeleteResult> {
  return invoke<DeleteResult>("confirm_permanent_delete", {
    workspaceId,
    confirmationId,
  });
}

export function cancelPermanentDelete(
  confirmationId: string,
): Promise<boolean> {
  return invoke<boolean>("cancel_permanent_delete", { confirmationId });
}

export function revealWorkspaceEntry(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<void> {
  return invoke<void>("reveal_workspace_entry", {
    workspaceId,
    relativePath,
  });
}
