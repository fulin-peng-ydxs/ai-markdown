import type {
  DesktopError,
  FileRevision,
  LineEnding,
  MarkdownReadResult,
  TextEncoding,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  createDocumentHistory,
  recordDocumentChange,
  redoDocumentHistory,
  undoDocumentHistory,
  type DocumentHistory,
} from "./documentHistory";
import type {
  DocumentAnchor,
  EditorMode,
  EditorSelection,
} from "./editorAdapter";
import type { VisualEditingCompatibility } from "./markdownCompatibility";

export interface DocumentIdentity {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
}

export interface DocumentSourceFormat {
  encoding: TextEncoding;
  lineEnding: LineEnding;
}

export type DocumentSaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | {
      kind: "saving";
      requestId: string;
      editVersion: number;
      changedAfterStart: boolean;
    }
  | { kind: "saved"; savedAt: number }
  | { kind: "save_failed"; error: DesktopError }
  | { kind: "readonly"; reason: "workspace" | "unsupported_encoding" | "too_large" }
  | { kind: "conflict"; evidenceId: string };

export type DocumentContentSafety =
  | { kind: "disk" }
  | { kind: "memory" }
  | { kind: "recovery"; snapshotId: string }
  | { kind: "at_risk"; reason: string };

export type DocumentRecoveryState =
  | { kind: "none" }
  | { kind: "available"; snapshotId: string }
  | { kind: "persisting" }
  | { kind: "failed"; error: DesktopError };

export interface DocumentConflictEvidence {
  evidenceId: string;
  diskRevision: FileRevision;
}

export interface ReadyDocumentSession extends DocumentIdentity {
  status: "ready";
  generation: number;
  markdown: string;
  diskRevision: FileRevision;
  persistedContentHash: string;
  sourceFormat: DocumentSourceFormat;
  editVersion: number;
  mode: EditorMode;
  saveState: DocumentSaveState;
  contentSafety: DocumentContentSafety;
  selection: EditorSelection;
  anchor: DocumentAnchor;
  history: DocumentHistory;
  compatibility: VisualEditingCompatibility;
  recoveryState: DocumentRecoveryState;
  conflictEvidence: DocumentConflictEvidence | null;
}

export type DocumentSessionState =
  | { status: "empty"; generation: number }
  | ({ status: "loading"; generation: number } & DocumentIdentity)
  | ReadyDocumentSession
  | ({
      status: "unavailable";
      generation: number;
      reason: "unsupported_encoding" | "too_large" | "read_failed";
      revision: FileRevision | null;
      error: DesktopError | null;
    } & DocumentIdentity);

export interface DocumentEditTransaction {
  generation: number;
  expectedEditVersion: number;
  markdown: string;
  selection: EditorSelection;
  anchor: DocumentAnchor;
  mode: EditorMode;
  transactionGroup: string | null;
}

export type SessionMutationResult =
  | { status: "applied"; session: ReadyDocumentSession }
  | { status: "stale"; session: ReadyDocumentSession }
  | { status: "readonly"; session: ReadyDocumentSession }
  | { status: "mode_unavailable"; session: ReadyDocumentSession }
  | { status: "save_in_flight"; session: ReadyDocumentSession }
  | { status: "history_unavailable"; session: ReadyDocumentSession };

export function createEmptyDocumentSession(generation = 0): DocumentSessionState {
  return { status: "empty", generation };
}

export function beginDocumentLoad(
  previous: DocumentSessionState,
  identity: DocumentIdentity,
): DocumentSessionState {
  return {
    status: "loading",
    generation: previous.generation + 1,
    ...identity,
  };
}

export function resolveDocumentRead(
  current: DocumentSessionState,
  generation: number,
  result: MarkdownReadResult,
  compatibility: VisualEditingCompatibility,
  writable: boolean,
  historyOptions: { maxBytes?: number; maxEntries?: number } = {},
): DocumentSessionState {
  if (
    current.status !== "loading" ||
    current.generation !== generation ||
    current.relativePath !== result.relativePath
  ) {
    return current;
  }

  if (
    result.status !== "ready" ||
    result.content === null ||
    result.revision.encoding === "unsupported"
  ) {
    return {
      status: "unavailable",
      generation,
      workspaceId: current.workspaceId,
      relativePath: current.relativePath,
      reason:
        result.revision.encoding === "unsupported"
          ? "unsupported_encoding"
          : result.status === "ready"
            ? "read_failed"
            : result.status,
      revision: result.revision,
      error: null,
    };
  }

  const effectiveCompatibility: VisualEditingCompatibility =
    result.revision.lineEnding === "mixed"
      ? {
          mode: "source-only",
          reasons: [...new Set([...compatibility.reasons, "mixed-line-endings"])].sort(),
        }
      : compatibility;
  const mode: EditorMode =
    effectiveCompatibility.mode === "source-only" ? "source" : "visual";
  const selection = initialSelection(mode);
  return {
    status: "ready",
    generation,
    workspaceId: current.workspaceId,
    relativePath: current.relativePath,
    markdown: result.content,
    diskRevision: result.revision,
    persistedContentHash: result.revision.contentHash,
    sourceFormat: sourceFormatFromRevision(result.revision),
    editVersion: 0,
    mode,
    saveState: writable
      ? { kind: "clean" }
      : { kind: "readonly", reason: "workspace" },
    contentSafety: { kind: "disk" },
    selection,
    anchor: initialAnchor(mode),
    history: createDocumentHistory(historyOptions),
    compatibility: effectiveCompatibility,
    recoveryState: { kind: "none" },
    conflictEvidence: null,
  };
}

