import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceLauncherSnapshot } from "../../services/desktop/contracts";
import type { WorkspaceLauncherGateway } from "./launcherGateway";
import { WorkspaceLauncher } from "./WorkspaceLauncher";

function snapshot(): WorkspaceLauncherSnapshot {
  return {
    recentWorkspaces: [
      {
        workspaceId: "workspace-a",
        displayName: "Research Notes",
        canonicalRoot: "/Users/demo/Documents/research",
        lastOpenedAt: Date.now(),
        availability: "available",
      },
      {
        workspaceId: "workspace-b",
        displayName: "Product Docs",
        canonicalRoot: "/Users/demo/Writing/product",
        lastOpenedAt: Date.now() - 86_400_000,
        availability: "missing",
      },
    ],
    workspaceSessions: [],
    activeWorkspaceIds: [],
    currentWorkspaceId: null,
    windowLabel: "plainroot-window-1",
  };
}

function gateway(overrides: Partial<WorkspaceLauncherGateway> = {}): WorkspaceLauncherGateway {
  return {
    snapshot: vi.fn().mockResolvedValue(snapshot()),
    selectFolder: vi.fn().mockResolvedValue({ status: "cancelled" }),
    selectMarkdown: vi.fn().mockResolvedValue({ status: "cancelled" }),
    validateRecent: vi.fn().mockResolvedValue({ status: "already_open", workspaceId: "workspace-a", initialFile: null }),
    authorize: vi.fn(),
    cancelSelection: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockResolvedValue({ status: "focused_existing", workspaceId: "workspace-a", windowLabel: "plainroot-window-2" }),
    removeRecent: vi.fn().mockResolvedValue(true),
    removeSession: vi.fn().mockResolvedValue(false),
    listenMenu: vi.fn().mockResolvedValue(() => undefined),
    recoveryGateway: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      registerActive: vi.fn().mockResolvedValue(true),
      releaseActive: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
      cleanup: vi.fn(),
    },
    ...overrides,
  };
}

