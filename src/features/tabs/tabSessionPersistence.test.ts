import { describe, expect, it, vi } from "vitest";

import type {
  WindowTabSession,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { acceptWorkspaceTabPath } from "./tabPath";
import {
  WorkspaceTabSessionPersistence,
  type WorkspaceTabPersistenceGateway,
} from "./tabSessionPersistence";
import { createWorkspaceTabDescriptor } from "./tabTypes";

function storedSession(
  tabs: WindowTabSession["tabs"] = [],
): WindowTabSession {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-a",
    windowStateRef: "window-session-a",
    revision: tabs.length > 0 ? 3 : 0,
    tabs,
    activeRelativePath: tabs[0]?.path.relativePath ?? null,
    recentlyClosed: [],
    updatedAt: 10,
    issues: [],
  };
}

function managerSnapshot(
  paths: readonly WorkspaceRelativePath[],
  revision = paths.length,
): WorkspaceTabManagerSnapshot {
  const tabs = paths.map((relativePath, index) =>
    createWorkspaceTabDescriptor(
      {
        tabId: `tab-${index}`,
        workspaceId: "workspace-a",
        path: acceptWorkspaceTabPath({
          relativePath,
          identity: `native:${relativePath}`,
        }),
        lastActivatedAt: index + 1,
      },
      index + 1,
    ),
  );
  return {
    collection: {
      workspaceId: "workspace-a",
      orderedTabIds: tabs.map((tab) => tab.tabId),
      activeTabId: tabs[0]?.tabId ?? null,
      tabsById: new Map(tabs.map((tab) => [tab.tabId, tab])),
      pathIndex: new Map(tabs.map((tab) => [tab.pathIdentity, tab.tabId])),
      recentlyClosed: [],
      nextIncarnation: tabs.length + 1,
      revision,
      persistedRevision: 0,
    },
    runtimes: new Map(),
    activeTab: tabs[0] ?? null,
    activeRuntime: null,
  };
}

function persistenceFixture(session = storedSession()) {
  const gateway: WorkspaceTabPersistenceGateway = {
    get: vi.fn().mockResolvedValue(session),
    save: vi.fn().mockImplementation(
      async (_workspaceId, windowStateRef, expectedRevision, snapshot) => ({
        workspaceId: "workspace-a",
        windowStateRef: windowStateRef ?? "window-session-a",
        revision: expectedRevision + 1,
        tabCount: snapshot.tabs.length,
        updatedAt: snapshot.updatedAt,
      }),
    ),
  };
  const markPersisted = vi.fn();
  const onError = vi.fn();
  const persistence = new WorkspaceTabSessionPersistence({
    workspaceId: "workspace-a",
    gateway,
    markPersisted,
    onError,
    now: () => 50,
  });
  return { gateway, markPersisted, onError, persistence };
}

describe("WorkspaceTabSessionPersistence", () => {
  it("writes ordered metadata with CAS and marks only the sent collection revision", async () => {
    const fixture = persistenceFixture();
    const snapshot = managerSnapshot(["second.md", "first.md"], 4);
    fixture.persistence.observe(snapshot);

    expect(await fixture.persistence.initialize()).toBe("ready");
    expect(await fixture.persistence.flush()).toBe(true);

    expect(fixture.gateway.save).toHaveBeenCalledWith(
      "workspace-a",
      "window-session-a",
      0,
      expect.objectContaining({
        activeRelativePath: "second.md",
        updatedAt: 50,
      }),
    );
    const sent = vi.mocked(fixture.gateway.save).mock.calls[0]?.[3];
    expect(sent?.tabs.map((tab) => tab.relativePath)).toEqual([
      "second.md",
      "first.md",
    ]);
    expect(fixture.markPersisted).toHaveBeenCalledWith(4);
    fixture.persistence.dispose();
  });

  it("freezes an existing session until T42 consumes and resumes it", async () => {
    const existing = storedSession([
      {
        path: {
          relativePath: "recover-me.md",
          identity: "native:recover-me",
        },
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
        lastActivatedAt: 1,
      },
    ]);
    const fixture = persistenceFixture(existing);
    fixture.persistence.observe(managerSnapshot(["new.md"], 1));

    expect(await fixture.persistence.initialize()).toBe(
      "deferred_existing_session",
    );
    expect(fixture.persistence.pendingRestore()).toEqual(existing);
    expect(await fixture.persistence.flush()).toBe(false);
    expect(fixture.gateway.save).not.toHaveBeenCalled();
    const restored = managerSnapshot(["recover-me.md"], 1);
    fixture.persistence.observe(restored);
    expect(fixture.persistence.resumeAfterRestore(restored)).toBe(true);
    expect(fixture.persistence.currentStatus()).toBe("ready");
    expect(await fixture.persistence.flush()).toBe(true);
    expect(fixture.gateway.save).toHaveBeenCalledWith(
      "workspace-a",
      "window-session-a",
      3,
      expect.objectContaining({
        tabs: [
          expect.objectContaining({ relativePath: "recover-me.md" }),
        ],
      }),
    );
    fixture.persistence.dispose();
  });

  it("defers an issues-only repository so startup cannot erase isolated entries", async () => {
    const existing = {
      ...storedSession(),
      revision: 4,
      issues: [
        {
          relativePath: "missing.md" as WorkspaceRelativePath,
          error: {
            code: "path_not_found" as const,
            messageKey: "error.desktop.path_not_found",
            pathHint: "missing.md",
            contentSafe: true,
            retryable: true,
          },
        },
      ],
    };
    const fixture = persistenceFixture(existing);

    expect(await fixture.persistence.initialize()).toBe(
      "deferred_existing_session",
    );
    expect(fixture.persistence.pendingRestore()?.issues).toHaveLength(1);
    fixture.persistence.dispose();
  });

  it("stops automatic writes after a repository conflict and reports the real error", async () => {
    const fixture = persistenceFixture();
    vi.mocked(fixture.gateway.save).mockRejectedValueOnce({
      code: "window_session_revision_conflict",
      messageKey: "error.windowSession.revisionConflict",
      pathHint: null,
      contentSafe: true,
      retryable: true,
    });
    fixture.persistence.observe(managerSnapshot(["note.md"], 1));
    await fixture.persistence.initialize();

    expect(await fixture.persistence.flush()).toBe(false);
    expect(fixture.persistence.currentStatus()).toBe("failed");
    expect(fixture.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "window_session_revision_conflict" }),
    );
    fixture.persistence.dispose();
  });
});
