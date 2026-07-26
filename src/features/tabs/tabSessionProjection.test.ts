import { describe, expect, it } from "vitest";

import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { acceptWorkspaceTabPath } from "./tabPath";
import { projectWindowTabSessionSnapshot } from "./tabSessionProjection";
import {
  createWorkspaceTabDescriptor,
  type RecentlyClosedWorkspaceTab,
} from "./tabTypes";

describe("projectWindowTabSessionSnapshot", () => {
  it("keeps tab order, active path and recent metadata without Markdown content", () => {
    const first = createWorkspaceTabDescriptor(
      {
        tabId: "tab-a",
        workspaceId: "workspace-a",
        path: acceptWorkspaceTabPath({
          relativePath: "a.md",
          identity: "native:a",
        }),
        restoredView: {
          mode: "source",
          selection: { kind: "source", anchor: 3, head: 3 },
          anchor: { kind: "source", offset: 3, scrollTop: 20 },
        },
        lastActivatedAt: 4,
      },
      1,
    );
    const second = createWorkspaceTabDescriptor(
      {
        tabId: "tab-b",
        workspaceId: "workspace-a",
        path: acceptWorkspaceTabPath({
          relativePath: "b.md",
          identity: "native:b",
        }),
        lastActivatedAt: 5,
      },
      2,
    );
    const recentPath = acceptWorkspaceTabPath({
      relativePath: "closed.md",
      identity: "native:closed",
    });
    const recent: RecentlyClosedWorkspaceTab = {
      workspaceId: "workspace-a",
      relativePath: recentPath.relativePath,
      pathIdentity: recentPath.identity,
      displayName: "closed.md",
      parentHint: null,
      view: null,
      closedAt: 9,
    };
    const snapshot: WorkspaceTabManagerSnapshot = {
      collection: {
        workspaceId: "workspace-a",
        orderedTabIds: [second.tabId, first.tabId],
        activeTabId: first.tabId,
        tabsById: new Map([
          [first.tabId, first],
          [second.tabId, second],
        ]),
        pathIndex: new Map([
          [first.pathIdentity, first.tabId],
          [second.pathIdentity, second.tabId],
        ]),
        recentlyClosed: [recent],
        nextIncarnation: 3,
        revision: 7,
        persistedRevision: 2,
      },
      runtimes: new Map(),
      activeTab: first,
      activeRuntime: null,
    };

    const projected = projectWindowTabSessionSnapshot(snapshot, 100);

    expect(projected.tabs.map((tab) => tab.relativePath)).toEqual([
      "b.md",
      "a.md",
    ]);
    expect(projected.activeRelativePath).toBe("a.md");
    expect(projected.tabs[1]?.view).toMatchObject({
      mode: "source",
      selection: { anchor: 3, head: 3 },
    });
    expect(projected.recentlyClosed).toEqual([
      {
        relativePath: "closed.md",
        view: {
          mode: "visual",
          selection: { kind: "visual", from: 0, to: 0 },
          anchor: {
            kind: "semantic",
            blockId: null,
            fallbackOffset: 0,
            scrollTop: 0,
          },
        },
        closedAt: 9,
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("markdown");
  });
});
