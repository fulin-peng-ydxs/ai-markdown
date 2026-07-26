import type { ReadyDocumentSession } from "../editor/documentSession";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import type {
  WorkspaceTabDescriptor,
  WorkspaceTabId,
  WorkspaceTabSettlementReason,
} from "./tabTypes";

export interface WorkspaceTabSettlementTarget {
  tabId: WorkspaceTabId;
  incarnation: number;
}

export interface WorkspaceTabSettlementBatch {
  batchId: string;
  reason: WorkspaceTabSettlementReason;
  targets: readonly WorkspaceTabSettlementTarget[];
}

export type WorkspaceTabExplicitResolution =
  | {
      kind: "discard";
      generation: number;
      editVersion: number;
    }
  | {
      kind: "save_copy";
      generation: number;
      editVersion: number;
      displayPath: string;
    };

export type WorkspaceTabSettlementState =
  | "safe"
  | "dirty"
  | "saving"
  | "save_failed"
  | "conflict"
  | "missing"
  | "readonly"
  | "unavailable"
  | "stale"
  | "resolved_discard"
  | "resolved_copy";

export interface WorkspaceTabSettlementProjection {
  target: WorkspaceTabSettlementTarget;
  tab: WorkspaceTabDescriptor | null;
  session: ReadyDocumentSession | null;
  state: WorkspaceTabSettlementState;
  resolution: WorkspaceTabExplicitResolution | null;
  safe: boolean;
}

export function createWorkspaceTabSettlementBatch(
  snapshot: WorkspaceTabManagerSnapshot,
  tabIds: readonly WorkspaceTabId[],
  reason: WorkspaceTabSettlementReason,
  batchId: string = globalThis.crypto.randomUUID(),
): WorkspaceTabSettlementBatch {
  const unique = new Set(tabIds);
  return {
    batchId,
    reason,
    targets: snapshot.collection.orderedTabIds.flatMap((tabId) => {
      if (!unique.has(tabId)) return [];
      const tab = snapshot.collection.tabsById.get(tabId);
      return tab ? [{ tabId, incarnation: tab.incarnation }] : [];
    }),
  };
}

export function projectWorkspaceTabSettlement(
  batch: WorkspaceTabSettlementBatch,
  snapshot: WorkspaceTabManagerSnapshot,
  resolutions: ReadonlyMap<WorkspaceTabId, WorkspaceTabExplicitResolution>,
): readonly WorkspaceTabSettlementProjection[] {
  return batch.targets.map((target) => {
    const tab = snapshot.collection.tabsById.get(target.tabId) ?? null;
    const runtime = snapshot.runtimes.get(target.tabId) ?? null;
    const session =
      tab?.incarnation === target.incarnation &&
      runtime?.incarnation === target.incarnation &&
      runtime.session.status === "ready"
        ? runtime.session
        : null;
    const requestedResolution = resolutions.get(target.tabId) ?? null;
    const resolution =
      session && requestedResolution &&
      requestedResolution.generation === session.generation &&
      requestedResolution.editVersion === session.editVersion
        ? requestedResolution
        : null;
    const state = projectState(target, tab, session, resolution);
    return {
      target,
      tab,
      session,
      state,
      resolution,
      safe:
        state === "safe" ||
        state === "unavailable" ||
        (state === "missing" && session === null) ||
        state === "resolved_discard" ||
        state === "resolved_copy",
    };
  });
}

export function settlementBatchIsSafe(
  projections: readonly WorkspaceTabSettlementProjection[],
): boolean {
  return projections.length > 0 && projections.every((item) => item.safe);
}

export function settlementResolutionFor(
  session: ReadyDocumentSession,
  resolution:
    | { kind: "discard" }
    | { kind: "save_copy"; displayPath: string },
): WorkspaceTabExplicitResolution {
  return {
    ...resolution,
    generation: session.generation,
    editVersion: session.editVersion,
  };
}

function projectState(
  target: WorkspaceTabSettlementTarget,
  tab: WorkspaceTabDescriptor | null,
  session: ReadyDocumentSession | null,
  resolution: WorkspaceTabExplicitResolution | null,
): WorkspaceTabSettlementState {
  if (!tab || tab.incarnation !== target.incarnation) return "stale";
  if (resolution?.kind === "discard") return "resolved_discard";
  if (resolution?.kind === "save_copy") return "resolved_copy";
  if (!session) {
    return tab.loadState.kind === "missing"
      ? "missing"
      : tab.loadState.kind === "error" ||
          tab.loadState.kind === "permission_denied"
        ? "unavailable"
        : "safe";
  }
  if (
    session.contentSafety.kind === "at_risk" ||
    session.recoveryState.kind === "failed"
  ) {
    return "save_failed";
  }
  switch (session.saveState.kind) {
    case "clean":
    case "saved":
      return "safe";
    case "dirty":
      return "dirty";
    case "saving":
      return "saving";
    case "save_failed":
      return session.saveState.error.code === "path_not_found"
        ? "missing"
        : "save_failed";
    case "conflict":
      return "conflict";
    case "readonly":
      return session.contentSafety.kind === "disk" ? "safe" : "readonly";
  }
}
