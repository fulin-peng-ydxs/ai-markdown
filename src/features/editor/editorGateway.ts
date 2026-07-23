import type {
  DesktopError,
  FileRevision,
  MarkdownReadResult,
  RecoveryCleanupResult,
  RecoverySnapshot,
  RecoverySnapshotMetadata,
  RecoveryUpsertResult,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import { DESKTOP_ERROR_CODES } from "../../services/desktop/contracts";
import {
  cleanupRecoverySnapshots,
  deleteRecoverySnapshot,
  getRecoverySnapshot,
  listRecoverySnapshots,
  registerActiveRecoverySession,
  releaseActiveRecoverySession,
  upsertRecoverySnapshot,
} from "../../services/desktop/recovery";
import {
  rejectDocumentRead,
  resolveDocumentRead,
  type DocumentSessionState,
} from "./documentSession";
import type {
  MarkdownParseEvidence,
  VisualEditingCompatibility,
} from "./markdownCompatibility";
import { assessVisualEditingCompatibility } from "./markdownCompatibility";

export interface EditorDocumentGateway {
  read(
    workspaceId: WorkspaceId,
    path: WorkspaceRelativePath,
  ): Promise<MarkdownReadResult>;
}

export interface EditorRecoveryGateway {
  list(): Promise<RecoverySnapshotMetadata[]>;
  get(
    snapshotId: string,
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<RecoverySnapshot>;
  registerActive(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<boolean>;
  releaseActive(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<boolean>;
  upsert(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
    content: string,
    baseRevision: FileRevision,
  ): Promise<RecoveryUpsertResult>;
  delete(snapshotId: string, workspaceId: WorkspaceId): Promise<boolean>;
  cleanup(): Promise<RecoveryCleanupResult>;
}

export const desktopRecoveryGateway: EditorRecoveryGateway = {
  list: listRecoverySnapshots,
  get: getRecoverySnapshot,
  registerActive: registerActiveRecoverySession,
  releaseActive: releaseActiveRecoverySession,
  upsert: upsertRecoverySnapshot,
  delete: deleteRecoverySnapshot,
  cleanup: cleanupRecoverySnapshots,
};

export interface MarkdownCompatibilityParser {
  parse(markdown: string): Promise<MarkdownParseEvidence>;
}

export interface DocumentLoadRequest {
  generation: number;
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  writable: boolean;
}

export type DocumentLoadOutcome =
  | {
      status: "loaded";
      request: DocumentLoadRequest;
      read: MarkdownReadResult;
      compatibility: VisualEditingCompatibility;
    }
  | {
      status: "failed";
      request: DocumentLoadRequest;
      error: DesktopError;
    };

export async function requestDocumentLoad(
  request: DocumentLoadRequest,
  gateway: EditorDocumentGateway,
  parser: MarkdownCompatibilityParser,
): Promise<DocumentLoadOutcome> {
  try {
    const read = await gateway.read(request.workspaceId, request.relativePath);
    let compatibility: VisualEditingCompatibility = {
      mode: "source-only",
      reasons: ["content-unavailable"],
    };
    if (read.status === "ready" && read.content !== null) {
      try {
        compatibility = assessVisualEditingCompatibility(
          await parser.parse(read.content),
        );
      } catch {
        compatibility = { mode: "source-only", reasons: ["parse-error"] };
      }
    }
    return { status: "loaded", request, read, compatibility };
  } catch (error: unknown) {
    return { status: "failed", request, error: toDesktopError(error) };
  }
}

export function applyDocumentLoadOutcome(
  current: DocumentSessionState,
  outcome: DocumentLoadOutcome,
): DocumentSessionState {
  if (
    current.status !== "loading" ||
    current.generation !== outcome.request.generation ||
    current.workspaceId !== outcome.request.workspaceId ||
    current.relativePath !== outcome.request.relativePath
  ) {
    return current;
  }
  return outcome.status === "loaded"
    ? resolveDocumentRead(
        current,
        outcome.request.generation,
        outcome.read,
        outcome.compatibility,
        outcome.request.writable,
      )
    : rejectDocumentRead(
        current,
        outcome.request.generation,
        outcome.error,
      );
}

function toDesktopError(error: unknown): DesktopError {
  if (isDesktopError(error)) return error;
  return {
    code: "io_failure" as const,
    messageKey: "error.desktop.io_failure",
    pathHint: null,
    contentSafe: true,
    retryable: true,
  };
}

function isDesktopError(error: unknown): error is DesktopError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    (DESKTOP_ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.messageKey === "string" &&
    (typeof candidate.pathHint === "string" || candidate.pathHint === null) &&
    typeof candidate.contentSafe === "boolean" &&
    typeof candidate.retryable === "boolean"
  );
}
