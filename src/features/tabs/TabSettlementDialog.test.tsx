import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ReadyDocumentSession } from "../editor/documentSession";
import { createDocumentHistory } from "../editor/documentHistory";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { TabSettlementDialog } from "./TabSettlementDialog";
import { acceptWorkspaceTabPath } from "./tabPath";
import { createWorkspaceTabSettlementBatch } from "./tabSettlement";
import type {
  WorkspaceTabDescriptor,
  WorkspaceTabRuntime,
} from "./tabTypes";

function dirtySnapshot(): WorkspaceTabManagerSnapshot {
  const path = acceptWorkspaceTabPath({
    relativePath: "drafts/note.md",
    identity: "native:drafts/note.md",
  });
  const tab: WorkspaceTabDescriptor = {
    tabId: "tab-dirty",
    incarnation: 1,
    workspaceId: "workspace-a",
    relativePath: path.relativePath,
    pathIdentity: path.identity,
    displayName: "note.md",
    parentHint: "drafts",
    loadState: { kind: "ready", generation: 1 },
    restoredView: null,
    lastActivatedAt: 1,
  };
  const session: ReadyDocumentSession = {
    status: "ready",
    generation: 1,
    workspaceId: "workspace-a",
    relativePath: "drafts/note.md",
    markdown: "# dirty",
    diskRevision: {
      modifiedAt: 1,
      size: 5,
      contentHash: "disk",
      encoding: "utf8",
      lineEnding: "lf",
    },
    persistedContentHash: "disk",
    sourceFormat: { encoding: "utf8", lineEnding: "lf" },
    editVersion: 1,
    mode: "source",
    saveState: { kind: "dirty" },
    contentSafety: { kind: "memory" },
    selection: { kind: "source", anchor: 0, head: 0 },
    anchor: { kind: "source", offset: 0, scrollTop: 0 },
    history: createDocumentHistory({ maxBytes: 1024, maxEntries: 10 }),
    compatibility: { mode: "visual", reasons: [] },
    recoveryState: { kind: "none" },
    conflictEvidence: null,
  };
  const runtime: WorkspaceTabRuntime = {
    incarnation: 1,
    session,
    saveController: null,
  };
  return {
    collection: {
      workspaceId: "workspace-a",
      orderedTabIds: [tab.tabId],
      activeTabId: tab.tabId,
      tabsById: new Map([[tab.tabId, tab]]),
      pathIndex: new Map([[tab.pathIdentity, tab.tabId]]),
      recentlyClosed: [],
      nextIncarnation: 2,
      revision: 1,
      persistedRevision: 0,
    },
    runtimes: new Map([[tab.tabId, runtime]]),
    activeTab: tab,
    activeRuntime: runtime,
  };
}

describe("TabSettlementDialog", () => {
  it("keeps final commit disabled until discard is explicitly confirmed", async () => {
    const snapshot = dirtySnapshot();
    const batch = createWorkspaceTabSettlementBatch(
      snapshot,
      ["tab-dirty"],
      "close_current",
      "batch-a",
    );
    const onDiscard = vi.fn();
    const onCommit = vi.fn();
    const user = userEvent.setup();
    const rendered = render(
      <TabSettlementDialog
        batch={batch}
        busyTabIds={new Set()}
        finalActionLabel="关闭这个页签"
        onCancel={() => undefined}
        onCommit={onCommit}
        onDiscard={onDiscard}
        onResolveConflict={() => undefined}
        onRetry={() => undefined}
        onSaveCopy={() => undefined}
        resolutions={new Map()}
        snapshot={snapshot}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "关闭这个页签" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(
      screen.getByRole("dialog", {
        name: /放弃“note\.md”的修改/,
      }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "确认放弃这个页签的修改",
      }),
    );
    expect(onDiscard).toHaveBeenCalledWith("tab-dirty");
    expect(onCommit).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("cancels the entire batch without resolving or committing an item", async () => {
    const snapshot = dirtySnapshot();
    const batch = createWorkspaceTabSettlementBatch(
      snapshot,
      ["tab-dirty"],
      "close_current",
      "batch-a",
    );
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <TabSettlementDialog
        batch={batch}
        busyTabIds={new Set()}
        finalActionLabel="关闭这个页签"
        onCancel={onCancel}
        onCommit={onCommit}
        onDiscard={() => undefined}
        onResolveConflict={() => undefined}
        onRetry={() => undefined}
        onSaveCopy={() => undefined}
        resolutions={new Map()}
        snapshot={snapshot}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "取消并保持全部页签" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
