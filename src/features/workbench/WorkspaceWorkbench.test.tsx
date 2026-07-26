import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  FsEntry,
  MarkdownReadResult,
  WorkspaceRelativePath,
  WindowSettlementIntent,
  WorkspaceDescriptor,
  WorkspaceScanBatch,
} from "../../services/desktop/contracts";
import { WorkspaceWorkbench } from "./WorkspaceWorkbench";
import type { WorkspaceWorkbenchGateway } from "./workbenchGateway";

const workspace: WorkspaceDescriptor = {
  id: "workspace-a",
  selectedPath: "/tmp/notes",
  canonicalRoot: "/tmp/notes",
  displayName: "notes",
  writable: true,
  initialFile: null,
};

const note: FsEntry = {
  relativePath: "note.md",
  name: "note.md",
  kind: "markdown_file",
  writable: true,
  symlink: false,
  childrenState: "not_loaded",
};

const folder: FsEntry = {
  relativePath: "guides",
  name: "guides",
  kind: "directory",
  writable: true,
  symlink: false,
  childrenState: "not_loaded",
};

const secondNote: FsEntry = {
  ...note,
  relativePath: "second.md",
  name: "second.md",
};

function gateway(overrides: Partial<WorkspaceWorkbenchGateway> = {}): WorkspaceWorkbenchGateway {
  const completeScan: WorkspaceScanBatch = {
    scanId: "scan-1",
    processed: 2,
    entries: [note, folder],
    issues: [],
    complete: true,
    cancelled: false,
  };
  return {
    resolveTabPath: vi.fn().mockImplementation(
      async (_workspaceId, relativePath: string) => ({
        relativePath,
        identity: `native:${relativePath}`,
      }),
    ),
    getTabSession: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      workspaceId: "workspace-a",
      windowStateRef: "window-session-a",
      revision: 0,
      tabs: [],
      activeRelativePath: null,
      recentlyClosed: [],
      updatedAt: 0,
      issues: [],
    }),
    saveTabSession: vi.fn().mockImplementation(
      async (_workspaceId, windowStateRef, expectedRevision, snapshot) => ({
        workspaceId: "workspace-a",
        windowStateRef: windowStateRef ?? "window-session-a",
        revision: expectedRevision + 1,
        tabCount: snapshot.tabs.length,
        updatedAt: snapshot.updatedAt,
      }),
    ),
    scan: vi.fn().mockImplementation(
      (_workspaceId, directory: string | null) =>
        Promise.resolve({
          scanId: directory ? `scan-${directory}` : "scan-1",
          workspaceId: workspace.id,
          directory,
        }),
    ),
    pollScan: vi.fn().mockImplementation((scanId: string) =>
      Promise.resolve(
        scanId === "scan-1"
          ? completeScan
          : {
              scanId,
              processed: 0,
              entries: [],
              issues: [],
              complete: true,
              cancelled: false,
            },
      ),
    ),
    cancelScan: vi.fn().mockResolvedValue(true),
    watch: vi.fn().mockResolvedValue({ watchId: "watch-1", workspaceId: workspace.id }),
    restartWatch: vi.fn().mockResolvedValue({ watchId: "watch-2", workspaceId: workspace.id }),
    pollWatch: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    stopWatch: vi.fn().mockResolvedValue(true),
    read: vi.fn().mockResolvedValue({
      relativePath: "note.md",
      status: "ready",
      content: "# 真实文档\n\n本地内容。",
      revision: { modifiedAt: 1, size: 28, contentHash: "abc", encoding: "utf8", lineEnding: "lf" },
    }),
    createFile: vi.fn().mockResolvedValue({
      kind: "create_file",
      previousPath: null,
      entry: { ...note, relativePath: "new.md", name: "new.md" },
    }),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    inspectMoveRisk: vi.fn().mockResolvedValue({
      entryKind: "directory",
      configuredAssetDirectoryAffected: false,
      containsSupportedImages: false,
      inspectionLimited: false,
      mayBreakImageLinks: false,
    }),
    move: vi.fn(),
    trash: vi.fn(),
    reveal: vi.fn().mockResolvedValue(undefined),
    selectFolder: vi.fn().mockResolvedValue({ status: "cancelled" }),
    selectMarkdown: vi.fn().mockResolvedValue({ status: "cancelled" }),
    authorize: vi.fn(),
    cancelSelection: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockResolvedValue({ status: "cancelled" }),
    setTitle: vi.fn().mockResolvedValue(undefined),
    listenMenu: vi.fn().mockResolvedValue(() => undefined),
    listenWorkbenchMenu: vi.fn().mockResolvedValue(() => undefined),
    updateEditorMenu: vi.fn().mockResolvedValue(undefined),
    resetEditorMenu: vi.fn().mockResolvedValue(undefined),
    listenSettlement: vi.fn().mockResolvedValue(() => undefined),
    resolveSettlement: vi.fn().mockResolvedValue({ status: "cancelled" }),
    saveGateway: {
      write: vi.fn(),
      prepareOverwrite: vi.fn(),
      confirmOverwrite: vi.fn(),
      cancelOverwrite: vi.fn(),
      prepareSaveCopy: vi.fn(),
      confirmSaveCopy: vi.fn(),
      cancelSaveCopy: vi.fn(),
    },
    recoveryGateway: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      registerActive: vi.fn().mockResolvedValue(true),
      releaseActive: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
      cleanup: vi.fn(),
    },
    assetGateway: {
      getPreference: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        assetDirectory: "assets",
      }),
      setDirectory: vi.fn(),
      resetDirectory: vi.fn(),
      beginUpload: vi.fn(),
      upload: vi.fn(),
      select: vi.fn().mockResolvedValue({ status: "cancelled" }),
      confirm: vi.fn(),
      cancel: vi.fn(),
      read: vi.fn(),
    },
    ...overrides,
  };
}

