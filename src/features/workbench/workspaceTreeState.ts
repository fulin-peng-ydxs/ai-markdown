import type {
  DesktopError,
  FsEntry,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
  WorkspaceMutationKind,
  WorkspaceMutationResult,
  DeleteResult,
  WorkspaceDeleteKind,
  WorkspaceWatchBatch,
  WorkspaceWatchStart,
  WorkspaceWatchStatus,
} from "../../services/desktop/contracts";
import { isSameOrInside, parentPath, replacePrefix } from "./workspacePath.ts";

export type DirectoryLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "cancelled"
  | "error";

export interface DirectoryScanState {
  scanId: string | null;
  mode: "replace" | "reconcile";
  status: DirectoryLoadStatus;
  processed: number;
  issues: DesktopError[];
  discoveredPaths: WorkspaceRelativePath[];
}

export interface WorkspaceTreeState {
  entries: Record<WorkspaceRelativePath, FsEntry>;
  children: Record<string, WorkspaceRelativePath[]>;
  scans: Record<string, DirectoryScanState>;
  mutation: WorkspaceTreeMutationState | null;
  watch: WorkspaceTreeWatchState;
}

export interface WorkspaceTreeWatchState {
  watchId: string | null;
  status: "idle" | WorkspaceWatchStatus;
  sequence: number;
  issue: DesktopError | null;
  rescanDirectories: string[];
  overflowed: boolean;
}

export interface WorkspaceTreeMutationState {
  id: string;
  kind: WorkspaceMutationKind | WorkspaceDeleteKind;
  sourcePath: WorkspaceRelativePath | null;
  status: "processing" | "failed";
  error: DesktopError | null;
}

const ROOT_KEY = "";

export function createWorkspaceTreeState(): WorkspaceTreeState {
  return {
    entries: {},
    children: {},
    scans: {},
    mutation: null,
    watch: {
      watchId: null,
      status: "idle",
      sequence: 0,
      issue: null,
      rescanDirectories: [],
      overflowed: false,
    },
  };
}

export function beginWorkspaceWatch(
  state: WorkspaceTreeState,
  start: WorkspaceWatchStart,
): WorkspaceTreeState {
  return {
    ...state,
    watch: {
      watchId: start.watchId,
      status: "watching",
      sequence: 0,
      issue: null,
      rescanDirectories: [],
      overflowed: false,
    },
  };
}

export function applyWorkspaceWatchBatch(
  state: WorkspaceTreeState,
  batch: WorkspaceWatchBatch,
): WorkspaceTreeState {
  if (
    state.watch.watchId !== batch.watchId ||
    batch.sequence < state.watch.sequence
  ) {
    return state;
  }
  const terminal = batch.complete && batch.status !== "watching";
  const accessBlocked =
    batch.status === "root_missing" || batch.status === "permission_denied";
  const queuedDirectories = terminal
    ? []
    : [
        ...new Set([
          ...state.watch.rescanDirectories,
          ...batch.rescanDirectories.map((directory) => directory ?? ROOT_KEY),
        ]),
      ];
  return {
    ...state,
    entries: terminal && accessBlocked ? {} : state.entries,
    children: terminal && accessBlocked ? {} : state.children,
    scans: terminal && accessBlocked ? {} : state.scans,
    watch: {
      watchId: terminal ? null : batch.watchId,
      status: batch.status,
      sequence: batch.sequence,
      issue: batch.issue,
      rescanDirectories: queuedDirectories,
      overflowed: state.watch.overflowed || batch.overflowed,
    },
  };
}

export function acknowledgeWorkspaceWatchRescan(
  state: WorkspaceTreeState,
  directory: WorkspaceRelativePath | null,
): WorkspaceTreeState {
  const key = directory ?? ROOT_KEY;
  if (!state.watch.rescanDirectories.includes(key)) {
    return state;
  }
  return {
    ...state,
    watch: {
      ...state.watch,
      rescanDirectories: state.watch.rescanDirectories.filter(
        (candidate) => candidate !== key,
      ),
    },
  };
}

