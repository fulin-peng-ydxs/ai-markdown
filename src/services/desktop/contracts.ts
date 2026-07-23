export type WorkspaceId = string;
export type WorkspaceRelativePath = string;

export const DESKTOP_ERROR_CODES = [
  "invalid_workspace_id",
  "workspace_not_registered",
  "workspace_already_registered",
  "invalid_selected_root",
  "root_confirmation_required",
  "invalid_relative_path",
  "path_outside_workspace",
  "symlink_not_allowed",
  "path_not_found",
  "permission_denied",
  "not_directory",
  "not_file",
  "io_failure",
  "registry_unavailable",
  "window_not_found",
  "window_create_failed",
  "window_focus_failed",
  "window_title_failed",
  "window_close_failed",
  "state_unavailable",
  "state_read_failed",
  "state_write_failed",
  "state_backup_failed",
  "unsupported_state_version",
  "invalid_state_data",
  "dialog_unavailable",
  "unsupported_markdown_file",
  "selection_not_found",
  "selection_unavailable",
  "selection_confirmation_required",
  "recent_workspace_not_found",
  "scan_not_found",
  "scan_unavailable",
  "watch_not_found",
  "watch_unavailable",
  "file_changed_during_read",
  "file_revision_conflict",
  "unsupported_text_encoding",
  "file_too_large",
  "safe_write_unavailable",
  "safe_write_failed",
  "recovery_unavailable",
  "recovery_read_failed",
  "recovery_write_failed",
  "recovery_unsupported_version",
  "recovery_snapshot_not_found",
  "recovery_snapshot_corrupt",
  "recovery_capacity_exceeded",
  "recovery_session_not_active",
  "recovery_snapshot_protected",
  "editor_save_unavailable",
  "conflict_confirmation_not_found",
  "conflict_content_changed",
  "save_copy_confirmation_not_found",
  "save_copy_target_changed",
  "save_copy_format_required",
  "save_copy_overwrite_confirmation_required",
  "save_copy_failed",
  "preferences_unavailable",
  "preferences_read_failed",
  "preferences_write_failed",
  "preferences_backup_failed",
  "preferences_unsupported_version",
  "invalid_preferences_data",
  "invalid_asset_directory",
  "asset_upload_not_found",
  "asset_import_not_found",
  "asset_unsupported_type",
  "asset_mime_mismatch",
  "asset_too_large",
  "asset_payload_invalid",
  "asset_target_changed",
  "asset_write_failed",
  "invalid_entry_name",
  "reserved_entry_name",
  "target_already_exists",
  "cross_device_move",
  "invalid_move_target",
  "mutation_unavailable",
  "trash_unavailable",
  "permanent_delete_confirmation_not_found",
  "permanent_delete_target_changed",
  "permanent_delete_failed",
  "reveal_unavailable",
] as const;

export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

export interface DesktopError {
  code: DesktopErrorCode;
  messageKey: string;
  pathHint: string | null;
  contentSafe: boolean;
  retryable: boolean;
}

export interface WorkspaceRootResolution {
  selectedPath: string;
  canonicalRoot: string;
  displayName: string;
  rootIsSymlink: boolean;
  requiresConfirmation: boolean;
}

export interface WorkspaceDescriptor {
  id: WorkspaceId;
  selectedPath: string;
  canonicalRoot: string;
  displayName: string;
  writable: boolean;
  initialFile: WorkspaceRelativePath | null;
}

export type FsEntryKind = "markdown_file" | "directory";
export type FsChildrenState =
  | "not_loaded"
  | "loading"
  | "loaded"
  | "unreadable";

export interface FsEntry {
  relativePath: WorkspaceRelativePath;
  name: string;
  kind: FsEntryKind;
  writable: boolean;
  symlink: boolean;
  childrenState: FsChildrenState;
}

export type TextEncoding = "utf8" | "utf8_bom" | "unsupported";
export type LineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

export interface FileRevision {
  modifiedAt: number;
  size: number;
  contentHash: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
}

export const MARKDOWN_READ_STATUSES = [
  "ready",
  "unsupported_encoding",
  "too_large",
] as const;

export type MarkdownReadStatus = (typeof MARKDOWN_READ_STATUSES)[number];

