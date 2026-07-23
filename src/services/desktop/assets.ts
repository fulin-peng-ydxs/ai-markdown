import { invoke } from "@tauri-apps/api/core";

import type {
  AssetImportProposal,
  AssetImportResult,
  AssetImportSelectionOutcome,
  AssetUploadTicket,
  WorkspaceAssetPreference,
  WorkspaceId,
  WorkspaceRelativePath,
} from "./contracts";

const ASSET_UPLOAD_HEADER = "x-plainroot-asset-upload-id";

export function getWorkspaceAssetPreference(
  workspaceId: WorkspaceId,
): Promise<WorkspaceAssetPreference> {
  return invoke("get_workspace_asset_preference", { workspaceId });
}

export function setWorkspaceAssetDirectory(
  workspaceId: WorkspaceId,
  assetDirectory: WorkspaceRelativePath,
): Promise<WorkspaceAssetPreference> {
  return invoke("set_workspace_asset_directory", {
    workspaceId,
    assetDirectory,
  });
}

export function resetWorkspaceAssetDirectory(
  workspaceId: WorkspaceId,
): Promise<WorkspaceAssetPreference> {
  return invoke("reset_workspace_asset_directory", { workspaceId });
}

export function readWorkspaceImage(
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<Uint8Array> {
  return invoke("read_workspace_image", { workspaceId, relativePath });
}

export function beginAssetImportUpload(
  workspaceId: WorkspaceId,
  declaredMime: string,
  suggestedName: string,
): Promise<AssetUploadTicket> {
  return invoke("begin_asset_import_upload", {
    workspaceId,
    declaredMime,
    suggestedName,
  });
}

export function uploadAssetImport(
  uploadId: string,
  bytes: Uint8Array,
): Promise<AssetImportProposal> {
  return invoke("upload_asset_import", bytes, {
    headers: { [ASSET_UPLOAD_HEADER]: uploadId },
  });
}

export function selectAssetImage(
  workspaceId: WorkspaceId,
): Promise<AssetImportSelectionOutcome> {
  return invoke("select_asset_image", { workspaceId });
}

export function confirmAssetImport(
  workspaceId: WorkspaceId,
  importId: string,
): Promise<AssetImportResult> {
  return invoke("confirm_asset_import", { workspaceId, importId });
}

export function cancelAssetImport(
  workspaceId: WorkspaceId,
  importId: string,
): Promise<boolean> {
  return invoke("cancel_asset_import", { workspaceId, importId });
}
