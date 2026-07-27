import { describe, expect, it } from "vitest";

import type {
  DesktopError,
  FileRevision,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import {
  createWorkspaceTabCollection,
  RECENTLY_CLOSED_TAB_LIMIT,
  reduceWorkspaceTabs,
  restoreWorkspaceTabCollection,
  selectActiveWorkspaceTabProjection,
  toWorkspaceTabRecoveryDescriptors,
  validateWorkspaceTabCollection,
  workspaceTabsNeedPersistence,
  type WorkspaceTabCollection,
} from "./tabReducer";
import {
  acceptWorkspaceTabPath,
  type WorkspaceTabPath,
  type WorkspaceTabPathIdentity,
} from "./tabPath";
import {
  createWorkspaceTabDescriptor,
  projectWorkspaceTabStatus,
  WORKSPACE_TAB_SETTLEMENT_REASONS,
  type WorkspaceTabOpenRequest,
  type WorkspaceTabRuntime,
  type WorkspaceTabViewState,
} from "./tabTypes";

const revision: FileRevision = {
  modifiedAt: 1,
  size: 6,
  contentHash: "hash",
  encoding: "utf8",
  lineEnding: "lf",
};

const view: WorkspaceTabViewState = {
  mode: "source",
  selection: { kind: "source", anchor: 2, head: 2 },
  anchor: { kind: "source", offset: 2, scrollTop: 24 },
};

function tabPath(
  relativePath: string,
  identity = `native:${relativePath}`,
): WorkspaceTabPath {
  return acceptWorkspaceTabPath({
    relativePath: relativePath as WorkspaceRelativePath,
    identity,
  });
}

function request(
  index: number,
  path = tabPath(`folder-${index}/note.md`),
): WorkspaceTabOpenRequest {
  return {
    tabId: `tab-${index}`,
    workspaceId: "workspace-a",
    path,
    lastActivatedAt: index,
  };
}

function open(
  state: WorkspaceTabCollection,
  index: number,
  path?: WorkspaceTabPath,
): WorkspaceTabCollection {
  return reduceWorkspaceTabs(state, {
    type: "open",
    tab: request(index, path),
  });
}

function incarnation(
  state: WorkspaceTabCollection,
  tabId: string,
): number {
  const value = state.tabsById.get(tabId)?.incarnation;
  if (!value) throw new Error(`missing tab incarnation: ${tabId}`);
  return value;
}

function readySession(
  relativePath: string,
  markdown = "# Note",
): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath,
  });
  const resolved = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath,
      status: "ready",
      content: markdown,
      revision,
    },
    { mode: "visual", reasons: [] },
    true,
  );
  if (resolved.status !== "ready") {
    throw new Error("expected a ready document session");
  }
  return resolved;
}

function desktopError(
  code: DesktopError["code"],
  contentSafe = true,
): DesktopError {
  return {
    code,
    messageKey: code,
    pathHint: null,
    contentSafe,
    retryable: true,
  };
}

describe("workspace tab path contract", () => {
  it.each([
    "../secret.md",
    "./note.md",
    "/absolute.md",
    "C:/absolute.md",
    "a//note.md",
    "a/../note.md",
    "a\\note.md",
  ])("rejects a non-normalized relative path: %s", (relativePath) => {
    expect(() => tabPath(relativePath)).toThrow(
      "Workspace tab path identity is invalid",
    );
  });

  it("uses the opaque native identity instead of frontend case folding", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    state = open(
      state,
      1,
      tabPath("Notes/Readme.md", "windows:notes/readme.md"),
    );
    state = open(
      state,
      2,
      tabPath("notes/readme.md", "windows:notes/readme.md"),
    );

    expect(state.orderedTabIds).toEqual(["tab-1"]);
    expect(state.activeTabId).toBe("tab-1");
    expect(state.tabsById.has("tab-2")).toBe(false);
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });
});