export interface MarkdownReadResult {
  relativePath: WorkspaceRelativePath;
  status: MarkdownReadStatus;
  content: string | null;
  revision: FileRevision;
}

export interface SafeWriteResult {
  relativePath: WorkspaceRelativePath;
  revision: FileRevision;
  bytesWritten: number;
}

export interface RecoverySnapshotMetadata {
  snapshotId: string;
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  baseRevision: FileRevision;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  sizeBytes: number;
}

export interface RecoverySnapshot {
  metadata: RecoverySnapshotMetadata;
  content: string;
}

export const RECOVERY_PERSIST_STATUSES = [
  "persisted",
  "memory_only",
] as const;

export type RecoveryPersistStatus =
  (typeof RECOVERY_PERSIST_STATUSES)[number];

export interface RecoveryUpsertResult {
  status: RecoveryPersistStatus;
  snapshot: RecoverySnapshotMetadata | null;
  issue: DesktopError | null;
}

export interface RecoveryCleanupResult {
  removed: number;
  remaining: number;
  totalBytes: number;
  limitsSatisfied: boolean;
}

export interface ConflictOverwriteProposal {
  confirmationId: string;
  relativePath: WorkspaceRelativePath;
  latestRevision: FileRevision;
  currentContentHash: string;
  targetWritable: boolean;
}

export const SAVE_COPY_FORMAT_CHOICES = [
  "preserve",
  "utf8_lf",
  "utf8_crlf",
  "utf8_cr",
] as const;

export type SaveCopyFormatChoice =
  (typeof SAVE_COPY_FORMAT_CHOICES)[number];

export const SAVE_COPY_SOURCE_KINDS = [
  "workspace_document",
  "new_document",
] as const;

export type SaveCopySourceKind =
  (typeof SAVE_COPY_SOURCE_KINDS)[number];

export type SaveCopySource =
  | {
      kind: "workspace_document";
      workspaceId: WorkspaceId;
      relativePath: WorkspaceRelativePath;
      revision: FileRevision;
    }
  | {
      kind: "new_document";
      suggestedName: string;
    };

export const SAVE_COPY_TARGET_STATES = [
  "new",
  "existing",
] as const;

export type SaveCopyTargetState =
  (typeof SAVE_COPY_TARGET_STATES)[number];

export interface SaveCopyProposal {
  confirmationId: string;
  displayPath: string;
  fileName: string;
  targetState: SaveCopyTargetState;
  targetRevision: FileRevision | null;
  outputEncoding: TextEncoding;
  outputLineEnding: LineEnding;
  workspaceId: WorkspaceId | null;
  relativePath: WorkspaceRelativePath | null;
}

export const SAVE_COPY_SELECTION_STATUSES = [
  "cancelled",
  "ready",
] as const;

export type SaveCopySelectionStatus =
  (typeof SAVE_COPY_SELECTION_STATUSES)[number];

export type SaveCopySelectionOutcome =
  | { status: "cancelled" }
  | { status: "ready"; proposal: SaveCopyProposal };

export interface SaveCopyResult {
  displayPath: string;
  workspaceId: WorkspaceId | null;
  relativePath: WorkspaceRelativePath | null;
  revision: FileRevision;
  bytesWritten: number;
}

export interface WorkspaceScanStart {
  scanId: string;
  workspaceId: WorkspaceId;
  directory: WorkspaceRelativePath | null;
}

export interface WorkspaceScanBatch {
  scanId: string;
  processed: number;
  entries: FsEntry[];
  issues: DesktopError[];
  complete: boolean;
  cancelled: boolean;
}

export const WORKSPACE_WATCH_CHANGE_KINDS = [
  "create",
  "modify",
  "remove",
  "rename",
  "other",
  "rescan_required",
] as const;

export type WorkspaceWatchChangeKind =
  (typeof WORKSPACE_WATCH_CHANGE_KINDS)[number];

export const WORKSPACE_WATCH_EVENT_SOURCES = [
  "external",
  "application",
  "mixed",
] as const;

export type WorkspaceWatchEventSource =
  (typeof WORKSPACE_WATCH_EVENT_SOURCES)[number];

export const WORKSPACE_WATCH_STATUSES = [
  "watching",
  "root_missing",
  "permission_denied",
  "failed",
] as const;

export type WorkspaceWatchStatus =
  (typeof WORKSPACE_WATCH_STATUSES)[number];

