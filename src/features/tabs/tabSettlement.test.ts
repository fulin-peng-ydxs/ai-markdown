import { describe, expect, it } from "vitest";

import {
  createDocumentHistory,
} from "../editor/documentHistory";
import type { ReadyDocumentSession } from "../editor/documentSession";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { acceptWorkspaceTabPath } from "./tabPath";
import {
  createWorkspaceTabSettlementBatch,
  projectWorkspaceTabSettlement,
  settlementBatchIsSafe,
  settlementResolutionFor,
} from "./tabSettlement";
import type {
  WorkspaceTabDescriptor,
  WorkspaceTabRuntime,
} from "./tabTypes";

function snapshot(
  session: WorkspaceTabRuntime["session"],
): WorkspaceTabManagerSnapshot {
  const path = acceptWorkspaceTabPath({
    relativePath: "note.md",
    identity: "native:note.md",
  });
  const tab: WorkspaceTabDescriptor = {
    tabId: "tab-a",
    incarnation: 1,
    workspaceId: "workspace-a",
    relativePath: path.relativePath,
    pathIdentity: path.identity,
    displayName: "note.md",
    parentHint: null,
    loadState: { kind: "ready", generation: 1 },
    restoredView: null,
    lastActivatedAt: 1,
  };
  const runtime: WorkspaceTabRuntime = {
    incarnation: 1,
    session,
    saveController: null,
  };
  return {
    collection: {
      workspaceId: "workspace-a",
      orderedTabIds: ["tab-a"],
      activeTabId: "tab-a",
      tabsById: new Map([["tab-a", tab]]),
      pathIndex: new Map([[path.identity, "tab-a"]]),
      recentlyClosed: [],
      nextIncarnation: 2,
      revision: 1,
      persistedRevision: 0,
    },
    runtimes: new Map([["tab-a", runtime]]),
    activeTab: tab,
    activeRuntime: runtime,
  };
}

const ready: ReadyDocumentSession = {
  status: "ready" as const,
  generation: 1,
  workspaceId: "workspace-a",
  relativePath: "note.md",
  markdown: "# note",
  diskRevision: {
    modifiedAt: 1,
    size: 6,
    contentHash: "disk",
    encoding: "utf8" as const,
    lineEnding: "lf" as const,
  },
  persistedContentHash: "disk",
  sourceFormat: { encoding: "utf8" as const, lineEnding: "lf" as const },
  editVersion: 2,
  mode: "source" as const,
  saveState: { kind: "dirty" as const },
  contentSafety: { kind: "memory" as const },
  selection: { kind: "source" as const, anchor: 0, head: 0 },
  anchor: { kind: "source" as const, offset: 0, scrollTop: 0 },
  history: createDocumentHistory({ maxBytes: 1, maxEntries: 1 }),
  compatibility: { mode: "visual", reasons: [] },
  recoveryState: { kind: "none" as const },
  conflictEvidence: null,
};

describe("tab settlement", () => {
  it("requires an explicit safe destination for dirty content", () => {
    const current = snapshot(ready);
    const batch = createWorkspaceTabSettlementBatch(
      current,
      ["tab-a"],
      "close_current",
      "batch-a",
    );
    const blocked = projectWorkspaceTabSettlement(batch, current, new Map());
    expect(blocked[0]?.state).toBe("dirty");
    expect(settlementBatchIsSafe(blocked)).toBe(false);

    const resolution = settlementResolutionFor(ready, { kind: "discard" });
    const resolved = projectWorkspaceTabSettlement(
      batch,
      current,
      new Map([["tab-a", resolution]]),
    );
    expect(resolved[0]?.state).toBe("resolved_discard");
    expect(settlementBatchIsSafe(resolved)).toBe(true);
  });

  it("invalidates discard or saved-copy evidence after another edit", () => {
    const current = snapshot(ready);
    const batch = createWorkspaceTabSettlementBatch(
      current,
      ["tab-a"],
      "close_current",
      "batch-a",
    );
    const resolution = settlementResolutionFor(ready, {
      kind: "save_copy",
      displayPath: "/tmp/copy.md",
    });
    const changed = snapshot({
      ...ready,
      editVersion: ready.editVersion + 1,
      markdown: "# changed",
    });
    const projections = projectWorkspaceTabSettlement(
      batch,
      changed,
      new Map([["tab-a", resolution]]),
    );
    expect(projections[0]?.state).toBe("dirty");
    expect(settlementBatchIsSafe(projections)).toBe(false);
  });

  it.each([
    [
      "saving",
      {
        ...ready,
        saveState: {
          kind: "saving" as const,
          requestId: "save-a",
          editVersion: ready.editVersion,
          changedAfterStart: false,
        },
      },
      false,
    ],
    [
      "save_failed",
      {
        ...ready,
        saveState: {
          kind: "save_failed" as const,
          error: {
            code: "safe_write_unavailable" as const,
            messageKey: "error.desktop.safe_write_unavailable",
            pathHint: null,
            contentSafe: true,
            retryable: true,
          },
        },
      },
      false,
    ],
    [
      "conflict",
      {
        ...ready,
        saveState: {
          kind: "conflict" as const,
          evidenceId: "conflict-a",
        },
      },
      false,
    ],
    [
      "readonly",
      {
        ...ready,
        saveState: {
          kind: "readonly" as const,
          reason: "workspace" as const,
        },
      },
      false,
    ],
    [
      "safe",
      {
        ...ready,
        saveState: {
          kind: "readonly" as const,
          reason: "workspace" as const,
        },
        contentSafety: { kind: "disk" as const },
      },
      true,
    ],
  ])("projects %s without conflating content safety", (state, session, safe) => {
    const current = snapshot(session);
    const batch = createWorkspaceTabSettlementBatch(
      current,
      ["tab-a"],
      "close_current",
      "batch-a",
    );
    const projections = projectWorkspaceTabSettlement(
      batch,
      current,
      new Map(),
    );
    expect(projections[0]?.state).toBe(state);
    expect(projections[0]?.safe).toBe(safe);
    expect(settlementBatchIsSafe(projections)).toBe(safe);
  });
});