describe("workspace tab reducer", () => {
  it("restores ordered unloaded tabs and recent metadata as one persisted baseline", () => {
    const firstPath = tabPath("one.md");
    const secondPath = tabPath("folder/two.md");
    const recentPath = tabPath("closed.md");
    const state = restoreWorkspaceTabCollection(
      createWorkspaceTabCollection("workspace-a"),
      {
        tabs: [
          { ...request(1, firstPath), restoredView: view },
          request(2, secondPath),
        ],
        activePathIdentity: secondPath.identity,
        recentlyClosed: [
          {
            workspaceId: "workspace-a",
            relativePath: recentPath.relativePath,
            pathIdentity: recentPath.identity,
            displayName: "closed.md",
            parentHint: null,
            view,
            closedAt: 10,
          },
        ],
        repositoryMatches: true,
      },
    );

    expect(state.orderedTabIds).toEqual(["tab-1", "tab-2"]);
    expect(state.activeTabId).toBe("tab-2");
    expect(state.tabsById.get("tab-1")?.loadState.kind).toBe("idle");
    expect(state.tabsById.get("tab-1")?.restoredView).toEqual(view);
    expect(state.recentlyClosed).toHaveLength(1);
    expect(state.persistedRevision).toBe(state.revision);
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });

  it("keeps an isolated restore result dirty so invalid metadata is cleaned later", () => {
    const restored = restoreWorkspaceTabCollection(
      createWorkspaceTabCollection("workspace-a"),
      {
        tabs: [request(1)],
        activePathIdentity: null,
        recentlyClosed: [],
        repositoryMatches: false,
      },
    );

    expect(workspaceTabsNeedPersistence(restored)).toBe(true);
    expect(restored.activeTabId).toBe("tab-1");
  });

  it("keeps the complete settlement reason contract explicit", () => {
    expect(WORKSPACE_TAB_SETTLEMENT_REASONS).toEqual([
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
    ]);
  });

  it("keeps one tab per native path identity and focuses the existing tab", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    state = open(state, 1, tabPath("a/note.md", "native:a/note.md"));
    state = open(state, 2, tabPath("b/note.md", "native:b/note.md"));
    state = reduceWorkspaceTabs(state, {
      type: "open",
      tab: {
        tabId: "unused-duplicate",
        workspaceId: "workspace-a",
        path: tabPath("alias/note.md", "native:a/note.md"),
        lastActivatedAt: 20,
      },
    });

    expect(state.orderedTabIds).toEqual(["tab-1", "tab-2"]);
    expect(state.activeTabId).toBe("tab-1");
    expect(state.tabsById.get("tab-1")).toMatchObject({
      displayName: "note.md",
      parentHint: "a",
      lastActivatedAt: 20,
    });
    expect(state.tabsById.has("unused-duplicate")).toBe(false);
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });

  it("moves, closes and restores tabs while allocating a new incarnation", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    state = open(state, 1);
    state = open(state, 2);
    state = open(state, 3);
    const originalIncarnation = incarnation(state, "tab-3");
    const originalIdentity = state.tabsById.get("tab-3")?.pathIdentity;
    if (!originalIdentity) throw new Error("missing original identity");

    state = reduceWorkspaceTabs(state, {
      type: "move",
      tabId: "tab-3",
      toIndex: 0,
    });
    state = reduceWorkspaceTabs(state, {
      type: "close",
      tabId: "tab-3",
      closedAt: 30,
      view,
    });
    expect(state.activeTabId).toBe("tab-1");
    expect(state.recentlyClosed[0]).toMatchObject({
      relativePath: "folder-3/note.md",
      pathIdentity: originalIdentity,
      view,
    });

    state = reduceWorkspaceTabs(state, {
      type: "restore_closed",
      pathIdentity: originalIdentity,
      tabId: "tab-restored",
      activatedAt: 40,
    });
    expect(state.activeTabId).toBe("tab-restored");
    expect(state.tabsById.get("tab-restored")?.restoredView).toEqual(view);
    expect(incarnation(state, "tab-restored")).toBeGreaterThan(
      originalIncarnation,
    );
    expect(state.recentlyClosed).toEqual([]);
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });

  it("rejects a stale result after close and tab-id reuse", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    const firstIncarnation = incarnation(state, "tab-1");
    state = reduceWorkspaceTabs(state, {
      type: "begin_load",
      tabId: "tab-1",
      incarnation: firstIncarnation,
      generation: 1,
    });
    state = reduceWorkspaceTabs(state, {
      type: "close",
      tabId: "tab-1",
      closedAt: 10,
      view: null,
    });
    const closedIdentity = state.recentlyClosed[0]?.pathIdentity;
    if (!closedIdentity) throw new Error("missing closed identity");
    state = reduceWorkspaceTabs(state, {
      type: "restore_closed",
      pathIdentity: closedIdentity,
      tabId: "tab-1",
      activatedAt: 11,
    });
    const secondIncarnation = incarnation(state, "tab-1");
    state = reduceWorkspaceTabs(state, {
      type: "begin_load",
      tabId: "tab-1",
      incarnation: secondIncarnation,
      generation: 1,
    });

    const stale = reduceWorkspaceTabs(state, {
      type: "resolve_load",
      tabId: "tab-1",
      incarnation: firstIncarnation,
      generation: 1,
      outcome: { kind: "ready", generation: 1 },
    });
    expect(stale).toBe(state);

    state = reduceWorkspaceTabs(state, {
      type: "resolve_load",
      tabId: "tab-1",
      incarnation: secondIncarnation,
      generation: 1,
      outcome: { kind: "ready", generation: 1 },
    });
    expect(state.tabsById.get("tab-1")?.loadState.kind).toBe("ready");
  });

  it("ignores stale generations within the current incarnation", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    const currentIncarnation = incarnation(state, "tab-1");
    state = reduceWorkspaceTabs(state, {
      type: "begin_load",
      tabId: "tab-1",
      incarnation: currentIncarnation,
      generation: 1,
    });
    const stale = reduceWorkspaceTabs(state, {
      type: "resolve_load",
      tabId: "tab-1",
      incarnation: currentIncarnation,
      generation: 0,
      outcome: { kind: "ready", generation: 0 },
    });
    expect(stale).toBe(state);
  });

  it("tracks persistence revisions without future acknowledgements", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    expect(workspaceTabsNeedPersistence(state)).toBe(true);
    expect(
      reduceWorkspaceTabs(state, {
        type: "mark_persisted",
        revision: state.revision + 1,
      }),
    ).toBe(state);
    state = reduceWorkspaceTabs(state, {
      type: "mark_persisted",
      revision: state.revision,
    });
    expect(workspaceTabsNeedPersistence(state)).toBe(false);
  });

  it("bounds recently closed native identities", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    for (let index = 0; index < RECENTLY_CLOSED_TAB_LIMIT + 8; index += 1) {
      state = open(state, index);
      state = reduceWorkspaceTabs(state, {
        type: "close",
        tabId: `tab-${index}`,
        closedAt: index,
        view: null,
      });
    }
    expect(state.recentlyClosed).toHaveLength(RECENTLY_CLOSED_TAB_LIMIT);
    expect(state.recentlyClosed[0]?.relativePath).toBe("folder-57/note.md");
    expect(state.recentlyClosed.at(-1)?.relativePath).toBe(
      "folder-8/note.md",
    );
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });

  it("rejects cross-workspace open requests", () => {
    const state = createWorkspaceTabCollection("workspace-a");
    expect(() =>
      reduceWorkspaceTabs(state, {
        type: "open",
        tab: {
          ...request(1),
          workspaceId: "workspace-b",
        },
      }),
    ).toThrow("another workspace");
  });

  it("detects map, order, identity, incarnation and recent-list corruption", () => {
    const valid = open(createWorkspaceTabCollection("workspace-a"), 1);
    const descriptor = valid.tabsById.get("tab-1");
    if (!descriptor) throw new Error("missing descriptor");

    const corrupted: WorkspaceTabCollection = {
      ...valid,
      orderedTabIds: ["missing"],
      activeTabId: "missing",
      tabsById: new Map([
        [
          "map-id",
          {
            ...descriptor,
            relativePath: "../corrupt.md",
          },
        ],
      ]),
      pathIndex: new Map([[descriptor.pathIdentity, "wrong-id"]]),
      recentlyClosed: [
        {
          workspaceId: "workspace-b",
          relativePath: descriptor.relativePath,
          pathIdentity: descriptor.pathIdentity,
          displayName: descriptor.displayName,
          parentHint: descriptor.parentHint,
          view: null,
          closedAt: 1,
        },
      ],
      nextIncarnation: descriptor.incarnation,
    };
    const issues = validateWorkspaceTabCollection(corrupted);
    expect(issues).toEqual(
      expect.arrayContaining([
        "tab map key mismatch: map-id",
        "tab is missing from order: map-id",
        "path index mismatch: ../corrupt.md",
        "tab path is invalid: map-id",
        "missing tab descriptor: missing",
        `tab map mismatch: ${descriptor.pathIdentity}`,
        `recent tab belongs to another workspace: ${descriptor.relativePath}`,
        `open tab remains in recently closed: ${descriptor.relativePath}`,
        "tab incarnation is outside the collection: map-id",
      ]),
    );
  });

  it("rejects invalid and inconsistent recently closed path metadata", () => {
    const state = createWorkspaceTabCollection("workspace-a");
    const invalidIdentity = "" as WorkspaceTabPathIdentity;
    const corrupted: WorkspaceTabCollection = {
      ...state,
      recentlyClosed: [
        {
          workspaceId: "workspace-a",
          relativePath: "../invalid.md",
          pathIdentity: invalidIdentity,
          displayName: "wrong.md",
          parentHint: "wrong",
          view: null,
          closedAt: 2,
        },
        {
          workspaceId: "workspace-a",
          relativePath: "valid.md",
          pathIdentity: invalidIdentity,
          displayName: "valid.md",
          parentHint: null,
          view: null,
          closedAt: 1,
        },
      ],
    };

    expect(validateWorkspaceTabCollection(corrupted)).toEqual(
      expect.arrayContaining([
        "recent tab path is invalid: ../invalid.md",
        "recent tab path presentation is invalid: ../invalid.md",
        "recent tab path is invalid: valid.md",
        "recent tab path is duplicated: valid.md",
      ]),
    );
  });
});