export interface WorkspaceWatchStart {
  watchId: string;
  workspaceId: WorkspaceId;
}

export interface WorkspaceWatchEvent {
  kind: WorkspaceWatchChangeKind;
  paths: WorkspaceRelativePath[];
  source: WorkspaceWatchEventSource;
  operationId: string | null;
}

export interface WorkspaceWatchBatch {
  watchId: string;
  sequence: number;
  events: WorkspaceWatchEvent[];
  rescanDirectories: (WorkspaceRelativePath | null)[];
  status: WorkspaceWatchStatus;
  issue: DesktopError | null;
  overflowed: boolean;
  complete: boolean;
}

export const WORKSPACE_MUTATION_KINDS = [
  "create_file",
  "create_directory",
  "rename",
  "move",
] as const;

export type WorkspaceMutationKind =
  (typeof WORKSPACE_MUTATION_KINDS)[number];

export interface WorkspaceMutationResult {
  kind: WorkspaceMutationKind;
  previousPath: WorkspaceRelativePath | null;
  entry: FsEntry;
}

export const WORKSPACE_DELETE_KINDS = [
  "trash",
  "permanent",
] as const;

export type WorkspaceDeleteKind = (typeof WORKSPACE_DELETE_KINDS)[number];

export interface DeleteResult {
  kind: WorkspaceDeleteKind;
  relativePath: WorkspaceRelativePath;
  entryKind: FsEntryKind;
}

export interface PermanentDeleteProposal {
  confirmationId: string;
  relativePath: WorkspaceRelativePath;
  name: string;
  entryKind: FsEntryKind;
  consequenceKey: "confirm.permanentDelete.cannotUndo";
}

export type WorkspaceAvailability =
  | "unchecked"
  | "available"
  | "missing"
  | "permission_denied";

export interface RecentWorkspace {
  workspaceId: WorkspaceId;
  canonicalRoot: string;
  displayName: string;
  lastOpenedAt: number;
  availability: WorkspaceAvailability;
}

export interface WorkspaceSessionRoot {
  workspaceId: WorkspaceId;
  windowLabel: string;
  windowStateRef: string | null;
  lastActiveAt: number;
}

export interface PlainrootStateV1 {
  schemaVersion: 1;
  recentWorkspaces: RecentWorkspace[];
  workspaceSessions: WorkspaceSessionRoot[];
}

export const WORKSPACE_SELECTION_KINDS = [
  "folder",
  "markdown_file",
] as const;

export type WorkspaceSelectionKind =
  (typeof WORKSPACE_SELECTION_KINDS)[number];

export interface WorkspaceSelectionProposal {
  selectionId: string;
  kind: WorkspaceSelectionKind;
  selectedPath: string;
  canonicalRoot: string;
  displayName: string;
  initialFile: WorkspaceRelativePath | null;
  rootIsSymlink: boolean;
  scopeConfirmationRequired: boolean;
  requiresConfirmation: boolean;
}

export const WORKSPACE_SELECTION_STATUSES = [
  "cancelled",
  "already_open",
  "ready",
  "confirmation_required",
] as const;

export type WorkspaceSelectionStatus =
  (typeof WORKSPACE_SELECTION_STATUSES)[number];

export type WorkspaceSelectionOutcome =
  | { status: (typeof WORKSPACE_SELECTION_STATUSES)[0] }
  | {
      status: (typeof WORKSPACE_SELECTION_STATUSES)[1];
      workspaceId: WorkspaceId;
      initialFile: WorkspaceRelativePath | null;
    }
  | {
      status: (typeof WORKSPACE_SELECTION_STATUSES)[2];
      proposal: WorkspaceSelectionProposal;
    }
  | {
      status: (typeof WORKSPACE_SELECTION_STATUSES)[3];
      proposal: WorkspaceSelectionProposal;
    };

export const WORKSPACE_OPEN_DISPOSITIONS = [
  "current_window",
  "new_window",
  "cancel",
] as const;

export type WorkspaceOpenDisposition =
  (typeof WORKSPACE_OPEN_DISPOSITIONS)[number];

export const WORKSPACE_OPEN_STATUSES = [
  "decision_required",
  "opened_current",
  "opened_new",
  "focused_existing",
  "settlement_required",
  "cancelled",
] as const;

