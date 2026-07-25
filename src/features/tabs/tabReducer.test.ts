import { describe, expect, it } from "vitest";

import type {
  DesktopError,
  FileRevision,
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
  selectActiveWorkspaceTabProjection,
  toWorkspaceTabRecoveryDescriptors,
  validateWorkspaceTabCollection,
  workspaceTabsNeedPersistence,
  type WorkspaceTabCollection,
} from "./tabReducer";
import {
  createWorkspaceTabDescriptor,
  projectWorkspaceTabStatus,
  WORKSPACE_TAB_SETTLEMENT_REASONS,
  type WorkspaceTabDescriptor,
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

function descriptor(
  index: number,
  path = `folder-${index}/note.md`,
): WorkspaceTabDescriptor {
  return createWorkspaceTabDescriptor({
    tabId: `tab-${index}`,
    workspaceId: "workspace-a",
    relativePath: path,
    lastActivatedAt: index,
  });
}

function open(
  state: WorkspaceTabCollection,
  index: number,
  path?: string,
): WorkspaceTabCollection {
  return reduceWorkspaceTabs(state, {
    type: "open",
    tab: descriptor(index, path),
  });
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

describe("workspace tab reducer", () => {
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

  it("keeps one tab per workspace path and focuses the existing identity", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    state = open(state, 1, "a/note.md");
    state = open(state, 2, "b/note.md");
    const duplicate = createWorkspaceTabDescriptor({
      tabId: "unused-duplicate",
      workspaceId: "workspace-a",
      relativePath: "a/note.md",
      lastActivatedAt: 20,
    });
    state = reduceWorkspaceTabs(state, { type: "open", tab: duplicate });

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

  it("moves tabs, closes atomically, selects the adjacent tab and restores view metadata", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    state = open(state, 1);
    state = open(state, 2);
    state = open(state, 3);
    state = reduceWorkspaceTabs(state, {
      type: "move",
      tabId: "tab-3",
      toIndex: 0,
    });
    expect(state.orderedTabIds).toEqual(["tab-3", "tab-1", "tab-2"]);

    state = reduceWorkspaceTabs(state, {
      type: "close",
      tabId: "tab-3",
      closedAt: 30,
      view,
    });
    expect(state.activeTabId).toBe("tab-1");
    expect(state.orderedTabIds).toEqual(["tab-1", "tab-2"]);
    expect(state.recentlyClosed[0]).toMatchObject({
      relativePath: "folder-3/note.md",
      view,
    });

    state = reduceWorkspaceTabs(state, {
      type: "restore_closed",
      relativePath: "folder-3/note.md",
      tabId: "tab-restored",
      activatedAt: 40,
    });
    expect(state.activeTabId).toBe("tab-restored");
    expect(state.tabsById.get("tab-restored")?.restoredView).toEqual(view);
    expect(state.recentlyClosed).toEqual([]);
    expect(validateWorkspaceTabCollection(state)).toEqual([]);
  });

  it("removes a recent entry when the same path is opened normally", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    state = reduceWorkspaceTabs(state, {
      type: "close",
      tabId: "tab-1",
      closedAt: 10,
      view,
    });
    expect(state.recentlyClosed).toHaveLength(1);

    state = open(state, 2, "folder-1/note.md");
    expect(state.activeTabId).toBe("tab-2");
    expect(state.recentlyClosed).toEqual([]);
  });

  it("ignores stale load generations and retains the latest load result", () => {
    let state = open(createWorkspaceTabCollection("workspace-a"), 1);
    state = reduceWorkspaceTabs(state, {
      type: "begin_load",
      tabId: "tab-1",
      generation: 1,
    });
    const stale = reduceWorkspaceTabs(state, {
      type: "resolve_load",
      tabId: "tab-1",
      generation: 0,
      outcome: { kind: "ready", generation: 0 },
    });
    expect(stale).toBe(state);

    state = reduceWorkspaceTabs(state, {
      type: "resolve_load",
      tabId: "tab-1",
      generation: 1,
      outcome: { kind: "ready", generation: 1 },
    });
    expect(state.tabsById.get("tab-1")?.loadState).toEqual({
      kind: "ready",
      generation: 1,
    });
    expect(
      reduceWorkspaceTabs(state, {
        type: "begin_load",
        tabId: "tab-1",
        generation: 1,
      }),
    ).toBe(state);
  });

  it("tracks persistence revisions without accepting future or stale acknowledgements", () => {
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

  it("bounds and de-duplicates recently closed paths", () => {
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

  it("rejects cross-workspace tabs and reports corrupted collection invariants", () => {
    const state = createWorkspaceTabCollection("workspace-a");
    expect(() =>
      reduceWorkspaceTabs(state, {
        type: "open",
        tab: createWorkspaceTabDescriptor({
          tabId: "tab-b",
          workspaceId: "workspace-b",
          relativePath: "note.md",
          lastActivatedAt: 1,
        }),
      }),
    ).toThrow("another workspace");

    expect(
      validateWorkspaceTabCollection({
        ...state,
        orderedTabIds: ["missing"],
      }),
    ).toContain("ordered tab ids must match the tab map");
  });
});

describe("workspace tab status contract", () => {
  it("reuses the DESIGN priority and assertive/polite announcement contract", () => {
    const tab = {
      ...descriptor(1),
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

    expect(
      projectWorkspaceTabStatus(tab, {
        session: {
          ...readySession(tab.relativePath),
          saveState: { kind: "dirty" },
        },
        saveController: null,
      }),
    ).toMatchObject({
      state: "dirty",
      presentation: { role: "status", live: "polite" },
    });
  });

  it("maps disk location and unsupported failures to stable non-color states", () => {
    const tab = descriptor(1);
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

describe("workspace tab performance and serialization boundary", () => {
  it("keeps 100 descriptors lightweight and projects only one active runtime", () => {
    const startedAt = performance.now();
    let state = createWorkspaceTabCollection("workspace-a");
    for (let index = 0; index < 100; index += 1) {
      state = open(state, index, `area-${index}/note-${index}.md`);
    }

    const runtimes = new Map<string, WorkspaceTabRuntime>();
    const sessions: ReadyDocumentSession[] = [];
    for (let index = 0; index < 20; index += 1) {
      const session = readySession(`area-${index}/note-${index}.md`);
      sessions.push(session);
      runtimes.set(`tab-${index}`, {
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

  it("switches the active projection without rebuilding inactive sessions", () => {
    let state = createWorkspaceTabCollection("workspace-a");
    const runtimes = new Map<string, WorkspaceTabRuntime>();
    for (let index = 0; index < 20; index += 1) {
      state = open(state, index);
      runtimes.set(`tab-${index}`, {
        session: readySession(`folder-${index}/note.md`),
        saveController: null,
      });
    }
    const before = [...runtimes.values()].map((runtime) => runtime.session);
    for (let index = 0; index < 20; index += 1) {
      state = reduceWorkspaceTabs(state, {
        type: "activate",
        tabId: `tab-${index}`,
        activatedAt: 2_000 + index,
      });
      expect(
        selectActiveWorkspaceTabProjection(state, runtimes)?.runtime?.session,
      ).toBe(before[index]);
    }
    expect([...runtimes.values()].map((runtime) => runtime.session)).toEqual(
      before,
    );
  });
});