describe("workspace tab status contract", () => {
  it("separates unloaded, loading, empty and ready states", () => {
    const idle = createWorkspaceTabDescriptor(request(1), 1);
    expect(projectWorkspaceTabStatus(idle, null).state).toBe("unloaded");
    expect(
      projectWorkspaceTabStatus(
        { ...idle, loadState: { kind: "loading", generation: 1 } },
        null,
      ).state,
    ).toBe("loading");

    const emptySession = readySession(idle.relativePath, "");
    const readyTab = {
      ...idle,
      loadState: { kind: "ready", generation: 1 } as const,
    };
    expect(
      projectWorkspaceTabStatus(readyTab, {
        incarnation: idle.incarnation,
        session: emptySession,
        saveController: null,
      }).state,
    ).toBe("empty");
    expect(
      projectWorkspaceTabStatus(readyTab, {
        incarnation: idle.incarnation,
        session: readySession(idle.relativePath),
        saveController: null,
      }).state,
    ).toBe("ready");
  });

  it("reuses the DESIGN priority and announcement contract", () => {
    const tab = {
      ...createWorkspaceTabDescriptor(request(1), 1),
      loadState: { kind: "ready", generation: 1 } as const,
    };
    const session = {
      ...readySession(tab.relativePath),
      saveState: { kind: "conflict", evidenceId: "evidence" } as const,
      recoveryState: {
        kind: "failed",
        error: desktopError("recovery_write_failed"),
      } as const,
    };
    expect(
      projectWorkspaceTabStatus(tab, {
        incarnation: tab.incarnation,
        session,
        saveController: null,
      }),
    ).toMatchObject({
      state: "conflict",
      presentation: { role: "alert", live: "assertive" },
    });

    expect(
      projectWorkspaceTabStatus(
        {
          ...tab,
          loadState: {
            kind: "permission_denied",
            generation: 2,
            error: desktopError("permission_denied"),
          },
        },
        null,
      ),
    ).toMatchObject({
      state: "permission_denied",
      presentation: { role: "alert", live: "assertive" },
    });
  });

  it("does not project a runtime from an earlier tab incarnation", () => {
    const tab = {
      ...createWorkspaceTabDescriptor(request(1), 2),
      loadState: { kind: "ready", generation: 1 } as const,
    };
    const staleRuntime: WorkspaceTabRuntime = {
      incarnation: 1,
      session: readySession(tab.relativePath, ""),
      saveController: null,
    };

    expect(projectWorkspaceTabStatus(tab, staleRuntime)).toMatchObject({
      state: "error",
      presentation: { role: "alert", live: "assertive" },
    });
  });

  it("maps disk and compatibility failures to stable states", () => {
    const tab = createWorkspaceTabDescriptor(request(1), 1);
    for (const [code, expected] of [
      ["path_not_found", "missing"],
      ["permission_denied", "permission_denied"],
      ["unsupported_text_encoding", "unsupported"],
      ["io_failure", "error"],
    ] as const) {
      expect(
        projectWorkspaceTabStatus(
          {
            ...tab,
            loadState: {
              kind: "error",
              generation: 1,
              error: desktopError(code),
            },
          },
          null,
        ).state,
      ).toBe(expected);
    }
  });
});

