import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AsyncStatePanel, resolveAsyncState } from "./AsyncStatePanel";

describe("AsyncStatePanel", () => {
  it("uses an assertive alert and visible label for blocking states", () => {
    render(
      <AsyncStatePanel
        description="请重新选择本地目录。"
        state="permission_denied"
        title="工作区权限已撤销"
      />,
    );

    const panel = screen.getByRole("alert");
    expect(panel.getAttribute("aria-live")).toBe("assertive");
    expect(panel.getAttribute("data-state")).toBe("permission_denied");
    expect(screen.getByText("需要授权")).toBeTruthy();
  });

  it("keeps non-blocking progress polite", () => {
    render(
      <AsyncStatePanel
        description="文件会分批出现。"
        state="loading"
        title="正在读取目录"
      />,
    );

    const panel = screen.getByRole("status");
    expect(panel.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("正在处理")).toBeTruthy();
  });

  it("resolves the documented safe-state priority", () => {
    expect(resolveAsyncState(["ready", "loading", "error", "missing", "permission_denied"]))
      .toBe("permission_denied");
    expect(resolveAsyncState(["dirty", "saving", "conflict"])).toBe("conflict");
    expect(resolveAsyncState([])).toBe("ready");
  });
});
