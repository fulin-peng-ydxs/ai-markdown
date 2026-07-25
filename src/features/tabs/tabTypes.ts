import {
  getAsyncStatePresentation,
  resolveAsyncState,
  type AsyncState,
  type AsyncStatePresentation,
} from "../../components/asyncState";
import type {
  DesktopError,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import type {
  DocumentSessionState,
  ReadyDocumentSession,
} from "../editor/documentSession";
import type {
  DocumentAnchor,
  EditorMode,
  EditorSelection,
} from "../editor/editorAdapter";
import type { DocumentSaveController } from "../editor/save/DocumentSaveController";
import { parentPath } from "../workbench/workspacePath";
import type {
  WorkspaceTabPath,
  WorkspaceTabPathIdentity,
} from "./tabPath";

export type WorkspaceTabId = string;

export const WORKSPACE_TAB_SETTLEMENT_REASONS = [
  "close_current",
  "close_others",
  "close_right",
  "close_all",
  "replace_workspace",
  "close_window",
  "quit_app",
  "rename_entry",
  "move_entry",
  "delete_entry",
] as const;

export type WorkspaceTabSettlementReason =
  (typeof WORKSPACE_TAB_SETTLEMENT_REASONS)[number];

export type WorkspaceTabLoadState =
  | { kind: "idle"; generation: number }
  | { kind: "loading"; generation: number }
  | { kind: "ready"; generation: number }
  | { kind: "error"; generation: number; error: DesktopError }
  | { kind: "missing"; generation: number; error: DesktopError }
  | {
      kind: "permission_denied";
      generation: number;
      error: DesktopError;
    };

export interface WorkspaceTabViewState {
  mode: EditorMode;
  selection: EditorSelection;
  anchor: DocumentAnchor;
}

export interface WorkspaceTabDescriptor {
  tabId: WorkspaceTabId;
  incarnation: number;
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  pathIdentity: WorkspaceTabPathIdentity;
  displayName: string;
  parentHint: WorkspaceRelativePath | null;
  loadState: WorkspaceTabLoadState;
  restoredView: WorkspaceTabViewState | null;
  lastActivatedAt: number;
}

/**
 * Runtime resources are intentionally kept outside the serializable tab DTO.
 * The active editor adapter is a projection owned by the UI and is never stored
 * here, so a collection can expose at most one mounted editor projection.
 */
export interface WorkspaceTabRuntime {
  incarnation: number;
  session: DocumentSessionState;
  saveController: DocumentSaveController | null;
}

export interface WorkspaceTabProjection {
  tab: WorkspaceTabDescriptor;
  runtime: WorkspaceTabRuntime | null;
}

export interface RecentlyClosedWorkspaceTab {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  pathIdentity: WorkspaceTabPathIdentity;
  displayName: string;
  parentHint: WorkspaceRelativePath | null;
  view: WorkspaceTabViewState | null;
  closedAt: number;
}

export interface WorkspaceTabRecoveryDescriptor {
  relativePath: WorkspaceRelativePath;
  view: WorkspaceTabViewState | null;
  lastActivatedAt: number;
}

export interface WorkspaceTabStatus {
  state: AsyncState;
  presentation: AsyncStatePresentation;
}

export interface WorkspaceTabOpenRequest {
  tabId: WorkspaceTabId;
  workspaceId: WorkspaceId;
  path: WorkspaceTabPath;
  lastActivatedAt: number;
  restoredView?: WorkspaceTabViewState | null;
}

export function deriveWorkspaceTabPathPresentation(
  relativePath: WorkspaceRelativePath,
): Pick<WorkspaceTabDescriptor, "displayName" | "parentHint"> {
  const separator = relativePath.lastIndexOf("/");
  return {
    displayName:
      separator < 0 ? relativePath : relativePath.slice(separator + 1),
    parentHint: parentPath(relativePath),
  };
}

export function createWorkspaceTabDescriptor(
  input: WorkspaceTabOpenRequest,
  incarnation: number,
): WorkspaceTabDescriptor {
  if (!input.tabId.trim()) {
    throw new Error("Workspace tab id must not be empty");
  }
  if (!Number.isSafeInteger(incarnation) || incarnation < 1) {
    throw new Error("Workspace tab incarnation must be a positive integer");
  }
  const presentation = deriveWorkspaceTabPathPresentation(
    input.path.relativePath,
  );
  return {
    tabId: input.tabId,
    incarnation,
    workspaceId: input.workspaceId,
    relativePath: input.path.relativePath,
    pathIdentity: input.path.identity,
    ...presentation,
    loadState: { kind: "idle", generation: 0 },
    restoredView: input.restoredView ?? null,
    lastActivatedAt: input.lastActivatedAt,
  };
}

export function projectWorkspaceTabStatus(
  tab: WorkspaceTabDescriptor,
  runtime: WorkspaceTabRuntime | null,
): WorkspaceTabStatus {
  const states = loadStates(tab.loadState);
  if (tab.loadState.kind === "ready") {
    const matchingRuntime =
      runtime?.incarnation === tab.incarnation ? runtime : null;
    states.push(...sessionStates(matchingRuntime?.session ?? null));
  }
  const state = resolveAsyncState(states);
  return {
    state,
    presentation: getAsyncStatePresentation(state),
  };
}

function loadStates(loadState: WorkspaceTabLoadState): AsyncState[] {
  switch (loadState.kind) {
    case "idle":
      return ["unloaded"];
    case "loading":
      return ["loading"];
    case "ready":
      return ["ready"];
    case "missing":
      return ["missing"];
    case "permission_denied":
      return ["permission_denied"];
    case "error":
      return [stateForDesktopError(loadState.error)];
  }
}

function sessionStates(session: DocumentSessionState | null): AsyncState[] {
  if (!session) return ["error"];
  switch (session.status) {
    case "empty":
      return ["empty"];
    case "loading":
      return ["loading"];
    case "unavailable":
      if (session.error) return [stateForDesktopError(session.error)];
      return [
        session.reason === "unsupported_encoding" ||
        session.reason === "too_large"
          ? "unsupported"
          : "error",
      ];
    case "ready":
      return readySessionStates(session);
  }
}

function readySessionStates(session: ReadyDocumentSession): AsyncState[] {
  const states: AsyncState[] = ["ready"];
  if (session.markdown.length === 0) states.push("empty");
  if (session.compatibility.mode === "source-only") states.push("unsupported");
  if (
    session.recoveryState.kind === "failed" ||
    session.contentSafety.kind === "at_risk"
  ) {
    states.push("error");
  }
  switch (session.saveState.kind) {
    case "clean":
    case "saved":
      break;
    case "dirty":
      states.push("dirty");
      break;
    case "saving":
      states.push("saving");
      if (session.saveState.changedAfterStart) states.push("dirty");
      break;
    case "save_failed":
      states.push(stateForDesktopError(session.saveState.error));
      break;
    case "readonly":
      states.push("readonly");
      break;
    case "conflict":
      states.push("conflict");
      break;
  }
  return states;
}

function stateForDesktopError(error: DesktopError): AsyncState {
  switch (error.code) {
    case "permission_denied":
      return "permission_denied";
    case "path_not_found":
      return "missing";
    case "unsupported_text_encoding":
    case "file_too_large":
      return "unsupported";
    default:
      return "error";
  }
}