export function rejectDocumentRead(
  current: DocumentSessionState,
  generation: number,
  error: DesktopError,
): DocumentSessionState {
  if (current.status !== "loading" || current.generation !== generation) {
    return current;
  }
  return {
    status: "unavailable",
    generation,
    workspaceId: current.workspaceId,
    relativePath: current.relativePath,
    reason: "read_failed",
    revision: null,
    error,
  };
}

export function applyDocumentEdit(
  session: ReadyDocumentSession,
  transaction: DocumentEditTransaction,
): SessionMutationResult {
  if (
    transaction.generation !== session.generation ||
    transaction.expectedEditVersion !== session.editVersion
  ) {
    return { status: "stale", session };
  }
  if (
    transaction.mode === "visual" &&
    session.compatibility.mode === "source-only"
  ) {
    return { status: "mode_unavailable", session };
  }
  if (transaction.markdown === session.markdown) {
    return {
      status: "applied",
      session: {
        ...session,
        mode: transaction.mode,
        selection: transaction.selection,
        anchor: transaction.anchor,
      },
    };
  }
  if (session.saveState.kind === "readonly") {
    return { status: "readonly", session };
  }

  const history = recordDocumentChange(session.history, {
    beforeMarkdown: session.markdown,
    afterMarkdown: transaction.markdown,
    beforeSelection: session.selection,
    afterSelection: transaction.selection,
    beforeMode: session.mode,
    afterMode: transaction.mode,
    transactionGroup: transaction.transactionGroup,
  });
  const saveState = saveStateAfterContentChange(session.saveState);
  return {
    status: "applied",
    session: {
      ...session,
      markdown: transaction.markdown,
      editVersion: session.editVersion + 1,
      mode: transaction.mode,
      selection: transaction.selection,
      anchor: transaction.anchor,
      history,
      saveState,
      contentSafety: { kind: "memory" },
    },
  };
}

export function reassessDocumentCompatibility(
  session: ReadyDocumentSession,
  generation: number,
  expectedEditVersion: number,
  compatibility: VisualEditingCompatibility,
): SessionMutationResult {
  if (
    generation !== session.generation ||
    expectedEditVersion !== session.editVersion
  ) {
    return { status: "stale", session };
  }
  const effectiveCompatibility = compatibilityForCurrentMarkdown(
    session.markdown,
    compatibility,
  );
  const forcesSourceMode =
    session.mode === "visual" &&
    effectiveCompatibility.mode === "source-only";
  const sourceOffset =
    session.selection.kind === "visual"
      ? session.selection.from
      : session.selection.head;
  return {
    status: "applied",
    session: {
      ...session,
      compatibility: effectiveCompatibility,
      mode: forcesSourceMode ? "source" : session.mode,
      selection: forcesSourceMode
        ? { kind: "source", anchor: sourceOffset, head: sourceOffset }
        : session.selection,
      anchor: forcesSourceMode
        ? {
            kind: "source",
            offset: sourceOffset,
            scrollTop: session.anchor.scrollTop,
          }
        : session.anchor,
    },
  };
}

export function undoDocumentSession(
  session: ReadyDocumentSession,
): SessionMutationResult {
  if (session.saveState.kind === "readonly") {
    return { status: "readonly", session };
  }
  const result = undoDocumentHistory(session.history, session.markdown);
  if (result.status !== "applied") {
    return { status: "history_unavailable", session };
  }
  return {
    status: "applied",
    session: {
      ...session,
      markdown: result.markdown,
      editVersion: session.editVersion + 1,
      selection: result.selection,
      mode: result.mode,
      anchor: anchorFromSelection(result.selection),
      history: result.history,
      // Without a matching Rust revision result, undo remains conservatively dirty.
      saveState: saveStateAfterContentChange(session.saveState),
      contentSafety: { kind: "memory" },
    },
  };
}

