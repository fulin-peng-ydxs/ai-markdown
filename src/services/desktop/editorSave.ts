import { invoke } from "@tauri-apps/api/core";

import type {
  ConflictOverwriteProposal,
  SafeWriteResult,
  SaveCopyFormatChoice,
  SaveCopyResult,
  SaveCopySelectionOutcome,
  SaveCopySource,
  WorkspaceId,
  WorkspaceRelativePath,
} from "./contracts";

export function prepareConflictOverwrite(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
  content: string,
): Promise<ConflictOverwriteProposal> {
  return invoke("prepare_conflict_overwrite", {
    workspaceId,
    relativePath,
    content,
  });
}

export function confirmConflictOverwrite(
  workspaceId: WorkspaceId,
  confirmationId: string,
  content: string,
): Promise<SafeWriteResult> {
  return invoke("confirm_conflict_overwrite", {
    workspaceId,
    confirmationId,
    content,
  });
}

export function cancelConflictOverwrite(
  confirmationId: string,
): Promise<boolean> {
  return invoke("cancel_conflict_overwrite", { confirmationId });
}

export function prepareSaveCopy(
  source: SaveCopySource,
  formatChoice: SaveCopyFormatChoice | null = null,
): Promise<SaveCopySelectionOutcome> {
  return invoke("prepare_save_copy", { source, formatChoice });
}

export function confirmSaveCopy(
  confirmationId: string,
  content: string,
  overwriteExisting: boolean,
): Promise<SaveCopyResult> {
  return invoke("confirm_save_copy", {
    confirmationId,
    content,
    overwriteExisting,
  });
}

export function cancelSaveCopy(confirmationId: string): Promise<boolean> {
  return invoke("cancel_save_copy", { confirmationId });
}
