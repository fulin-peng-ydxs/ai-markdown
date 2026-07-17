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
  "window_close_failed",
  "state_unavailable",
  "state_read_failed",
  "state_write_failed",
  "state_backup_failed",
  "unsupported_state_version",
  "invalid_state_data",
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