export function redoDocumentSession(
  session: ReadyDocumentSession,
): SessionMutationResult {
  if (session.saveState.kind === "readonly") {
    return { status: "readonly", session };
  }
  const result = redoDocumentHistory(session.history, session.markdown);
  if (result.status !== "applied") {
    return { status: "history_unavailable", session };
  }
  return {
    status: "applied",
    session: {
      ...session,
      markdown: result.markdown,
      editVersion: session.editVersion + 1,
      selection: result.selection,
      mode: result.mode,
      anchor: anchorFromSelection(result.selection),
      history: result.history,
      saveState: saveStateAfterContentChange(session.saveState),
      contentSafety: { kind: "memory" },
    },
  };
}

export function beginDocumentSave(
  session: ReadyDocumentSession,
  requestId: string,
): SessionMutationResult {
  if (session.saveState.kind === "readonly") {
    return { status: "readonly", session };
  }
  if (session.saveState.kind === "saving") {
    return { status: "save_in_flight", session };
  }
  if (session.saveState.kind === "conflict") {
    return { status: "stale", session };
  }
  return {
    status: "applied",
    session: {
      ...session,
      saveState: {
        kind: "saving",
        requestId,
        editVersion: session.editVersion,
        changedAfterStart: false,
      },
    },
  };
}

export function completeDocumentSave(
  session: ReadyDocumentSession,
  requestId: string,
  revision: FileRevision,
  savedAt: number,
): SessionMutationResult {
  if (
    session.saveState.kind !== "saving" ||
    session.saveState.requestId !== requestId
  ) {
    return { status: "stale", session };
  }
  const changedAfterStart =
    session.saveState.changedAfterStart ||
    session.editVersion !== session.saveState.editVersion;
  return {
    status: "applied",
    session: {
      ...session,
      diskRevision: revision,
      persistedContentHash: revision.contentHash,
      sourceFormat: sourceFormatFromRevision(revision),
      saveState: changedAfterStart ? { kind: "dirty" } : { kind: "saved", savedAt },
      contentSafety: changedAfterStart ? { kind: "memory" } : { kind: "disk" },
      recoveryState: changedAfterStart ? session.recoveryState : { kind: "none" },
    },
  };
}

export function failDocumentSave(
  session: ReadyDocumentSession,
  requestId: string,
  error: DesktopError,
): SessionMutationResult {
  if (
    session.saveState.kind !== "saving" ||
    session.saveState.requestId !== requestId
  ) {
    return { status: "stale", session };
  }
  return {
    status: "applied",
    session: {
      ...session,
      saveState: { kind: "save_failed", error },
      contentSafety:
        session.recoveryState.kind === "available"
          ? { kind: "recovery", snapshotId: session.recoveryState.snapshotId }
          : { kind: "memory" },
    },
  };
}

export function sourceFormatFromRevision(
  revision: FileRevision,
): DocumentSourceFormat {
  return { encoding: revision.encoding, lineEnding: revision.lineEnding };
}

export function lineEndingFromMarkdown(markdown: string): LineEnding {
  let hasLf = false;
  let hasCrLf = false;
  let hasCr = false;
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code === 0x0d) {
      if (markdown.charCodeAt(index + 1) === 0x0a) {
        hasCrLf = true;
        index += 1;
      } else {
        hasCr = true;
      }
    } else if (code === 0x0a) {
      hasLf = true;
    }
    if (Number(hasLf) + Number(hasCrLf) + Number(hasCr) > 1) return "mixed";
  }
  if (hasCrLf) return "crlf";
  if (hasCr) return "cr";
  if (hasLf) return "lf";
  return "none";
}

function initialSelection(mode: EditorMode): EditorSelection {
  return mode === "visual"
    ? { kind: "visual", from: 0, to: 0 }
    : { kind: "source", anchor: 0, head: 0 };
}

function initialAnchor(mode: EditorMode): DocumentAnchor {
  return mode === "visual"
    ? { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 }
    : { kind: "source", offset: 0, scrollTop: 0 };
}

function anchorFromSelection(selection: EditorSelection): DocumentAnchor {
  return selection.kind === "visual"
    ? {
        kind: "semantic",
        blockId: null,
        fallbackOffset: selection.from,
        scrollTop: 0,
      }
    : { kind: "source", offset: selection.head, scrollTop: 0 };
}

function saveStateAfterContentChange(
  saveState: DocumentSaveState,
): DocumentSaveState {
  return saveState.kind === "saving"
    ? { ...saveState, changedAfterStart: true }
    : { kind: "dirty" };
}

function compatibilityForCurrentMarkdown(
  markdown: string,
  compatibility: VisualEditingCompatibility,
): VisualEditingCompatibility {
  if (lineEndingFromMarkdown(markdown) !== "mixed") return compatibility;
  return {
    mode: "source-only",
    reasons: [...new Set([...compatibility.reasons, "mixed-line-endings"])].sort(),
  };
}
