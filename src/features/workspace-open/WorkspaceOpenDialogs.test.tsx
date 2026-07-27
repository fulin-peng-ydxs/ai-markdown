import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceOpenOutcome } from "../../services/desktop/contracts";
import { WorkspaceOpenDecisionDialog } from "./WorkspaceOpenDecisionDialog";
import {
  WorkspaceOpenPreferenceDialog,
  type WorkspaceOpenPreferenceGateway,
} from "./WorkspaceOpenPreferenceDialog";

const decision: Extract<
  WorkspaceOpenOutcome,
  { status: "decision_required" }
> = {
  status: "decision_required",
  workspace: {
    id: "workspace-b",
    selectedPath: "/tmp/research",
    canonicalRoot: "/tmp/research",
    displayName: "research",
    writable: true,
    initialFile: null,
  },
  currentWorkspaceId: "workspace-a",
  currentWorkspaceName: "notes",
};

function preferenceGateway(
  overrides: Partial<WorkspaceOpenPreferenceGateway> = {},
): WorkspaceOpenPreferenceGateway {
  return {
    getOpenPreference: vi.fn().mockResolvedValue({
      disposition: "current_window",
    }),
    setOpenPreference: vi.fn().mockImplementation(async (disposition) => ({
      disposition,
    })),
    resetOpenPreference: vi.fn().mockResolvedValue({ disposition: "ask" }),
    ...overrides,
  };
}

function preferenceRadio(value: string): HTMLInputElement {
  const radio = screen
    .getAllByRole("radio")
    .find((candidate) => (candidate as HTMLInputElement).value === value);
  if (!radio) throw new Error(`Missing preference radio: ${value}`);
  return radio as HTMLInputElement;
}

describe("workspace open dialogs", () => {
  it("keeps the decision explicit and reports whether it should be remembered", async () => {
    const onChoose = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkspaceOpenDecisionDialog
        error={null}
        onChoose={onChoose}
        open
        outcome={decision}
        processing={false}
      />,
    );

    expect(screen.getByText(/会先处理全部页签/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "记住这次选择" }));
    await user.click(screen.getByRole("button", { name: "在新窗口打开" }));
    expect(onChoose).toHaveBeenCalledWith("new_window", true);
  });

  it("loads, saves and explicitly resets the preference to ask", async () => {
    const gateway = preferenceGateway();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkspaceOpenPreferenceDialog
        gateway={gateway}
        onClose={onClose}
        open
      />,
    );

    await screen.findByRole("heading", { name: "选择默认打开方式" });
    const current = preferenceRadio("current_window");
    await waitFor(() =>
      expect((current as HTMLInputElement).checked).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "恢复为每次询问" }));
    await waitFor(() =>
      expect(
        preferenceRadio("ask").checked,
      ).toBe(true),
    );
    expect(gateway.resetOpenPreference).toHaveBeenCalledTimes(1);

    await user.click(preferenceRadio("new_window"));
    await user.click(screen.getByRole("button", { name: "保存打开方式" }));
    await waitFor(() =>
      expect(gateway.setOpenPreference).toHaveBeenCalledWith("new_window"),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the settings dialog open when persistence fails", async () => {
    const gateway = preferenceGateway({
      setOpenPreference: vi.fn().mockRejectedValue({
        code: "preferences_write_failed",
        messageKey: "error.preferences.writeFailed",
        pathHint: null,
        contentSafe: true,
        retryable: true,
      }),
    });
    const user = userEvent.setup();
    render(
      <WorkspaceOpenPreferenceDialog
        gateway={gateway}
        onClose={() => undefined}
        open
      />,
    );

    await screen.findByRole("heading", { name: "选择默认打开方式" });
    await user.click(preferenceRadio("new_window"));
    await user.click(screen.getByRole("button", { name: "保存打开方式" }));
    expect(await screen.findByText(/Plainroot 偏好没有保存/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "选择默认打开方式" }),
    ).toBeTruthy();
  });
});
