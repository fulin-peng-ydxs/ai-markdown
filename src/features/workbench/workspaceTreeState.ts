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
  mutation: WorkspaceTreeMutationState | null;
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
  return { entries: {}, children: {}, scans: {}, mutation: null };
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
    mutation: state.mutation,
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
    mutation: state.mutation,
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
    const mapped = previousPath ? replacePathPrefix(path, previousPath, nextPath) : path;
    entries[mapped] = path === previousPath ? result.entry : { ...entry, relativePath: mapped };
  }
  entries[nextPath] = result.entry;

  const children: Record<string, WorkspaceRelativePath[]> = {};
  const previousParent = previousPath ? parentPath(previousPath) : null;
  const nextParent = parentPath(nextPath);
  for (const [parent, paths] of Object.entries(state.children)) {
    const mappedParent = previousPath
      ? replacePathPrefix(parent, previousPath, nextPath)
      : parent;
    const mappedPaths = paths.map((path) =>
      previousPath ? replacePathPrefix(path, previousPath, nextPath) : path,
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
  return { entries, children, scans, mutation: null };
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
        directory !== parentPath(result.relativePath) &&
        !isSameOrInside(directory, result.relativePath),
    ),
  );
  return { entries, children, scans, mutation: null };
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

function isSameOrInside(path: string, directory: string): boolean {
  return path === directory || isInsideDirectory(path, directory);
}

function replacePathPrefix(
  path: string,
  previousPath: string,
  nextPath: string,
): string {
  if (path === previousPath) {
    return nextPath;
  }
  return path.startsWith(`${previousPath}/`)
    ? `${nextPath}${path.slice(previousPath.length)}`
    : path;
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT_KEY;
}
