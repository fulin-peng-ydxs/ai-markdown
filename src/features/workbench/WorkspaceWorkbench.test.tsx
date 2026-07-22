import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  FsEntry,
  MarkdownReadResult,
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
    scan: vi.fn().mockResolvedValue({ scanId: "scan-1", workspaceId: workspace.id, directory: null }),
    pollScan: vi.fn().mockResolvedValue(completeScan),
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
    ...overrides,
  };
}

describe("WorkspaceWorkbench", () => {
  it("reads a real tree entry and shows only the returned Markdown content", async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={api} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);

    await user.click(await screen.findByRole("treeitem", { name: /note\.md/ }));

    expect(await screen.findByText(/真实文档/)).toBeTruthy();
    expect(screen.getByText("只读 Markdown")).toBeTruthy();
    expect(api.read).toHaveBeenCalledWith("workspace-a", "note.md");
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith("note.md"));
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
    expect(screen.queryByText(/过期文档/)).toBeNull();
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
    expect(screen.getByText("磁盘状态已同步")).toBeTruthy();
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
});
