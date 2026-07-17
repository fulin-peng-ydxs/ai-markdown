import type {
  DesktopError,
  FsEntry,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
} from "../../services/desktop/contracts";

export type DirectoryLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "cancelled"
  | "error";

export interface DirectoryScanState {
  scanId: string | null;
  status: DirectoryLoadStatus;
  processed: number;
  issues: DesktopError[];
}

export interface WorkspaceTreeState {
  entries: Record<WorkspaceRelativePath, FsEntry>;
  children: Record<string, WorkspaceRelativePath[]>;
  scans: Record<string, DirectoryScanState>;
}

const ROOT_KEY = "";

export function createWorkspaceTreeState(): WorkspaceTreeState {
  return { entries: {}, children: {}, scans: {} };
}

export function beginDirectoryScan(
  state: WorkspaceTreeState,
  start: WorkspaceScanStart,
): WorkspaceTreeState {
  const directory = start.directory ?? ROOT_KEY;
  const entries = { ...state.entries };
  for (const path of Object.keys(entries)) {
    if (isInsideDirectory(path, directory)) {
      delete entries[path];
    }
  }
  const children = { ...state.children };
  for (const parent of Object.keys(children)) {
    if (parent === directory || isInsideDirectory(parent, directory)) {
      delete children[parent];
    }
  }
  return {
    entries,
    children,
    scans: {
      ...state.scans,
      [directory]: {
        scanId: start.scanId,
        status: "loading",
        processed: 0,
        issues: [],
      },
    },
  };
}

export function applyDirectoryScanBatch(
  state: WorkspaceTreeState,
  directory: WorkspaceRelativePath | null,
  batch: WorkspaceScanBatch,
): WorkspaceTreeState {
  const key = directory ?? ROOT_KEY;
  const current = state.scans[key];
  if (!current || current.scanId !== batch.scanId) {
    return state;
  }
  const entries = { ...state.entries };
  const childSet = new Set(state.children[key] ?? []);
  for (const entry of batch.entries) {
    entries[entry.relativePath] = entry;
    childSet.add(entry.relativePath);
  }
  const issues = [...current.issues, ...batch.issues];
  const status: DirectoryLoadStatus = batch.cancelled
    ? "cancelled"
    : batch.complete && issues.length > 0 && childSet.size === 0
      ? "error"
      : batch.complete
        ? "ready"
        : "loading";
  return {
    entries,
    children: { ...state.children, [key]: [...childSet] },
    scans: {
      ...state.scans,
      [key]: {
        scanId: batch.complete ? null : batch.scanId,
        status,
        processed: batch.processed,
        issues,
      },
    },
  };
}

export function markDirectoryScanCancelled(
  state: WorkspaceTreeState,
  directory: WorkspaceRelativePath | null,
  scanId: string,
): WorkspaceTreeState {
  const key = directory ?? ROOT_KEY;
  const current = state.scans[key];
  if (!current || current.scanId !== scanId) {
    return state;
  }
  return {
    ...state,
    scans: {
      ...state.scans,
      [key]: { ...current, scanId: null, status: "cancelled" },
    },
  };
}

function isInsideDirectory(path: string, directory: string): boolean {
  return directory === ROOT_KEY || path.startsWith(`${directory}/`);
}