export function beginWorkspaceWatchRescan(
  state: WorkspaceTreeState,
  start: WorkspaceScanStart,
): WorkspaceTreeState {
  const directory = start.directory ?? ROOT_KEY;
  const acknowledged = acknowledgeWorkspaceWatchRescan(state, start.directory);
  return {
    ...acknowledged,
    scans: {
      ...acknowledged.scans,
      [directory]: {
        scanId: start.scanId,
        mode: "reconcile",
        status: "loading",
        processed: 0,
        issues: [],
        discoveredPaths: [],
      },
    },
  };
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
    ...state,
    entries,
    children,
    scans: {
      ...state.scans,
      [directory]: {
        scanId: start.scanId,
        mode: "replace",
        status: "loading",
        processed: 0,
        issues: [],
        discoveredPaths: [],
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
  const children = { ...state.children };
  const previousChildren = new Set(state.children[key] ?? []);
  const discovered = new Set(
    current.mode === "reconcile"
      ? current.discoveredPaths
      : state.children[key] ?? [],
  );
  for (const entry of batch.entries) {
    entries[entry.relativePath] = entry;
    discovered.add(entry.relativePath);
  }
  const issues = [...current.issues, ...batch.issues];
  if (current.mode === "replace") {
    children[key] = [...discovered];
  } else if (batch.complete && !batch.cancelled) {
    if (issues.length === 0) {
      for (const previous of previousChildren) {
        if (discovered.has(previous)) {
          continue;
        }
        for (const path of Object.keys(entries)) {
          if (isSameOrInside(path, previous)) {
            delete entries[path];
          }
        }
        for (const parent of Object.keys(children)) {
          if (isSameOrInside(parent, previous)) {
            delete children[parent];
          }
        }
      }
      children[key] = [...discovered];
    } else {
      // A partial scan cannot prove that a missing child was deleted. Preserve the last safe
      // snapshot and merge only entries that were actually observed until the user retries.
      children[key] = [...new Set([...previousChildren, ...discovered])];
    }
  }
  const visibleChildren = children[key] ?? [];
  const status: DirectoryLoadStatus = batch.cancelled
    ? "cancelled"
    : batch.complete && issues.length > 0 && visibleChildren.length === 0
      ? "error"
      : batch.complete
        ? "ready"
        : "loading";
  const watch = { ...state.watch };
  if (current.mode === "reconcile" && batch.complete) {
    if (batch.cancelled || issues.length > 0) {
      watch.rescanDirectories = [
        ...new Set([...watch.rescanDirectories, key]),
      ];
    } else if (key === ROOT_KEY) {
      watch.overflowed = false;
    }
  }
  return {
    ...state,
    entries,
    children,
    watch,
    scans: {
      ...state.scans,
      [key]: {
        scanId: batch.complete ? null : batch.scanId,
        mode: current.mode,
        status,
        processed: batch.processed,
        issues,
        discoveredPaths: [...discovered],
      },
    },
  };
}

export function beginWorkspaceTreeMutation(
  state: WorkspaceTreeState,
  id: string,
  kind: WorkspaceMutationKind | WorkspaceDeleteKind,
  sourcePath: WorkspaceRelativePath | null,
): WorkspaceTreeState {
  return {
    ...state,
    mutation: { id, kind, sourcePath, status: "processing", error: null },
  };
}

export function applyWorkspaceTreeMutationSuccess(
  state: WorkspaceTreeState,
  id: string,
  result: WorkspaceMutationResult,
): WorkspaceTreeState {
  if (!state.mutation || state.mutation.id !== id) {
    return state;
  }
  const previousPath = result.previousPath;
  const nextPath = result.entry.relativePath;
  const entries: Record<WorkspaceRelativePath, FsEntry> = {};
  for (const [path, entry] of Object.entries(state.entries)) {
    const mapped = previousPath ? replacePrefix(path, previousPath, nextPath) : path;
    entries[mapped] = path === previousPath ? result.entry : { ...entry, relativePath: mapped };
  }
  entries[nextPath] = result.entry;

  const children: Record<string, WorkspaceRelativePath[]> = {};
  const previousParent = previousPath
    ? (parentPath(previousPath) ?? ROOT_KEY)
    : null;
  const nextParent = parentPath(nextPath) ?? ROOT_KEY;
  for (const [parent, paths] of Object.entries(state.children)) {
    const mappedParent = previousPath
      ? replacePrefix(parent, previousPath, nextPath)
      : parent;
    const mappedPaths = paths.map((path) =>
      previousPath ? replacePrefix(path, previousPath, nextPath) : path,
    );
    children[mappedParent] =
      previousParent !== null && previousParent !== nextParent && parent === previousParent
        ? mappedPaths.filter((path) => path !== nextPath)
        : mappedPaths;
  }
  if (!previousPath || previousParent !== nextParent) {
    children[nextParent] = [
      ...new Set([...(children[nextParent] ?? []), nextPath]),
    ];
  }

  const affectedParents = new Set([
    previousParent ?? nextParent,
    nextParent,
  ]);
  const scans = Object.fromEntries(
    Object.entries(state.scans).filter(
      ([directory]) =>
        !affectedParents.has(directory) &&
        (!previousPath || !isSameOrInside(directory, previousPath)) &&
        !isSameOrInside(directory, nextPath),
    ),
  );
  return { ...state, entries, children, scans, mutation: null };
}

export function applyWorkspaceTreeMutationFailure(
  state: WorkspaceTreeState,
  id: string,
  error: DesktopError,
): WorkspaceTreeState {
  if (!state.mutation || state.mutation.id !== id) {
    return state;
  }
  return {
    ...state,
    mutation: { ...state.mutation, status: "failed", error },
  };
}

export function applyWorkspaceTreeDeleteSuccess(
  state: WorkspaceTreeState,
  id: string,
  result: DeleteResult,
): WorkspaceTreeState {
  if (!state.mutation || state.mutation.id !== id) {
    return state;
  }
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(
      ([path]) => !isSameOrInside(path, result.relativePath),
    ),
  );
  const children = Object.fromEntries(
    Object.entries(state.children)
      .filter(([parent]) => !isSameOrInside(parent, result.relativePath))
      .map(([parent, paths]) => [
        parent,
        paths.filter((path) => !isSameOrInside(path, result.relativePath)),
      ]),
  );
  const scans = Object.fromEntries(
    Object.entries(state.scans).filter(
      ([directory]) =>
        directory !== (parentPath(result.relativePath) ?? ROOT_KEY) &&
        !isSameOrInside(directory, result.relativePath),
    ),
  );
  return { ...state, entries, children, scans, mutation: null };
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
