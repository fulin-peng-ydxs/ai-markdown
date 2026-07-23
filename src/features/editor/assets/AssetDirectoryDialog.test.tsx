import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorAssetGateway } from "../editorGateway";
import { AssetDirectoryDialog } from "./AssetDirectoryDialog";

afterEach(cleanup);

function gateway(): EditorAssetGateway {
  return {
    getPreference: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      assetDirectory: "assets",
    }),
    setDirectory: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      assetDirectory: "media/images",
    }),
    resetDirectory: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      assetDirectory: "assets",
    }),
    beginUpload: vi.fn(),
    upload: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(),
  };
}

describe("AssetDirectoryDialog", () => {
  it("loads and persists a workspace-relative directory", async () => {
    const api = gateway();
    const onClose = vi.fn();
    render(
      <AssetDirectoryDialog
        gateway={api}
        onRequestClose={onClose}
        open
        workspaceId="workspace-1"
      />,
    );
    const input = await screen.findByLabelText("工作区相对目录");
    fireEvent.change(input, { target: { value: "media/images" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源目录" }));
    await waitFor(() =>
      expect(api.setDirectory).toHaveBeenCalledWith(
        "workspace-1",
        "media/images",
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open and reports validation failure", async () => {
    const api = gateway();
    vi.mocked(api.setDirectory).mockRejectedValue({
      code: "invalid_asset_directory",
      messageKey: "error.desktop.invalid_asset_directory",
      contentSafe: true,
      retryable: false,
    });
    render(
      <AssetDirectoryDialog
        gateway={api}
        onRequestClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />,
    );
    const input = await screen.findByLabelText("工作区相对目录");
    fireEvent.change(input, { target: { value: "../outside" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资源目录" }));
    expect(await screen.findByText("资源目录没有更新")).toBeTruthy();
    expect(screen.getByText(/原设置未被覆盖/)).toBeTruthy();
  });

  it("restores the backend default instead of hardcoding local state", async () => {
    const api = gateway();
    render(
      <AssetDirectoryDialog
        gateway={api}
        onRequestClose={vi.fn()}
        open
        workspaceId="workspace-1"
      />,
    );
    await screen.findByLabelText("工作区相对目录");
    fireEvent.click(screen.getByRole("button", { name: "恢复为 assets/" }));
    await waitFor(() =>
      expect(api.resetDirectory).toHaveBeenCalledWith("workspace-1"),
    );
  });
});
