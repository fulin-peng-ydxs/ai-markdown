import { describe, expect, it } from "vitest";

import type { WorkspaceLauncherSnapshot } from "../../services/desktop/contracts";
import {
  filterRecentWorkspaces,
  formatLastOpened,
  restorableWorkspaces,
} from "./launcherState";

const snapshot: WorkspaceLauncherSnapshot = {
  recentWorkspaces: [
    {
      workspaceId: "workspace-a",
      displayName: "Research Notes",
      canonicalRoot: "/Users/demo/Documents/research",
      lastOpenedAt: 200,
      availability: "available",
    },
    {
      workspaceId: "workspace-b",
      displayName: "产品文档",
      canonicalRoot: "/Users/demo/Writing/product",
      lastOpenedAt: 100,
      availability: "missing",
    },
  ],
  workspaceSessions: [
    { workspaceId: "workspace-a", windowLabel: "window-1", windowStateRef: null, lastActiveAt: 20 },
    { workspaceId: "workspace-b", windowLabel: "window-2", windowStateRef: "session-b", lastActiveAt: 30 },
    { workspaceId: "workspace-c", windowLabel: "window-3", windowStateRef: null, lastActiveAt: 10 },
  ],
  windowSessionSummaries: [
    {
      workspaceId: "workspace-b",
      windowStateRef: "session-b",
      revision: 4,
      tabCount: 3,
      updatedAt: 40,
      issue: null,
    },
  ],
  activeWorkspaceIds: ["workspace-a"],
  currentWorkspaceId: null,
  windowLabel: "window-1",
};

describe("launcher state", () => {
  it("filters only by display name and canonical path", () => {
    expect(filterRecentWorkspaces(snapshot.recentWorkspaces, "research")).toHaveLength(1);
    expect(filterRecentWorkspaces(snapshot.recentWorkspaces, "Writing")[0]?.workspaceId).toBe("workspace-b");
    expect(filterRecentWorkspaces(snapshot.recentWorkspaces, "missing")).toHaveLength(0);
  });

  it("excludes active roots and keeps missing recent metadata explicit", () => {
    const items = restorableWorkspaces(snapshot);
    expect(items.map((item) => item.session.workspaceId)).toEqual(["workspace-b", "workspace-c"]);
    expect(items[0]?.recent?.availability).toBe("missing");
    expect(items[0]?.summary?.tabCount).toBe(3);
    expect(items[1]?.recent).toBeNull();
    expect(items[1]?.summary).toBeNull();
  });

  it("formats stable relative day labels", () => {
    const now = new Date("2026-07-21T12:00:00+08:00").getTime();
    expect(formatLastOpened(now - 60_000, now)).toBe("今天");
    expect(formatLastOpened(now - 25 * 60 * 60 * 1000, now)).toBe("昨天");
  });
});
