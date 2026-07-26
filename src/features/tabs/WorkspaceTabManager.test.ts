import { describe, expect, it, vi } from "vitest";

import type {
  FileRevision,
  MarkdownReadResult,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  applyDocumentEdit,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import type {
  EditorRecoveryGateway,
  EditorSaveGateway,
} from "../editor/editorGateway";
import {
  DocumentSaveController,
  type DocumentSaveClock,
} from "../editor/save/DocumentSaveController";
import {
  WorkspaceTabManager,
  type WorkspaceTabManagerOptions,
} from "./WorkspaceTabManager";
import type { WorkspaceTabSessionGateway } from "./tabSessionGateway";

const revision: FileRevision = {
  modifiedAt: 1,
  size: 16,
  contentHash: "disk",
  encoding: "utf8",
  lineEnding: "lf",
};

class ManualClock implements DocumentSaveClock {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  now(): number {
    return 100;
  }

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.callbacks.delete(handle as unknown as number);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function saveGateway(): EditorSaveGateway {
  return {
    write: vi.fn().mockImplementation(
      async (
        _workspaceId: string,
        relativePath: WorkspaceRelativePath,
        content: string,
      ) => ({
        relativePath,
        bytesWritten: content.length,
        revision: {
          ...revision,
          size: content.length,
          contentHash: `saved:${content}`,
        },
        durability: "file_and_directory",
        durabilityIssue: null,
      }),
    ),
    prepareOverwrite: vi.fn(),
    confirmOverwrite: vi.fn(),
    cancelOverwrite: vi.fn(),
    prepareSaveCopy: vi.fn(),
    confirmSaveCopy: vi.fn(),
    cancelSaveCopy: vi.fn(),
  };
}

function recoveryGateway(): EditorRecoveryGateway {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    registerActive: vi.fn().mockResolvedValue(true),
    releaseActive: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockResolvedValue({
      status: "memory_only",
      snapshot: null,
      issue: {
        code: "recovery_unavailable",
        messageKey: "recovery_unavailable",
        pathHint: null,
        contentSafe: true,
        retryable: true,
      },
    }),
    delete: vi.fn().mockResolvedValue(true),
    cleanup: vi.fn(),
  };
}

function managerFixture(
  overrides: Partial<WorkspaceTabManagerOptions> = {},
): {
  manager: WorkspaceTabManager;
  gateway: WorkspaceTabSessionGateway;
  save: EditorSaveGateway;
  recovery: EditorRecoveryGateway;
  clock: ManualClock;
} {
  const save = saveGateway();
  const recovery = recoveryGateway();
  const clock = new ManualClock();
  const gateway: WorkspaceTabSessionGateway = {
    resolvePath: vi.fn().mockImplementation(
      async (_workspaceId, relativePath: WorkspaceRelativePath) => ({
        relativePath,
        identity: `native:${relativePath.toLowerCase()}`,
      }),
    ),
    read: vi.fn().mockImplementation(
      async (
        _workspaceId,
        relativePath: WorkspaceRelativePath,
      ): Promise<MarkdownReadResult> => ({
        relativePath,
        status: "ready",
        content: `# ${relativePath}`,
        revision,
      }),
    ),
    saveGateway: save,
    recoveryGateway: recovery,
    parser: {
      parse: vi.fn().mockResolvedValue({
        roundTripMarkdown: "# parsed",
        parserWarnings: [],
        unknownSyntax: [],
        hasRawHtml: false,
        hasFrontmatter: false,
        hasMixedLineEndings: false,
      }),
    },
  };
  let tabNumber = 0;
  const manager = new WorkspaceTabManager({
    workspaceId: "workspace-a",
    gateway,
    now: () => ++tabNumber,
    createTabId: () => `tab-${++tabNumber}`,
    createSaveController: (options) =>
      new DocumentSaveController({ ...options, clock }),
    ...overrides,
  });
  return { manager, gateway, save, recovery, clock };
}

async function openReady(
  manager: WorkspaceTabManager,
  relativePath: string,
): Promise<string> {
  const result = await manager.open(relativePath, { writable: true });
  if (result.status === "failed") throw new Error(result.error.code);
  await vi.waitFor(() => {
    expect(
      manager.snapshot().runtimes.get(result.tabId)?.session.status,
    ).toBe("ready");
  });
  return result.tabId;
}

function editSession(
  manager: WorkspaceTabManager,
  tabId: string,
  markdown: string,
): ReadyDocumentSession {
  const snapshot = manager.snapshot();
  const tab = snapshot.collection.tabsById.get(tabId);
  const session = snapshot.runtimes.get(tabId)?.session;
  if (!tab || session?.status !== "ready") {
    throw new Error("expected ready tab runtime");
  }
  const edited = applyDocumentEdit(session, {
    generation: session.generation,
    expectedEditVersion: session.editVersion,
    markdown,
    mode: session.mode,
    selection: session.selection,
    anchor: session.anchor,
    transactionGroup: null,
  });
  if (edited.status !== "applied") throw new Error(edited.status);
  expect(
    manager.updateSession(tabId, tab.incarnation, edited.session),
  ).toBe(true);
  return edited.session;
}

describe("WorkspaceTabManager", () => {
  it("keeps independent content, history and view state for three tabs", async () => {
    const { manager } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    const third = await openReady(manager, "three.md");

    const editedFirst = editSession(manager, first, "# edited one");
    manager.activate(second);
    const editedSecond = editSession(manager, second, "# edited two");
    manager.activate(third);
    manager.activate(first);

    const snapshot = manager.snapshot();
    expect(snapshot.activeTab?.tabId).toBe(first);
    expect(snapshot.activeRuntime?.session).toMatchObject({
      status: "ready",
      markdown: "# edited one",
      editVersion: 1,
    });
    expect(editedFirst.history.past).toHaveLength(1);
    expect(editedSecond.history.past).toHaveLength(1);
    expect(
      (snapshot.runtimes.get(third)?.session as ReadyDocumentSession).markdown,
    ).toBe("# three.md");
    expect(snapshot.runtimes).toHaveLength(3);
  });

  it("focuses the Rust identity match without loading a duplicate runtime", async () => {
    const { manager, gateway } = managerFixture();
    const first = await openReady(manager, "Notes/Readme.md");
    const focused = await manager.open("notes/readme.md", { writable: true });

    expect(focused).toEqual({ status: "focused", tabId: first });
    expect(manager.snapshot().collection.orderedTabIds).toEqual([first]);
    expect(gateway.read).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow old read overwrite the active or newer tab", async () => {
    let resolveSlow!: (result: MarkdownReadResult) => void;
    const slow = new Promise<MarkdownReadResult>((resolve) => {
      resolveSlow = resolve;
    });
    const { manager, gateway } = managerFixture();
    vi.mocked(gateway.read).mockImplementation(
      async (_workspaceId, relativePath) =>
        relativePath === "slow.md"
          ? slow
          : {
              relativePath,
              status: "ready",
              content: "# fast",
              revision,
            },
    );

    const slowOpenPromise = manager.open("slow.md", { writable: true });
    await vi.waitFor(() =>
      expect(manager.snapshot().collection.orderedTabIds).toHaveLength(1),
    );
    const fastTab = await openReady(manager, "fast.md");
    resolveSlow({
      relativePath: "slow.md",
      status: "ready",
      content: "# slow",
      revision,
    });
    const slowOpen = await slowOpenPromise;
    await vi.waitFor(() => {
      expect(
        slowOpen.status === "failed"
          ? null
          : manager.snapshot().runtimes.get(slowOpen.tabId)?.session.status,
      ).toBe("ready");
    });

    expect(manager.snapshot().activeTab?.tabId).toBe(fastTab);
    expect(
      (manager.snapshot().activeRuntime?.session as ReadyDocumentSession)
        .markdown,
    ).toBe("# fast");
  });

  it("continues automatic save and recovery scheduling for an inactive dirty tab", async () => {
    const { manager, save, recovery, clock } = managerFixture();
    const first = await openReady(manager, "one.md");
    await openReady(manager, "two.md");
    editSession(manager, first, "# inactive dirty");

    clock.runAll();
    await vi.waitFor(() =>
      expect(save.write).toHaveBeenCalledWith(
        "workspace-a",
        "one.md",
        "# inactive dirty",
        revision,
      ),
    );
    expect(recovery.registerActive).toHaveBeenCalledWith(
      "workspace-a",
      "one.md",
    );
    expect(
      (manager.snapshot().runtimes.get(first)?.session as ReadyDocumentSession)
        .saveState.kind,
    ).toBe("saved");
  });

  it("commits the active adapter projection before changing tabs", async () => {
    let projected: ReadyDocumentSession | null = null;
    const fixture = managerFixture({
      captureActiveProjection: () => projected,
    });
    const first = await openReady(fixture.manager, "one.md");
    const firstSession = fixture.manager.snapshot().activeRuntime
      ?.session as ReadyDocumentSession;
    projected = {
      ...firstSession,
      markdown: "# projection",
      editVersion: firstSession.editVersion + 1,
      selection: { kind: "source", anchor: 4, head: 4 },
      anchor: { kind: "source", offset: 4, scrollTop: 22 },
      mode: "source",
    };

    await openReady(fixture.manager, "two.md");
    expect(
      (fixture.manager.snapshot().runtimes.get(first)
        ?.session as ReadyDocumentSession),
    ).toMatchObject({
      markdown: "# projection",
      mode: "source",
      anchor: { scrollTop: 22 },
    });
  });

  it("commits the active adapter projection before settling every controller", async () => {
    let projected: ReadyDocumentSession | null = null;
    const fixture = managerFixture({
      captureActiveProjection: () => projected,
    });
    const first = await openReady(fixture.manager, "one.md");
    const firstSession = fixture.manager.snapshot().activeRuntime
      ?.session as ReadyDocumentSession;
    projected = {
      ...firstSession,
      selection: { kind: "source", anchor: 7, head: 7 },
      anchor: { kind: "source", offset: 7, scrollTop: 41 },
      mode: "source",
    };

    expect(await fixture.manager.settleAll()).toEqual({ status: "settled" });
    expect(
      (fixture.manager.snapshot().runtimes.get(first)
        ?.session as ReadyDocumentSession),
    ).toMatchObject({
      mode: "source",
      selection: { anchor: 7, head: 7 },
      anchor: { offset: 7, scrollTop: 41 },
    });
  });

  it("moves tabs through the manager without rebuilding their runtimes", async () => {
    const { manager } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    const firstRuntime = manager.snapshot().runtimes.get(first);

    expect(manager.move(first, 1)).toBe(true);
    expect(manager.snapshot().collection.orderedTabIds).toEqual([second, first]);
    expect(manager.snapshot().runtimes.get(first)).toBe(firstRuntime);
    expect(manager.move("missing-tab", 0)).toBe(false);
  });

  it("captures the active view before closing and stores it for reopen", async () => {
    let projected: ReadyDocumentSession | null = null;
    const fixture = managerFixture({
      captureActiveProjection: () => projected,
    });
    const first = await openReady(fixture.manager, "one.md");
    const firstSession = fixture.manager.snapshot().activeRuntime
      ?.session as ReadyDocumentSession;
    projected = {
      ...firstSession,
      mode: "source",
      selection: { kind: "source", anchor: 5, head: 5 },
      anchor: { kind: "source", offset: 5, scrollTop: 33 },
    };

    expect(await fixture.manager.close(first)).toEqual({ status: "settled" });
    expect(fixture.manager.snapshot().collection.recentlyClosed[0]?.view).toEqual({
      mode: "source",
      selection: { kind: "source", anchor: 5, head: 5 },
      anchor: { kind: "source", offset: 5, scrollTop: 33 },
    });
  });

  it("revalidates a recent path, preserves failed records and restores view on success", async () => {
    let projected: ReadyDocumentSession | null = null;
    const fixture = managerFixture({
      captureActiveProjection: () => projected,
    });
    const tabId = await openReady(fixture.manager, "recent.md");
    const current = fixture.manager.snapshot().activeRuntime
      ?.session as ReadyDocumentSession;
    projected = {
      ...current,
      mode: "source",
      selection: { kind: "source", anchor: 4, head: 4 },
      anchor: { kind: "source", offset: 4, scrollTop: 29 },
    };
    await fixture.manager.close(tabId);
    const recent =
      fixture.manager.snapshot().collection.recentlyClosed[0];
    if (!recent) throw new Error("missing recent tab");

    vi.mocked(fixture.gateway.resolvePath).mockRejectedValueOnce({
      code: "path_not_found",
      messageKey: "error.desktop.path_not_found",
      pathHint: "recent.md",
      contentSafe: true,
      retryable: true,
    });
    expect(
      await fixture.manager.reopenRecentlyClosed(recent.pathIdentity, {
        writable: true,
      }),
    ).toMatchObject({ status: "failed", error: { code: "path_not_found" } });
    expect(fixture.manager.snapshot().collection.recentlyClosed).toHaveLength(1);

    const reopened = await fixture.manager.reopenRecentlyClosed(
      recent.pathIdentity,
      { writable: true },
    );
    expect(reopened.status).toBe("opened");
    expect(fixture.manager.snapshot().collection.recentlyClosed).toHaveLength(0);
    expect(fixture.manager.snapshot().activeRuntime?.session).toMatchObject({
      status: "ready",
      mode: "source",
      selection: { anchor: 4, head: 4 },
      anchor: { offset: 4, scrollTop: 29 },
    });
  });

  it("discards only the recent record and marks serialized revisions", async () => {
    const { manager } = managerFixture();
    const tabId = await openReady(manager, "discard.md");
    await manager.close(tabId);
    const recent = manager.snapshot().collection.recentlyClosed[0];
    if (!recent) throw new Error("missing recent tab");

    expect(manager.discardRecentlyClosed(recent.pathIdentity)).toBe(true);
    expect(manager.snapshot().collection.recentlyClosed).toEqual([]);
    const revision = manager.snapshot().collection.revision;
    expect(manager.markPersisted(revision)).toBe(true);
    expect(manager.snapshot().collection.persistedRevision).toBe(revision);
    expect(manager.markPersisted(revision)).toBe(false);
  });

  it("records actual adapter mounts with a maximum of one active projection", async () => {
    const { manager } = managerFixture();
    const first = await openReady(manager, "one.md");
    const firstTab = manager.snapshot().collection.tabsById.get(first);
    if (!firstTab) throw new Error("missing first tab");
    manager.noteAdapterMounted(first, firstTab.incarnation, "visual");
    manager.noteAdapterUnmounted(first, firstTab.incarnation, "visual");

    const second = await openReady(manager, "two.md");
    const secondTab = manager.snapshot().collection.tabsById.get(second);
    if (!secondTab) throw new Error("missing second tab");
    manager.noteAdapterMounted(second, secondTab.incarnation, "source");

    expect(manager.adapterLifecycleSnapshot()).toEqual({
      activeCount: 1,
      peakActiveCount: 1,
      mounts: 2,
      unmounts: 1,
      violations: 0,
    });
  });

  it("settles every loaded controller before destroying runtimes", async () => {
    const { manager, recovery } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    editSession(manager, first, "# one dirty");
    editSession(manager, second, "# two dirty");

    expect(await manager.destroy()).toEqual({ status: "settled" });
    expect(manager.snapshot().runtimes).toHaveLength(0);
    expect(recovery.releaseActive).toHaveBeenCalledWith(
      "workspace-a",
      "one.md",
    );
    expect(recovery.releaseActive).toHaveBeenCalledWith(
      "workspace-a",
      "two.md",
    );
  });

  it("closes a settled batch in one collection commit without partial removal", async () => {
    const { manager } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    const third = await openReady(manager, "three.md");
    const before = manager.snapshot().collection.revision;
    const targets = [first, second].map((tabId) => {
      const tab = manager.snapshot().collection.tabsById.get(tabId);
      if (!tab) throw new Error("missing tab");
      return { tabId, incarnation: tab.incarnation };
    });

    expect(await manager.settleTabs(targets)).toEqual([
      { ...targets[0], outcome: { status: "already_safe" } },
      { ...targets[1], outcome: { status: "already_safe" } },
    ]);
    expect(await manager.closeTabsAtomically(targets)).toBe(true);

    const snapshot = manager.snapshot();
    expect(snapshot.collection.orderedTabIds).toEqual([third]);
    expect(snapshot.collection.activeTabId).toBe(third);
    expect(snapshot.collection.revision).toBe(before + 1);
    expect(snapshot.runtimes.has(first)).toBe(false);
    expect(snapshot.runtimes.has(second)).toBe(false);
    expect(snapshot.collection.recentlyClosed.map((item) => item.relativePath))
      .toEqual(["two.md", "one.md"]);
  });

  it("settles mixed dirty tabs without removing any target on a partial save failure", async () => {
    const { manager, save } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    editSession(manager, first, "# one dirty");
    editSession(manager, second, "# two dirty");
    vi.mocked(save.write).mockImplementation(
      async (_workspaceId, relativePath, content) => {
        if (relativePath === "two.md") {
          throw {
            code: "safe_write_failed",
            messageKey: "safe_write_failed",
            pathHint: relativePath,
            contentSafe: true,
            retryable: true,
          };
        }
        return {
          relativePath,
          bytesWritten: content.length,
          revision: {
            ...revision,
            size: content.length,
            contentHash: `saved:${content}`,
          },
          durability: "file_and_directory",
          durabilityIssue: null,
        };
      },
    );
    const snapshot = manager.snapshot();
    const targets = [first, second].map((tabId) => {
      const tab = snapshot.collection.tabsById.get(tabId);
      if (!tab) throw new Error("missing tab");
      return { tabId, incarnation: tab.incarnation };
    });

    expect(await manager.settleTabs(targets)).toEqual([
      { ...targets[0], outcome: { status: "saved" } },
      {
        ...targets[1],
        outcome: { status: "blocked", reason: "failed" },
      },
    ]);
    expect(manager.snapshot().collection.orderedTabIds).toEqual([first, second]);
    expect(manager.snapshot().runtimes.get(first)?.session).toMatchObject({
      status: "ready",
      saveState: { kind: "saved" },
    });
    expect(manager.snapshot().runtimes.get(second)?.session).toMatchObject({
      status: "ready",
      saveState: { kind: "save_failed" },
    });
  });

  it("rejects a stale batch before closing any tab", async () => {
    const { manager } = managerFixture();
    const first = await openReady(manager, "one.md");
    const second = await openReady(manager, "two.md");
    const before = manager.snapshot();
    const firstTab = before.collection.tabsById.get(first);
    const secondTab = before.collection.tabsById.get(second);
    if (!firstTab || !secondTab) throw new Error("missing tabs");

    await expect(
      manager.closeTabsAtomically([
        { tabId: first, incarnation: firstTab.incarnation },
        { tabId: second, incarnation: secondTab.incarnation + 1 },
      ]),
    ).rejects.toThrow("changed before close");
    expect(manager.snapshot().collection.orderedTabIds).toEqual([first, second]);
    expect(manager.snapshot().runtimes).toHaveLength(2);
  });

  it("refuses an atomic close when content changes during asynchronous abandonment", async () => {
    const { manager, recovery } = managerFixture();
    const tabId = await openReady(manager, "one.md");
    const tab = manager.snapshot().collection.tabsById.get(tabId);
    if (!tab) throw new Error("missing tab");
    const pinned = manager.pinSettlementTargets([
      { tabId, incarnation: tab.incarnation },
    ]);
    let finishRelease!: () => void;
    vi.mocked(recovery.releaseActive).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRelease = () => resolve(true);
        }),
    );

    const closing = manager.closeTabsAtomically(pinned);
    await vi.waitFor(() =>
      expect(recovery.releaseActive).toHaveBeenCalledWith(
        "workspace-a",
        "one.md",
      ),
    );
    editSession(manager, tabId, "# changed while delete was in flight");
    finishRelease();

    await expect(closing).rejects.toThrow("session changed before close");
    expect(manager.snapshot().collection.orderedTabIds).toEqual([tabId]);
    expect(manager.snapshot().runtimes.get(tabId)?.session).toMatchObject({
      status: "ready",
      markdown: "# changed while delete was in flight",
      saveState: { kind: "dirty" },
    });
  });

  it("atomically remaps descriptor identity and runtime markdown", async () => {
    const { manager } = managerFixture();
    const tabId = await openReady(manager, "guides/note.md");
    const before = manager.snapshot();
    const tab = before.collection.tabsById.get(tabId);
    const session = before.runtimes.get(tabId)?.session;
    if (!tab || session?.status !== "ready") throw new Error("missing runtime");

    expect(
      manager.remapTabsAtomically([
        {
          tabId,
          incarnation: tab.incarnation,
          path: {
            relativePath: "archive/note.md",
            identity: "native:archive/note.md",
          },
          markdown: "# moved\n\n![img](../assets/a.png)",
          expectedGeneration: session.generation,
          expectedEditVersion: session.editVersion,
        },
      ]),
    ).toBe(true);

    const snapshot = manager.snapshot();
    expect(snapshot.collection.tabsById.get(tabId)).toMatchObject({
      relativePath: "archive/note.md",
      pathIdentity: "native:archive/note.md",
      displayName: "note.md",
      parentHint: "archive",
    });
    expect(snapshot.runtimes.get(tabId)?.session).toMatchObject({
      status: "ready",
      relativePath: "archive/note.md",
      markdown: "# moved\n\n![img](../assets/a.png)",
      saveState: { kind: "dirty" },
    });
  });

  it("settles an active runtime rewrite without restoring the stale mounted projection", async () => {
    let projected: ReadyDocumentSession | null = null;
    const fixture = managerFixture({
      captureActiveProjection: () => projected,
    });
    const tabId = await openReady(fixture.manager, "note.md");
    const before = fixture.manager.snapshot();
    const tab = before.collection.tabsById.get(tabId);
    const session = before.runtimes.get(tabId)?.session;
    if (!tab || session?.status !== "ready") throw new Error("missing runtime");
    projected = session;

    fixture.manager.remapTabsAtomically([
      {
        tabId,
        incarnation: tab.incarnation,
        path: {
          relativePath: "archive/note.md",
          identity: "native:archive/note.md",
        },
        markdown: "# moved\n\n![asset](../assets/a.png)",
        expectedGeneration: session.generation,
        expectedEditVersion: session.editVersion,
      },
    ]);
    const attempts = await fixture.manager.settleTabs(
      [{ tabId, incarnation: tab.incarnation }],
      { captureActiveProjection: false },
    );

    expect(attempts).toEqual([
      {
        tabId,
        incarnation: tab.incarnation,
        outcome: { status: "saved" },
      },
    ]);
    expect(fixture.save.write).toHaveBeenCalledWith(
      "workspace-a",
      "archive/note.md",
      "# moved\n\n![asset](../assets/a.png)",
      revision,
    );
    expect(fixture.manager.snapshot().runtimes.get(tabId)?.session).toMatchObject({
      status: "ready",
      relativePath: "archive/note.md",
      markdown: "# moved\n\n![asset](../assets/a.png)",
      saveState: { kind: "saved" },
    });
  });
});
