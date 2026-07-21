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

  it("focuses the first action and wraps keyboard focus inside the dialog", async () => {
    render(
      <AppDialog labelledBy="title" onRequestClose={() => undefined} open>
        <h2 id="title">对话框</h2>
        <button type="button">第一项</button>
        <button type="button">最后一项</button>
      </AppDialog>,
    );

    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "第一项" });
    const last = screen.getByRole("button", { name: "最后一项" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps focus on a modal status dialog without interactive controls", async () => {
    render(
      <AppDialog closeDisabled labelledBy="title" onRequestClose={() => undefined} open>
        <h2 id="title">正在处理</h2>
      </AppDialog>,
    );

    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });
});
