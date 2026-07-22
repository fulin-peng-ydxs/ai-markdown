import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceMocks = vi.hoisted(() => ({
  getLauncherSnapshot: vi.fn(),
  getWorkbenchSnapshot: vi.fn(),
  listenMenu: vi.fn(),
}));

vi.mock("./services/desktop/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/desktop/workspace")>();
  return {
    ...actual,
    getWorkspaceLauncherSnapshot: workspaceMocks.getLauncherSnapshot,
    getWorkspaceWorkbenchSnapshot: workspaceMocks.getWorkbenchSnapshot,
    listenForLauncherMenu: workspaceMocks.listenMenu,
  };
});

import App from "./App";

const stateReadFailure = {
  code: "state_read_failed",
  messageKey: "error.desktop.state_read_failed",
  pathHint: null,
  contentSafe: true,
  retryable: true,
};

describe("App bootstrap", () => {
  beforeEach(() => {
    workspaceMocks.getWorkbenchSnapshot.mockReset();
    workspaceMocks.getLauncherSnapshot.mockReset();
    workspaceMocks.listenMenu.mockReset();
    workspaceMocks.listenMenu.mockResolvedValue(() => undefined);
  });

  it("delegates a shared state-read failure to the launcher's single actionable panel", async () => {
    workspaceMocks.getWorkbenchSnapshot.mockRejectedValue(stateReadFailure);
    workspaceMocks.getLauncherSnapshot.mockRejectedValue(stateReadFailure);

    render(<App />);

    expect(await screen.findByText("无法读取本地工作区")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("无法恢复当前窗口")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeTruthy();
  });
});