describe("WorkspaceWorkbench", () => {
  it("resolves a native close intent only after the current document is safe", async () => {
    let settlementListener:
      | ((intent: WindowSettlementIntent) => void)
      | undefined;
    const resolveSettlement = vi
      .fn()
      .mockResolvedValue({ status: "closed", windowLabel: "plainroot-window-1" });
    const api = gateway({
      listenSettlement: vi.fn().mockImplementation(async (
        listener: (intent: WindowSettlementIntent) => void,
      ) => {
        settlementListener = listener;
        return () => undefined;
      }),
      resolveSettlement,
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText("磁盘版本");
    await waitFor(() => expect(settlementListener).toBeDefined());

    await act(async () => {
      settlementListener?.({
        intentId: "settlement-1",
        kind: "close_window",
        windowLabel: "plainroot-window-1",
      });
    });

    await waitFor(() =>
      expect(resolveSettlement).toHaveBeenCalledWith("settlement-1", true),
    );
  });

  it("reads a real tree entry and shows only the returned Markdown content", async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));

    expect(await screen.findByText(/真实文档/)).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "文档编辑工具" })).toBeTruthy();
    expect(screen.getAllByText("磁盘版本")).toHaveLength(1);
    expect(api.read).toHaveBeenCalledWith("workspace-a", "note.md");
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith("note.md"));
  });

  it("keeps the previous tree selection when tab path resolution fails", async () => {
    const completeScan: WorkspaceScanBatch = {
      scanId: "scan-1",
      processed: 3,
      entries: [note, secondNote, folder],
      issues: [],
      complete: true,
      cancelled: false,
    };
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue(completeScan),
      resolveTabPath: vi.fn().mockImplementation(
        async (_workspaceId, relativePath: string) => {
          if (relativePath === "second.md") {
            throw new Error("path identity unavailable");
          }
          return {
            relativePath,
            identity: `native:${relativePath}`,
          };
        },
      ),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    const first = await screen.findByRole("treeitem", { name: /note\.md/ });
    await user.click(first);
    await screen.findByText(/真实文档/);
    expect(first.getAttribute("aria-selected")).toBe("true");

    const second = screen.getByRole("treeitem", { name: /second\.md/ });
    await user.click(second);
    await screen.findByRole("alert");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the native menu bound to the focused document session and routes real actions", async () => {
    let menuListener:
      | Parameters<WorkspaceWorkbenchGateway["listenWorkbenchMenu"]>[0]
      | undefined;
    const api = gateway({
      listenWorkbenchMenu: vi.fn().mockImplementation(async (listener) => {
        menuListener = listener;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    const rendered = render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await waitFor(() => expect(menuListener).toBeDefined());
    act(() => menuListener?.("file.save_copy"));
    expect(
      screen.queryByRole("heading", {
        name: "保存一份独立的 Markdown 副本",
      }),
    ).toBeNull();

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText(/真实文档/);
    await waitFor(() =>
      expect(api.updateEditorMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          hasDocument: true,
          readOnly: false,
          mode: "visual",
        }),
      ),
    );

    act(() => menuListener?.("view.source"));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(api.updateEditorMenu).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "source" }),
      ),
    );

    act(() => menuListener?.("file.save_copy"));
    expect(
      await screen.findByRole("heading", {
        name: "保存一份独立的 Markdown 副本",
      }),
    ).toBeTruthy();
  });

  it("shows mode, save, counts, source format and cursor in the real status bar", async () => {
    const rendered = render(
      <WorkspaceWorkbench
        gateway={gateway()}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText(/真实文档/);

    const statusbar = rendered.container.querySelector(
      ".workbench__statusbar",
    );
    expect(statusbar?.textContent).toContain("磁盘版本");
    expect(statusbar?.textContent).toContain("排版编辑");
    expect(statusbar?.textContent).toContain("字/词");
    expect(statusbar?.textContent).toContain("UTF-8 · LF");
    expect(statusbar?.textContent).toContain("排版光标");
    expect(statusbar?.textContent).toContain("note.md");
    expect(
      rendered.container.querySelectorAll(".document-save-status"),
    ).toHaveLength(1);
    expect(
      rendered.container.querySelector(
        ".document-editor-toolbar__actions [aria-label=\"保存当前文档\"]",
      ),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector(
        ".document-editor-toolbar__actions [aria-label=\"切换源码并查找\"]",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "设置图片资源目录" }).textContent,
    ).toBe("⋯");
  });

  it("offers explicit local-image link adjustment before moving an open document", async () => {
    const api = gateway({
      read: vi.fn().mockResolvedValue({
        relativePath: "note.md",
        status: "ready",
        content: "# Note\n\n![cover](assets/cover.png)",
        revision: {
          modifiedAt: 1,
          size: 36,
          contentHash: "image-doc",
          encoding: "utf8",
          lineEnding: "lf",
        },
      }),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText("Note");
    await user.click(screen.getByRole("button", { name: "移动" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "移动后同步调整 1 个本地图片链接",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("requires explicit confirmation before moving a directory that may break image links", async () => {
    const api = gateway({
      inspectMoveRisk: vi.fn().mockResolvedValue({
        entryKind: "directory",
        configuredAssetDirectoryAffected: true,
        containsSupportedImages: true,
        inspectionLimited: false,
        mayBreakImageLinks: true,
      }),
      move: vi.fn().mockResolvedValue({
        kind: "move",
        previousPath: "guides",
        entry: { ...folder, relativePath: "archive/guides" },
      }),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /guides/ }));
    await user.click(screen.getByRole("button", { name: "移动" }));
    const target = screen.getByLabelText("目标文件夹（留空表示根目录）");
    await user.clear(target);
    await user.type(target, "archive");
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    expect(api.inspectMoveRisk).toHaveBeenCalledWith("workspace-a", "guides");
    expect(api.move).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/未打开 Markdown 文档中的相对图片链接可能失效/),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", {
        name: "继续移动（链接可能失效）",
      }),
    );
    await waitFor(() =>
      expect(api.move).toHaveBeenCalledWith(
        "workspace-a",
        "guides",
        "archive",
      ),
    );
  });

  it("cancels a directory move from the image-link risk confirmation without touching disk", async () => {
    const api = gateway({
      inspectMoveRisk: vi.fn().mockResolvedValue({
        entryKind: "directory",
        configuredAssetDirectoryAffected: false,
        containsSupportedImages: false,
        inspectionLimited: true,
        mayBreakImageLinks: true,
      }),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /guides/ }));
    await user.click(screen.getByRole("button", { name: "移动" }));
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));
    expect(await screen.findByText(/未能完整检查所选目录/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.move).not.toHaveBeenCalled();
  });

  it("moves a directory immediately after a clean image-link risk inspection", async () => {
    const api = gateway({
      move: vi.fn().mockResolvedValue({
        kind: "move",
        previousPath: "guides",
        entry: { ...folder, relativePath: "archive/guides" },
      }),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /guides/ }));
    await user.click(screen.getByRole("button", { name: "移动" }));
    const target = screen.getByLabelText("目标文件夹（留空表示根目录）");
    await user.clear(target);
    await user.type(target, "archive");
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    await waitFor(() =>
      expect(api.move).toHaveBeenCalledWith(
        "workspace-a",
        "guides",
        "archive",
      ),
    );
    expect(
      screen.queryByRole("button", {
        name: "继续移动（链接可能失效）",
      }),
    ).toBeNull();
  });

  it("does not let a slower old document read replace the latest selection", async () => {
    let resolveFirst!: (value: MarkdownReadResult) => void;
    const firstRead = new Promise<MarkdownReadResult>((resolve) => {
      resolveFirst = resolve;
    });
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue({
        scanId: "scan-1",
        processed: 2,
        entries: [note, secondNote],
        issues: [],
        complete: true,
        cancelled: false,
      }),
      read: vi.fn().mockImplementation((_workspaceId, path) =>
        path === "note.md"
          ? firstRead
          : Promise.resolve({
              relativePath: "second.md",
              status: "ready",
              content: "# 第二份文档",
              revision: {
                modifiedAt: 2,
                size: 8,
                contentHash: "second",
                encoding: "utf8",
                lineEnding: "lf",
              },
            }),
      ),
    });
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await user.click(await screen.findByRole("treeitem", { name: /second\.md/ }));
    expect(await screen.findByText(/第二份文档/)).toBeTruthy();
    await waitFor(() =>
      expect(api.setTitle).toHaveBeenLastCalledWith("second.md"),
    );

    resolveFirst({
      relativePath: "note.md",
      status: "ready",
      content: "# 过期文档",
      revision: {
        modifiedAt: 1,
        size: 7,
        contentHash: "first",
        encoding: "utf8",
        lineEnding: "lf",
      },
    });
    await Promise.resolve();

    expect(screen.getByText(/第二份文档/)).toBeTruthy();
    expect(api.setTitle).toHaveBeenLastCalledWith("second.md");
    expect(screen.queryByText(/过期文档/)).toBeNull();
  });

  it("keeps independent tab sessions while the file tree switches the single active editor", async () => {
    const read = vi.fn().mockImplementation(
      async (_workspaceId, path: WorkspaceRelativePath) => ({
        relativePath: path,
        status: "ready" as const,
        content: path === "note.md" ? "# First" : "# Second",
        revision: {
          modifiedAt: 1,
          size: 8,
          contentHash: `hash:${path}`,
          encoding: "utf8" as const,
          lineEnding: "lf" as const,
        },
      }),
    );
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue({
        scanId: "scan-1",
        processed: 2,
        entries: [note, secondNote],
        issues: [],
        complete: true,
        cancelled: false,
      }),
      read,
    });
    const user = userEvent.setup();
    const rendered = render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText("First");
    await user.click(screen.getByRole("button", { name: "源码" }));
    await waitFor(() =>
      expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1),
    );

    await user.click(screen.getByRole("treeitem", { name: /second\.md/ }));
    await screen.findByText("Second");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      rendered.container.querySelectorAll(".cm-editor, .milkdown"),
    ).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: /note\.md/ }));
    await waitFor(() =>
      expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1),
    );
    expect(await screen.findByText("First")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("closes a clean tab from the visible tab strip and activates its neighbor", async () => {
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue({
        scanId: "scan-1",
        processed: 2,
        entries: [note, secondNote],
        issues: [],
        complete: true,
        cancelled: false,
      }),
      read: vi.fn().mockImplementation(async (_workspaceId, path) => ({
        relativePath: path,
        status: "ready",
        content: path === "note.md" ? "# First" : "# Second",
        revision: {
          modifiedAt: 1,
          size: 8,
          contentHash: `hash:${path}`,
          encoding: "utf8",
          lineEnding: "lf",
        },
      })),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText("First");
    await user.click(screen.getByRole("treeitem", { name: /second\.md/ }));
    await screen.findByText("Second");
    await user.click(screen.getByRole("button", { name: "关闭 second.md" }));

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /second\.md/ })).toBeNull(),
    );
    expect(screen.getByRole("tab", { name: /note\.md/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("First")).toBeTruthy();
  });

  it("reopens a recently closed tab through the overflow menu", async () => {
    const read = vi.fn().mockImplementation(async (_workspaceId, path) => ({
      relativePath: path,
      status: "ready",
      content: path === "note.md" ? "# First" : "# Second",
      revision: {
        modifiedAt: 1,
        size: 8,
        contentHash: `hash:${path}`,
        encoding: "utf8",
        lineEnding: "lf",
      },
    }));
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue({
        scanId: "scan-1",
        processed: 2,
        entries: [note, secondNote],
        issues: [],
        complete: true,
        cancelled: false,
      }),
      read,
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText("First");
    await user.click(screen.getByRole("treeitem", { name: /second\.md/ }));
    await screen.findByText("Second");
    await user.click(screen.getByRole("button", { name: "关闭 second.md" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /second\.md/ })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "所有页签" }));
    await user.click(
      screen.getByRole("menuitem", { name: /重新打开 second\.md/ }),
    );

    expect(await screen.findByRole("tab", { name: /second\.md/ })).toBeTruthy();
    expect(await screen.findByText("Second")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("persists the dropped tab order through the revisioned session gateway", async () => {
    const api = gateway({
      pollScan: vi.fn().mockResolvedValue({
        scanId: "scan-1",
        processed: 2,
        entries: [note, secondNote],
        issues: [],
        complete: true,
        cancelled: false,
      }),
      read: vi.fn().mockImplementation(async (_workspaceId, path) => ({
        relativePath: path,
        status: "ready",
        content: `# ${path}`,
        revision: {
          modifiedAt: 1,
          size: 8,
          contentHash: `hash:${path}`,
          encoding: "utf8",
          lineEnding: "lf",
        },
      })),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByRole("heading", { name: "note.md" });
    await user.click(screen.getByRole("treeitem", { name: /second\.md/ }));
    await screen.findByRole("heading", { name: "second.md" });
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

    await waitFor(
      () => {
        expect(api.saveTabSession).toHaveBeenCalled();
        const calls = vi.mocked(api.saveTabSession).mock.calls;
        const persisted = calls.at(-1)?.[3];
        expect(persisted?.tabs.map((tab) => tab.relativePath)).toEqual([
          "second.md",
          "note.md",
        ]);
      },
      { timeout: 1_500 },
    );
  });

  it("blocks a directory move before disk when multiple open tabs are affected", async () => {
    const firstGuide: FsEntry = {
      ...note,
      relativePath: "guides/a.md",
      name: "a.md",
    };
    const secondGuide: FsEntry = {
      ...note,
      relativePath: "guides/b.md",
      name: "b.md",
    };
    const api = gateway({
      scan: vi.fn().mockImplementation((_workspaceId, directory) =>
        Promise.resolve({
          scanId: directory ? "scan-guides" : "scan-root",
          workspaceId: workspace.id,
          directory,
        }),
      ),
      pollScan: vi.fn().mockImplementation((scanId) =>
        Promise.resolve({
          scanId,
          processed: scanId === "scan-root" ? 1 : 2,
          entries:
            scanId === "scan-root"
              ? [folder]
              : [firstGuide, secondGuide],
          issues: [],
          complete: true,
          cancelled: false,
        }),
      ),
      read: vi.fn().mockImplementation(async (_workspaceId, path) => ({
        relativePath: path,
        status: "ready",
        content: `# ${path}`,
        revision: {
          modifiedAt: 1,
          size: 8,
          contentHash: `hash:${path}`,
          encoding: "utf8",
          lineEnding: "lf",
        },
      })),
      move: vi.fn(),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    const folderRow = await screen.findByRole("treeitem", { name: /guides/ });
    await user.click(folderRow);
    await user.click(await screen.findByRole("treeitem", { name: /a\.md/ }));
    await screen.findByRole("heading", { name: "guides/a.md" });
    await user.click(screen.getByRole("treeitem", { name: /b\.md/ }));
    await screen.findByRole("heading", { name: "guides/b.md" });
    await user.click(folderRow);
    await user.click(screen.getByRole("button", { name: "移动" }));
    const target = screen.getByLabelText("目标文件夹（留空表示根目录）");
    await user.clear(target);
    await user.type(target, "archive");
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    expect(
      await screen.findByText(/影响 2 个已打开页签/),
    ).toBeTruthy();
    expect(api.move).not.toHaveBeenCalled();
  });

  it("does not rename an open tab before T40 can atomically remap its runtime", async () => {
    const api = gateway({ rename: vi.fn() });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByRole("heading", { name: "真实文档" });
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByLabelText("新名称");
    await user.clear(input);
    await user.type(input, "renamed.md");
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    expect(
      await screen.findByText(/影响 1 个已打开页签/),
    ).toBeTruthy();
    expect(api.rename).not.toHaveBeenCalled();
  });

  it("opens a dense Markdown document directly in source mode without stale visual content", async () => {
    const denseList = Array.from(
      { length: 2_001 },
      (_, index) => `- item ${index}`,
    ).join("\n");
    const api = gateway({
      read: vi.fn().mockResolvedValue({
        relativePath: "note.md",
        status: "ready",
        content: denseList,
        revision: {
          modifiedAt: 1,
          size: denseList.length,
          contentHash: "dense",
          encoding: "utf8",
          lineEnding: "lf",
        },
      }),
    });
    const user = userEvent.setup();
    const rendered = render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(rendered.container.querySelector(".ProseMirror")).toBeNull();
    expect(screen.getByText(/文档结构过密/)).toBeTruthy();
  });

  it("adds a created file only after the disk gateway succeeds", async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await screen.findByRole("treeitem", { name: /note\.md/ });
    await user.click(screen.getByTitle("新建 Markdown 文档"));
    const input = screen.getByLabelText("文件名");
    await user.clear(input);
    await user.type(input, "new.md");
    expect(screen.queryByRole("treeitem", { name: /new\.md/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    await waitFor(() => expect(api.createFile).toHaveBeenCalledWith("workspace-a", "new.md", null));
    expect(await screen.findByRole("treeitem", { name: /new\.md/ })).toBeTruthy();
    expect(screen.getByText("文件树已同步")).toBeTruthy();
  });

  it("keeps the last safe tree when a disk mutation fails", async () => {
    const api = gateway({
      createFile: vi.fn().mockRejectedValue({
        code: "target_already_exists",
        messageKey: "error.desktop.target_already_exists",
        pathHint: "new.md",
        contentSafe: true,
        retryable: false,
      }),
    });
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await screen.findByRole("treeitem", { name: /note\.md/ });
    await user.click(screen.getByTitle("新建 Markdown 文档"));
    const input = screen.getByLabelText("文件名");
    await user.clear(input);
    await user.type(input, "new.md");
    await user.click(screen.getByRole("button", { name: "提交到磁盘" }));

    expect(await screen.findByText(/目标位置已经存在同名项目/)).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /note\.md/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /new\.md/ })).toBeNull();
  });

  it("keeps the current workspace while a new root waits for an explicit disposition", async () => {
    const target = { ...workspace, id: "workspace-b", displayName: "research", canonicalRoot: "/tmp/research", selectedPath: "/tmp/research" };
    const api = gateway({
      selectFolder: vi.fn().mockResolvedValue({
        status: "ready",
        proposal: {
          selectionId: "selection-2",
          kind: "folder",
          selectedPath: "/tmp/research",
          canonicalRoot: "/tmp/research",
          displayName: "research",
          initialFile: null,
          rootIsSymlink: false,
          scopeConfirmationRequired: false,
          requiresConfirmation: false,
        },
      }),
      authorize: vi.fn().mockResolvedValue(target),
      open: vi.fn()
        .mockResolvedValueOnce({
          status: "decision_required",
          workspace: target,
          currentWorkspaceId: workspace.id,
          currentWorkspaceName: workspace.displayName,
        })
        .mockResolvedValueOnce({ status: "opened_new", workspace: target, windowLabel: "plainroot-window-2" }),
    });
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "打开其他目录" }));
    expect(await screen.findByText(/在哪里打开“research”/)).toBeTruthy();
    expect(screen.getAllByText("notes").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "在新窗口打开" }));

    await waitFor(() => expect(api.open).toHaveBeenLastCalledWith("workspace-b", "new_window"));
    expect(screen.getAllByText("notes").length).toBeGreaterThan(0);
  });

  it("returns focus to the file drawer trigger when the drawer closes", async () => {
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={gateway()} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "显示文件目录" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "关闭文件目录" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves focus into the file drawer and wraps Tab inside it", async () => {
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={gateway()} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "显示文件目录" });
    await user.click(trigger);
    const close = screen.getByRole("button", { name: "关闭文件目录" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    const drawer = screen.getByRole("complementary", { name: "文件目录" });
    const drawerButtons = Array.from(drawer.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const last = drawerButtons.at(-1);
    expect(last).toBeTruthy();
    last?.focus();
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(close);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);
  });

  it("moves keyboard focus through visible file-tree rows", async () => {
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={gateway()} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);
    const folderRow = await screen.findByRole("treeitem", { name: /guides/ });
    const noteRow = screen.getByRole("treeitem", { name: /note\.md/ });
    expect(folderRow.tabIndex).toBe(0);
    expect(noteRow.tabIndex).toBe(-1);
    folderRow.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(noteRow);
    expect(folderRow.tabIndex).toBe(-1);
    expect(noteRow.tabIndex).toBe(0);
  });

  it("moves into an expanded directory and back to its parent with tree keys", async () => {
    const child: FsEntry = {
      ...note,
      relativePath: "guides/inside.md",
      name: "inside.md",
    };
    let scanSequence = 0;
    const api = gateway({
      scan: vi.fn().mockImplementation((_workspaceId, directory) => {
        scanSequence += 1;
        return Promise.resolve({ scanId: `scan-${scanSequence}`, workspaceId: workspace.id, directory });
      }),
      pollScan: vi.fn().mockImplementation((scanId) => Promise.resolve({
        scanId,
        processed: scanId === "scan-1" ? 2 : 1,
        entries: scanId === "scan-1" ? [note, folder] : [child],
        issues: [],
        complete: true,
        cancelled: false,
      })),
    });
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    const folderRow = await screen.findByRole("treeitem", { name: /guides/ });
    await user.click(folderRow);
    const childRow = await screen.findByRole("treeitem", { name: /inside\.md/ });
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(childRow);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(folderRow);
  });

  it("does not offer a no-op retry for an unsupported page error", async () => {
    const api = gateway({
      scan: vi.fn().mockRejectedValue({
        code: "mutation_unavailable",
        messageKey: "error.desktop.mutation_unavailable",
        pathHint: null,
        contentSafe: true,
        retryable: true,
      }),
    });
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    expect(await screen.findByText(/文件操作服务当前不可用/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("repeats the selected reveal action when its retry button is used", async () => {
    const reveal = vi.fn()
      .mockRejectedValueOnce({
        code: "reveal_unavailable",
        messageKey: "error.desktop.reveal_unavailable",
        pathHint: "note.md",
        contentSafe: true,
        retryable: true,
      })
      .mockResolvedValueOnce(undefined);
    const api = gateway({ reveal });
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await user.click(screen.getByRole("button", { name: "定位" }));
    expect(await screen.findByText(/系统文件管理器未能定位/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));
    expect(reveal).toHaveBeenLastCalledWith("workspace-a", "note.md");
  });

  it("serializes duplicate watch rescans for the same directory", async () => {
    let resolveInitialScan: ((batch: WorkspaceScanBatch) => void) | undefined;
    const initialScan = new Promise<WorkspaceScanBatch>((resolve) => {
      resolveInitialScan = resolve;
    });
    let scanSequence = 0;
    const api = gateway({
      scan: vi.fn().mockImplementation((_workspaceId, directory) => {
        scanSequence += 1;
        return Promise.resolve({ scanId: `scan-${scanSequence}`, workspaceId: workspace.id, directory });
      }),
      pollScan: vi.fn().mockImplementation((scanId) => {
        if (scanId === "scan-1") return initialScan;
        return Promise.resolve({
          scanId,
          processed: 2,
          entries: [note, folder],
          issues: [],
          complete: true,
          cancelled: false,
        });
      }),
      pollWatch: vi.fn().mockResolvedValue({
        watchId: "watch-1",
        sequence: 1,
        events: [],
        rescanDirectories: [null, null],
        status: "watching",
        issue: null,
        overflowed: false,
        complete: true,
      }),
    });
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await waitFor(() => expect(api.pollWatch).toHaveBeenCalled());
    expect(api.scan).toHaveBeenCalledTimes(1);
    resolveInitialScan?.({
      scanId: "scan-1",
      processed: 2,
      entries: [note, folder],
      issues: [],
      complete: true,
      cancelled: false,
    });
    await waitFor(() => expect(api.scan).toHaveBeenCalledTimes(2));
  });

  it("restores a matching snapshot into the P1 session without writing the source file", async () => {
    const metadata = {
      snapshotId: "snapshot-a",
      workspaceId: "workspace-a",
      relativePath: "note.md",
      baseRevision: {
        modifiedAt: 1,
        size: 28,
        contentHash: "abc",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      },
      contentHash: "recovered",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      sizeBytes: 24,
    };
    const api = gateway();
    vi.mocked(api.recoveryGateway.list).mockResolvedValue([metadata]);
    vi.mocked(api.recoveryGateway.get).mockResolvedValue({
      metadata,
      content: "# 恢复后的内容",
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    expect(
      await screen.findByRole("heading", {
        name: "检查尚未写入原文件的内容",
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "恢复到编辑区" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    expect(await screen.findByText(/恢复后的内容/)).toBeTruthy();
    expect(
      screen
        .getAllByText("未保存")
        .some((node) => node.closest(".document-save-status")),
    ).toBe(true);
    expect(api.saveGateway.write).not.toHaveBeenCalled();
  });

  it("keeps an externally deleted open document and offers safe copy or protected close", async () => {
    let resolveWatch!: (
      batch: Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>,
    ) => void;
    const watchBatch = new Promise<
      Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>
    >((resolve) => {
      resolveWatch = resolve;
    });
    const api = gateway({
      pollWatch: vi.fn().mockReturnValue(watchBatch),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText(/真实文档/);

    resolveWatch({
      watchId: "watch-1",
      sequence: 1,
      events: [
        {
          kind: "remove",
          paths: ["note.md"],
          source: "external",
          operationId: null,
        },
      ],
      rescanDirectories: [null],
      status: "watching",
      issue: null,
      overflowed: false,
      complete: true,
    });

    expect(await screen.findByText("原文件已不存在")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "另存副本" }).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "安全关闭文档" }),
    ).toBeTruthy();
    expect(screen.getByText(/真实文档/)).toBeTruthy();
  });

  it("refuses to close an externally deleted document when recovery persistence fails", async () => {
    let resolveWatch!: (
      batch: Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>,
    ) => void;
    const api = gateway({
      pollWatch: vi.fn().mockReturnValue(
        new Promise<
          Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>
        >((resolve) => {
          resolveWatch = resolve;
        }),
      ),
    });
    vi.mocked(api.saveGateway.write).mockRejectedValue({
      code: "path_not_found",
      messageKey: "error.desktop.path_not_found",
      pathHint: "note.md",
      contentSafe: true,
      retryable: false,
    });
    vi.mocked(api.recoveryGateway.upsert).mockResolvedValue({
      status: "memory_only",
      snapshot: null,
      issue: {
        code: "recovery_write_failed",
        messageKey: "error.desktop.recovery_write_failed",
        pathHint: "note.md",
        contentSafe: true,
        retryable: true,
      },
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText(/真实文档/);

    resolveWatch({
      watchId: "watch-1",
      sequence: 1,
      events: [
        {
          kind: "remove",
          paths: ["note.md"],
          source: "external",
          operationId: null,
        },
      ],
      rescanDirectories: [null],
      status: "watching",
      issue: null,
      overflowed: false,
      complete: true,
    });

    await user.click(
      await screen.findByRole("button", { name: "安全关闭文档" }),
    );
    expect(
      await screen.findByText(/关闭已取消：恢复副本尚未覆盖当前内容/),
    ).toBeTruthy();
    expect(screen.getByText(/真实文档/)).toBeTruthy();
  });

  it("closes an externally deleted document after recovery covers the current edit", async () => {
    let resolveWatch!: (
      batch: Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>,
    ) => void;
    const api = gateway({
      pollWatch: vi.fn().mockReturnValue(
        new Promise<
          Awaited<ReturnType<WorkspaceWorkbenchGateway["pollWatch"]>>
        >((resolve) => {
          resolveWatch = resolve;
        }),
      ),
    });
    vi.mocked(api.saveGateway.write).mockRejectedValue({
      code: "path_not_found",
      messageKey: "error.desktop.path_not_found",
      pathHint: "note.md",
      contentSafe: true,
      retryable: false,
    });
    vi.mocked(api.recoveryGateway.upsert).mockResolvedValue({
      status: "persisted",
      snapshot: {
        snapshotId: "snapshot-safe-close",
        workspaceId: workspace.id,
        relativePath: "note.md",
        baseRevision: {
          modifiedAt: 1,
          size: 28,
          contentHash: "abc",
          encoding: "utf8",
          lineEnding: "lf",
        },
        contentHash: "recovery",
        createdAt: 1,
        updatedAt: 2,
        expiresAt: 3,
        sizeBytes: 28,
      },
      issue: null,
    });
    const user = userEvent.setup();
    render(
      <WorkspaceWorkbench
        gateway={api}
        initialWorkspace={workspace}
        onWorkspaceChanged={() => undefined}
      />,
    );
    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));
    await screen.findByText(/真实文档/);

    resolveWatch({
      watchId: "watch-1",
      sequence: 1,
      events: [
        {
          kind: "remove",
          paths: ["note.md"],
          source: "external",
          operationId: null,
        },
      ],
      rescanDirectories: [null],
      status: "watching",
      issue: null,
      overflowed: false,
      complete: true,
    });

    await user.click(
      await screen.findByRole("button", { name: "安全关闭文档" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "选择一份 Markdown 文档",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("文档已关闭；未保存内容仍保留在本机恢复副本中。"),
    ).toBeTruthy();
    expect(api.recoveryGateway.upsert).toHaveBeenCalled();
    expect(api.setTitle).toHaveBeenCalledWith(null);
  });
});
