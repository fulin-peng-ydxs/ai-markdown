import { invoke } from "@tauri-apps/api/core";

import type {
  FileRevision,
  RecoveryCleanupResult,
  RecoverySnapshot,
  RecoverySnapshotMetadata,
  RecoveryUpsertResult,
  WorkspaceId,
  WorkspaceRelativePath,
} from "./contracts";

export function listRecoverySnapshots(): Promise<RecoverySnapshotMetadata[]> {
  return invoke("list_recovery_snapshots");
}

export function getRecoverySnapshot(
  snapshotId: string,
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<RecoverySnapshot> {
  return invoke("get_recovery_snapshot", {
    snapshotId,
    workspaceId,
    relativePath,
  });
}

export function registerActiveRecoverySession(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<boolean> {
  return invoke("register_active_recovery_session", {
    workspaceId,
    relativePath,
  });
}

export function releaseActiveRecoverySession(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<boolean> {
  return invoke("release_active_recovery_session", {
    workspaceId,
    relativePath,
  });
}

export function upsertRecoverySnapshot(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
  content: string,
  baseRevision: FileRevision,
): Promise<RecoveryUpsertResult> {
  return invoke("upsert_recovery_snapshot", {
    workspaceId,
    relativePath,
    content,
    baseRevision,
  });
}

export function deleteRecoverySnapshot(snapshotId: string): Promise<boolean> {
  return invoke("delete_recovery_snapshot", { snapshotId });
}

export function cleanupRecoverySnapshots(): Promise<RecoveryCleanupResult> {
  return invoke("cleanup_recovery_snapshots");
}
