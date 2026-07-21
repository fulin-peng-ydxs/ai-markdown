import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  FsEntry,
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

  it("moves keyboard focus through visible file-tree rows", async () => {
    const user = userEvent.setup();
    render(<WorkspaceWorkbench gateway={gateway()} initialWorkspace={workspace} onWorkspaceChanged={() => undefined} />);
    const folderRow = await screen.findByRole("treeitem", { name: /guides/ });
    const noteRow = screen.getByRole("treeitem", { name: /note\.md/ });
    folderRow.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(noteRow);
  });
});