export type WorkspaceOpenStatus = (typeof WORKSPACE_OPEN_STATUSES)[number];

export type WorkspaceOpenOutcome =
  | {
      status: (typeof WORKSPACE_OPEN_STATUSES)[0];
      workspace: WorkspaceDescriptor;
      currentWorkspaceId: WorkspaceId;
      currentWorkspaceName: string;
    }
  | {
      status: (typeof WORKSPACE_OPEN_STATUSES)[1];
      workspace: WorkspaceDescriptor;
      windowLabel: string;
    }
  | {
      status: (typeof WORKSPACE_OPEN_STATUSES)[2];
      workspace: WorkspaceDescriptor;
      windowLabel: string;
    }
  | {
      status: (typeof WORKSPACE_OPEN_STATUSES)[3];
      workspaceId: WorkspaceId;
      windowLabel: string;
    }
  | {
      status: (typeof WORKSPACE_OPEN_STATUSES)[4];
      intentId: string;
      workspace: WorkspaceDescriptor;
      windowLabel: string;
    }
  | { status: (typeof WORKSPACE_OPEN_STATUSES)[5] };

export const WINDOW_SETTLEMENT_INTENT_KINDS = [
  "close_window",
  "replace_workspace",
  "quit_app",
] as const;

export type WindowSettlementIntentKind =
  (typeof WINDOW_SETTLEMENT_INTENT_KINDS)[number];

export interface WindowSettlementIntent {
  intentId: string;
  kind: WindowSettlementIntentKind;
  windowLabel: string;
}

export const WINDOW_SETTLEMENT_RESOLUTION_STATUSES = [
  "closed",
  "cancelled",
  "pending",
  "opened_current",
] as const;

export type WindowSettlementResolution =
  | {
      status: (typeof WINDOW_SETTLEMENT_RESOLUTION_STATUSES)[0];
      windowLabel: string;
    }
  | { status: (typeof WINDOW_SETTLEMENT_RESOLUTION_STATUSES)[1] }
  | { status: (typeof WINDOW_SETTLEMENT_RESOLUTION_STATUSES)[2] }
  | {
      status: (typeof WINDOW_SETTLEMENT_RESOLUTION_STATUSES)[3];
      workspace: WorkspaceDescriptor;
      windowLabel: string;
    };

export interface WindowActionResult {
  windowLabel: string;
}

export interface SecondInstanceOpenRequest {
  requestId: number;
  arguments: string[];
  workingDirectory: string;
}

export interface WorkspaceLauncherSnapshot {
  recentWorkspaces: RecentWorkspace[];
  workspaceSessions: WorkspaceSessionRoot[];
  activeWorkspaceIds: WorkspaceId[];
  currentWorkspaceId: WorkspaceId | null;
  windowLabel: string;
}

export interface WorkspaceWorkbenchSnapshot {
  workspace: WorkspaceDescriptor;
  windowLabel: string;
}

export interface WorkspaceAssetPreference {
  workspaceId: WorkspaceId;
  assetDirectory: WorkspaceRelativePath;
}

export const ASSET_IMAGE_KINDS = [
  "png",
  "jpeg",
  "gif",
  "webp",
] as const;

export type AssetImageKind = (typeof ASSET_IMAGE_KINDS)[number];

export interface AssetUploadTicket {
  uploadId: string;
  maxBytes: number;
  acceptedKind: AssetImageKind;
}

export interface AssetImportProposal {
  importId: string;
  workspaceId: WorkspaceId;
  assetPath: WorkspaceRelativePath;
  fileName: string;
  imageKind: AssetImageKind;
  mediaType: string;
  byteLength: number;
}

export const ASSET_IMPORT_SELECTION_STATUSES = [
  "cancelled",
  "ready",
] as const;

export type AssetImportSelectionOutcome =
  | { status: (typeof ASSET_IMPORT_SELECTION_STATUSES)[0] }
  | {
      status: (typeof ASSET_IMPORT_SELECTION_STATUSES)[1];
      proposal: AssetImportProposal;
    };

export interface AssetImportResult {
  workspaceId: WorkspaceId;
  assetPath: WorkspaceRelativePath;
  fileName: string;
  imageKind: AssetImageKind;
  mediaType: string;
  byteLength: number;
}