describe("workspace tab lightweight model gate", () => {
  it("keeps 100 descriptors bounded and projects one matching runtime", () => {
    const startedAt = performance.now();
    let state = createWorkspaceTabCollection("workspace-a");
    for (let index = 0; index < 100; index += 1) {
      state = open(
        state,
        index,
        tabPath(
          `area-${index}/note-${index}.md`,
          `native:area-${index}/note-${index}.md`,
        ),
      );
    }

    const runtimes = new Map<string, WorkspaceTabRuntime>();
    const sessions: ReadyDocumentSession[] = [];
    for (let index = 0; index < 20; index += 1) {
      const session = readySession(`area-${index}/note-${index}.md`);
      sessions.push(session);
      runtimes.set(`tab-${index}`, {
        incarnation: incarnation(state, `tab-${index}`),
        session,
        saveController: null,
      });
    }
    state = reduceWorkspaceTabs(state, {
      type: "activate",
      tabId: "tab-19",
      activatedAt: 1_000,
    });

    const projection = selectActiveWorkspaceTabProjection(state, runtimes);
    expect(projection?.tab.tabId).toBe("tab-19");
    expect(projection?.runtime?.session).toBe(sessions[19]);
    expect(runtimes.size).toBe(20);

    const recovery = toWorkspaceTabRecoveryDescriptors(state, runtimes);
    const serialized = JSON.stringify(recovery);
    expect(recovery).toHaveLength(100);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
      64 * 1024,
    );
    expect(serialized).not.toContain("markdown");
    expect(serialized).not.toContain("history");
    expect(serialized).not.toContain("saveController");
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("rejects a runtime from an earlier incarnation", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    const oldIncarnation = incarnation(state, "tab-1");
    const staleRuntime: WorkspaceTabRuntime = {
      incarnation: oldIncarnation,
      session: readySession("folder-1/note.md"),
      saveController: null,
    };
    state = reduceWorkspaceTabs(state, {
      type: "close",
      tabId: "tab-1",
      closedAt: 1,
      view: null,
    });
    const pathIdentity = state.recentlyClosed[0]?.pathIdentity;
    if (!pathIdentity) throw new Error("missing identity");
    state = reduceWorkspaceTabs(state, {
      type: "restore_closed",
      pathIdentity,
      tabId: "tab-1",
      activatedAt: 2,
    });

    expect(
      selectActiveWorkspaceTabProjection(
        state,
        new Map([["tab-1", staleRuntime]]),
      )?.runtime,
    ).toBeNull();
  });
});