describe("WorkspaceLauncher", () => {
  it("shows non-macOS shortcut labels when the runtime is not macOS", async () => {
    render(<WorkspaceLauncher gateway={gateway()} />);
    await screen.findByText("Research Notes");
    expect(screen.getByText("Ctrl O", { selector: "kbd" })).toBeTruthy();
    expect(screen.getByText("Ctrl Shift O", { selector: "kbd" })).toBeTruthy();
  });

  it("filters by name/path and offers a real clear-filter action", async () => {
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={gateway()} />);
    const filter = await screen.findByPlaceholderText("按名称或路径过滤");
    await user.type(filter, "no match");
    expect(screen.getByText("没有匹配的工作区")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除过滤" }));
    expect(screen.getByText("Research Notes")).toBeTruthy();
  });

  it("states that removing a recent entry never deletes local files", async () => {
    const api = gateway();
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={api} />);
    await user.click(await screen.findByLabelText("移除“Research Notes”的最近记录"));
    expect(screen.getByText(/不会删除或修改任何本地文件/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "仅移除记录" }));
    await waitFor(() => expect(api.removeRecent).toHaveBeenCalledWith("workspace-a"));
  });

  it("shows and enforces single-file parent-directory confirmation", async () => {
    const onWorkspaceOpened = vi.fn();
    const api = gateway({
      selectMarkdown: vi.fn().mockResolvedValue({
        status: "confirmation_required",
        proposal: {
          selectionId: "selection-1",
          kind: "markdown_file",
          selectedPath: "/Users/demo/note.md",
          canonicalRoot: "/Users/demo",
          displayName: "demo",
          initialFile: "note.md",
          rootIsSymlink: false,
          scopeConfirmationRequired: true,
          requiresConfirmation: true,
        },
      }),
      authorize: vi.fn().mockResolvedValue({ id: "workspace-demo", selectedPath: "/Users/demo", canonicalRoot: "/Users/demo", displayName: "demo", writable: true, initialFile: "note.md" }),
      open: vi.fn().mockResolvedValue({ status: "opened_current", workspace: { id: "workspace-demo", selectedPath: "/Users/demo", canonicalRoot: "/Users/demo", displayName: "demo", writable: true, initialFile: "note.md" }, windowLabel: "plainroot-window-1" }),
    });
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={api} onWorkspaceOpened={onWorkspaceOpened} />);
    await user.click(await screen.findByRole("button", { name: /打开 Markdown 文件/ }));
    expect(await screen.findByText("实际范围")).toBeTruthy();
    expect(screen.getByText("/Users/demo", { selector: "dd" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "授权并打开" }));
    await waitFor(() => expect(api.authorize).toHaveBeenCalledWith("selection-1", true));
    await waitFor(() => expect(onWorkspaceOpened).toHaveBeenCalledWith(expect.objectContaining({ id: "workspace-demo" })));
  });

  it("maps the two native menu events to their real selectors", async () => {
    let menuListener: Parameters<WorkspaceLauncherGateway["listenMenu"]>[0] | null = null;
    const api = gateway({
      listenMenu: vi.fn().mockImplementation(async (listener) => {
        menuListener = listener;
        return () => undefined;
      }),
    });
    render(<WorkspaceLauncher gateway={api} />);
    await screen.findByText("Research Notes");
    expect(menuListener).not.toBeNull();
    await act(async () => {
      menuListener?.("file.open_folder");
    });
    await waitFor(() => expect(api.selectFolder).toHaveBeenCalledTimes(1));
    await act(async () => {
      menuListener?.("file.open_markdown");
    });
    await waitFor(() => expect(api.selectMarkdown).toHaveBeenCalledTimes(1));
  });

  it("allows only one native selector while an open action is in flight", async () => {
    let menuListener: Parameters<WorkspaceLauncherGateway["listenMenu"]>[0] | null = null;
    const api = gateway({
      selectFolder: vi.fn().mockImplementation(() => new Promise(() => undefined)),
      listenMenu: vi.fn().mockImplementation(async (listener) => {
        menuListener = listener;
        return () => undefined;
      }),
    });
    render(<WorkspaceLauncher gateway={api} />);
    await screen.findByText("Research Notes");
    expect(menuListener).not.toBeNull();
    act(() => {
      menuListener?.("file.open_folder");
      menuListener?.("file.open_folder");
    });
    expect(api.selectFolder).toHaveBeenCalledTimes(1);
  });

  it("does not replace a snapshot error with an unrelated menu-listener error", async () => {
    const api = gateway({
      snapshot: vi.fn().mockRejectedValue({
        code: "state_read_failed",
        messageKey: "error.desktop.state_read_failed",
        pathHint: null,
        contentSafe: true,
        retryable: true,
      }),
      listenMenu: vi.fn().mockRejectedValue(new Error("event bridge unavailable")),
    });
    render(<WorkspaceLauncher gateway={api} />);
    expect(await screen.findByText(/无法读取本机的最近工作区和窗口会话/)).toBeTruthy();
    expect(screen.queryByText(/未能聚焦已有窗口/)).toBeNull();
  });

  it("reloads the launcher snapshot only once after a restore batch", async () => {
    const restoringSnapshot = snapshot();
    restoringSnapshot.workspaceSessions = [
      {
        workspaceId: "workspace-a",
        windowLabel: "plainroot-window-1",
        windowStateRef: null,
        lastActiveAt: 2,
      },
      {
        workspaceId: "workspace-b",
        windowLabel: "plainroot-window-2",
        windowStateRef: null,
        lastActiveAt: 1,
      },
    ];
    const api = gateway({
      snapshot: vi.fn().mockResolvedValue(restoringSnapshot),
      validateRecent: vi.fn().mockImplementation(async (workspaceId) => ({
        status: "already_open",
        workspaceId,
        initialFile: null,
      })),
      open: vi.fn().mockImplementation(async (workspaceId) => ({
        status: "focused_existing",
        workspaceId,
        windowLabel: "plainroot-window-1",
      })),
    });
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={api} />);
    await user.click(await screen.findByRole("button", { name: "恢复可用窗口" }));
    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("已恢复")).toHaveLength(2);
  });

  it.each([
    ["window_not_found", "目标窗口已关闭"],
    ["window_create_failed", "未能创建新窗口"],
    ["window_focus_failed", "未能聚焦已有窗口"],
    ["window_close_failed", "未能关闭窗口"],
  ] as const)("keeps %s visible with retry and close actions", async (code, message) => {
    const failure = {
      code,
      messageKey: `error.desktop.${code}`,
      pathHint: null,
      contentSafe: true,
      retryable: true,
    };
    const api = gateway({
      selectFolder: vi.fn().mockResolvedValue({ status: "already_open", workspaceId: "workspace-a", initialFile: null }),
      open: vi.fn().mockRejectedValue(failure),
    });
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={api} />);
    await user.click(await screen.findByRole("button", { name: "打开文件夹" }));
    expect(await screen.findByText(new RegExp(message))).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("opens a recoverable workspace without writing the recovery content from P2", async () => {
    const metadata = {
      snapshotId: "snapshot-a",
      workspaceId: "workspace-a",
      relativePath: "note.md",
      baseRevision: {
        modifiedAt: 1,
        size: 8,
        contentHash: "disk",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      },
      contentHash: "recovery",
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      sizeBytes: 16,
    };
    const api = gateway();
    vi.mocked(api.recoveryGateway.list).mockResolvedValue([metadata]);
    vi.mocked(api.recoveryGateway.get).mockResolvedValue({
      metadata,
      content: "# 恢复",
    });
    const user = userEvent.setup();
    render(<WorkspaceLauncher gateway={api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "检查 1 份未保存恢复内容",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "打开工作区处理" }),
    );

    await waitFor(() =>
      expect(api.validateRecent).toHaveBeenCalledWith("workspace-a"),
    );
    expect(api.open).toHaveBeenCalledWith("workspace-a", undefined);
    expect(api.recoveryGateway.delete).not.toHaveBeenCalled();
  });
});
