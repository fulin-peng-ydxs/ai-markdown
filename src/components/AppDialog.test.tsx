import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppDialog } from "./AppDialog";

describe("AppDialog", () => {
  it("handles Escape through the explicit close request", () => {
    const onClose = vi.fn();
    render(
      <AppDialog labelledBy="title" onRequestClose={onClose} open>
        <h2 id="title">对话框</h2>
      </AppDialog>,
    );
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a destructive busy dialog from closing", () => {
    const onClose = vi.fn();
    render(
      <AppDialog closeDisabled labelledBy="title" onRequestClose={onClose} open>
        <h2 id="title">处理中</h2>
      </AppDialog>,
    );
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the element active before opening", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开";
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(
      <AppDialog labelledBy="title" onRequestClose={() => undefined} open>
        <h2 id="title">对话框</h2>
      </AppDialog>,
    );
    rerender(
      <AppDialog labelledBy="title" onRequestClose={() => undefined} open={false}>
        <h2 id="title">对话框</h2>
      </AppDialog>,
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });
});
