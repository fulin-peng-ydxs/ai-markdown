import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FileRevision, WorkspaceRelativePath } from "../../services/desktop/contracts";
import {
  applyDocumentEdit,
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { acceptWorkspaceTabPath } from "./tabPath";
import {
  createWorkspaceTabDescriptor,
  type WorkspaceTabRuntime,
} from "./tabTypes";
import { WorkspaceTabBar } from "./WorkspaceTabBar";

const revision: FileRevision = {
  modifiedAt: 1,
  size: 6,
  contentHash: "hash",
  encoding: "utf8",
  lineEnding: "lf",
};

function readySession(
  relativePath: WorkspaceRelativePath,
  dirty = false,
): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath,
  });
  const ready = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath,
      status: "ready",
      content: "# Note",
      revision,
    },
    { mode: "visual", reasons: [] },
    true,
  );
  if (ready.status !== "ready" || !dirty) return ready as ReadyDocumentSession;
  const edited = applyDocumentEdit(ready, {
    generation: ready.generation,
    expectedEditVersion: ready.editVersion,
    markdown: "# Changed",
    mode: ready.mode,
    selection: ready.selection,
    anchor: ready.anchor,
    transactionGroup: null,
  });
  if (edited.status !== "applied") throw new Error("expected dirty session");
  return edited.session;
}

function tabSnapshot(
  paths: readonly string[],
  activeIndex = 0,
  dirtyIndex: number | null = null,
): WorkspaceTabManagerSnapshot {
  const tabs = paths.map((path, index) => {
    const relativePath = path as WorkspaceRelativePath;
    return {
      ...createWorkspaceTabDescriptor(
        {
          tabId: `tab-${index}`,
          workspaceId: "workspace-a",
          path: acceptWorkspaceTabPath({
            relativePath,
            identity: `native:${path}`,
          }),
          lastActivatedAt: index + 1,
        },
        index + 1,
      ),
      loadState: { kind: "ready" as const, generation: 1 },
    };
  });
  const tabsById = new Map(tabs.map((tab) => [tab.tabId, tab]));
  const runtimes = new Map<string, WorkspaceTabRuntime>(
    tabs.map((tab, index) => [
      tab.tabId,
      {
        incarnation: tab.incarnation,
        session: readySession(tab.relativePath, index === dirtyIndex),
        saveController: null,
      },
    ]),
  );
  const activeTab = tabs[activeIndex] ?? null;
  return {
    collection: {
      workspaceId: "workspace-a",
      orderedTabIds: tabs.map((tab) => tab.tabId),
      activeTabId: activeTab?.tabId ?? null,
      tabsById,
      pathIndex: new Map(
        tabs.map((tab) => [tab.pathIdentity, tab.tabId]),
      ),
      recentlyClosed: [],
      nextIncarnation: tabs.length + 1,
      revision: tabs.length,
      persistedRevision: 0,
    },
    runtimes,
    activeTab,
    activeRuntime: activeTab
      ? runtimes.get(activeTab.tabId) ?? null
      : null,
  };
}

function renderBar(snapshot = tabSnapshot(["guides/note.md", "drafts/note.md"], 0, 1)) {
  const actions = {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onDiscardRecent: vi.fn(),
    onMove: vi.fn(),
    onReopen: vi.fn().mockResolvedValue({
      status: "opened" as const,
      tabId: "reopened-tab",
    }),
  };
  render(<WorkspaceTabBar {...actions} snapshot={snapshot} />);
  return actions;
}

describe("WorkspaceTabBar", () => {
  it("shows duplicate parent hints and a non-color save state", () => {
    renderBar();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("guides")).toBeTruthy();
    expect(screen.getByText("drafts")).toBeTruthy();
    expect(tabs[1]?.getAttribute("title")).toContain("未保存");
    expect(tabs[1]?.textContent).toContain("未保存");
  });

  it("supports roving activation, keyboard sorting and keyboard close", async () => {
    const actions = renderBar();
    const user = userEvent.setup();
    const first = screen.getAllByRole("tab")[0] as HTMLButtonElement;
    first.focus();

    await user.keyboard("{ArrowRight}");
    expect(actions.onActivate).toHaveBeenCalledWith("tab-1");
    expect(document.activeElement).toBe(screen.getAllByRole("tab")[1]);

    await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    expect(actions.onMove).toHaveBeenCalledWith("tab-1", 0);
    await user.keyboard("{Delete}");
    expect(actions.onClose).toHaveBeenCalledWith("tab-1");
  });

  it("lists fifty tabs in the overflow menu and restores trigger focus on Escape", async () => {
    const paths = Array.from({ length: 50 }, (_, index) => `folder-${index}/note-${index}.md`);
    renderBar(tabSnapshot(paths));
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "所有页签" });
    await user.click(trigger);
    expect(screen.getAllByRole("menuitem")).toHaveLength(50);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("shares keyboard menu behavior for context actions and keeps unsafe batch close disabled", async () => {
    const actions = renderBar();
    const second = screen.getAllByRole("tab")[1] as HTMLButtonElement;
    fireEvent.contextMenu(second, { clientX: 240, clientY: 72 });
    const menu = await screen.findByRole("menu", {
      name: /note\.md 页签操作/,
    });
    expect(menu).toBeTruthy();
    const closeOthers = screen.getByRole("menuitem", {
      name: /关闭其他页签/,
    }) as HTMLButtonElement;
    expect(closeOthers.disabled).toBe(true);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /向左移动/ }),
    );
    expect(actions.onMove).toHaveBeenCalledWith("tab-1", 0);
  });

  it("commits a drag order only after a valid drop target", () => {
    const actions = renderBar();
    const tabs = screen.getAllByRole("tab");
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    fireEvent.dragStart(tabs[0]!, { dataTransfer });
    fireEvent.dragOver(tabs[1]!, { dataTransfer });
    fireEvent.drop(tabs[1]!, { dataTransfer });
    expect(actions.onMove).toHaveBeenCalledWith("tab-0", 1);
  });

  it("reopens a recent tab and offers safe record removal after failure", async () => {
    const snapshot = tabSnapshot(["open.md"]);
    const recentPath = acceptWorkspaceTabPath({
      relativePath: "missing.md",
      identity: "native:missing.md",
    });
    const withRecent: WorkspaceTabManagerSnapshot = {
      ...snapshot,
      collection: {
        ...snapshot.collection,
        recentlyClosed: [{
          workspaceId: "workspace-a",
          relativePath: recentPath.relativePath,
          pathIdentity: recentPath.identity,
          displayName: "missing.md",
          parentHint: null,
          view: null,
          closedAt: 10,
        }],
      },
    };
    const actions = renderBar(withRecent);
    actions.onReopen.mockResolvedValueOnce({
      status: "failed",
      error: {
        code: "path_not_found",
        messageKey: "error.desktop.path_not_found",
        pathHint: "missing.md",
        contentSafe: true,
        retryable: true,
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "所有页签" }));
    await user.click(
      screen.getByRole("menuitem", { name: /重新打开 missing\.md/ }),
    );
    await waitFor(() =>
      expect(actions.onReopen).toHaveBeenCalledWith(recentPath.identity),
    );

    await user.click(screen.getByRole("button", { name: "所有页签" }));
    expect(
      screen.getByRole("menuitem", { name: /重新打开 missing\.md/ })
        .textContent,
    ).toContain("原路径已经不存在");
    await user.click(
      screen.getByRole("menuitem", { name: /移除失效记录 missing\.md/ }),
    );
    expect(actions.onDiscardRecent).toHaveBeenCalledWith(recentPath.identity);
  });
});
