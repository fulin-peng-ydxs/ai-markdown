import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    ...overrides,
  };
}

describe("WorkspaceLauncher", () => {
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
    render(<WorkspaceLauncher gateway={api} />);
    await user.click(await screen.findByRole("button", { name: /打开 Markdown 文件/ }));
    expect(await screen.findByText("实际范围")).toBeTruthy();
    expect(screen.getByText("/Users/demo", { selector: "dd" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "授权并打开" }));
    await waitFor(() => expect(api.authorize).toHaveBeenCalledWith("selection-1", true));
  });

  it("maps native keyboard shortcuts to the two real selectors", async () => {
    const api = gateway();
    render(<WorkspaceLauncher gateway={api} />);
    await screen.findByText("Research Notes");
    fireEvent.keyDown(window, { key: "o", metaKey: true });
    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(api.selectFolder).toHaveBeenCalledTimes(1);
      expect(api.selectMarkdown).toHaveBeenCalledTimes(1);
    });
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
});
