import { createRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditorAdapterDocument } from "../../editorAdapter";
import {
  VisualMarkdownEditor,
  type VisualMarkdownEditorHandle,
} from "./VisualMarkdownEditor";

describe("VisualMarkdownEditor", () => {
  it("shows the contextual toolbar only for a valid selection and routes commands to the adapter", async () => {
    const editorRef = createRef<VisualMarkdownEditorHandle>();
    const onChange = vi.fn();
    const rendered = render(
      <VisualMarkdownEditor
        document={editorDocument("# Select me")}
        onChange={onChange}
        ref={editorRef}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
    expect(rendered.queryByRole("toolbar", { name: "选区格式" })).toBeNull();

    act(() => editorRef.current?.setSelection({ kind: "visual", from: 1, to: 7 }));
    await waitFor(() => expect(rendered.getByRole("toolbar", { name: "选区格式" })).not.toBeNull());
    rendered.getByRole("button", { name: "加粗" }).click();
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 1_000 });
    expect(onChange.mock.lastCall?.[0].markdown).toContain("**Select**");
  });

  it("reports the explicit source-mode degradation without mounting Milkdown", async () => {
    const onUnavailable = vi.fn();
    const rendered = render(
      <VisualMarkdownEditor
        document={editorDocument("a".repeat(2 * 1024 * 1024 + 1))}
        onChange={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledWith({
      code: "document_too_large",
      message: expect.stringContaining("源码模式"),
    }));
    expect(rendered.container.querySelector(".ProseMirror")).toBeNull();
  });

  it("removes a live visual projection when a newer session document crosses the gate", async () => {
    const onUnavailable = vi.fn();
    const rendered = render(
      <VisualMarkdownEditor
        document={editorDocument("# Initially visual")}
        onChange={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());

    rendered.rerender(
      <VisualMarkdownEditor
        document={editorDocument("a".repeat(2 * 1024 * 1024 + 1))}
        onChange={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).toBeNull());
    expect(onUnavailable).toHaveBeenLastCalledWith({
      code: "document_too_large",
      message: expect.stringContaining("源码模式"),
    });
  });

  it("exposes a controlled image request hook without owning asset import state", async () => {
    const editorRef = createRef<VisualMarkdownEditorHandle>();
    const onChange = vi.fn();
    const onRequestImage = vi.fn(async () => ({
      src: "../assets/example.png",
      alt: "example",
    }));
    const rendered = render(
      <VisualMarkdownEditor
        document={editorDocument("# Image")}
        onChange={onChange}
        onRequestImage={onRequestImage}
        ref={editorRef}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
    act(() => editorRef.current?.setSelection({ kind: "visual", from: 7, to: 7 }));
    await act(async () => {
      expect(await editorRef.current?.requestImage()).toBe(true);
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 1_000 });
    expect(onRequestImage).toHaveBeenCalledWith({ kind: "visual", from: 6, to: 6 });
    expect(onChange.mock.lastCall?.[0].markdown).toContain(
      "![example](../assets/example.png)",
    );
  });

  it("keeps a rejected asset request inside the component error boundary", async () => {
    const editorRef = createRef<VisualMarkdownEditorHandle>();
    const rendered = render(
      <VisualMarkdownEditor
        document={editorDocument("# Image failure")}
        onChange={vi.fn()}
        onRequestImage={vi.fn().mockRejectedValue(new Error("cancelled"))}
        ref={editorRef}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());

    await act(async () => {
      await expect(editorRef.current?.requestImage()).resolves.toBe(false);
    });
    expect(rendered.getByText("图片操作未完成")).not.toBeNull();
  });

  it("destroys the editor and listeners on unmount", async () => {
    const rendered = render(
      <VisualMarkdownEditor document={editorDocument("# Lifecycle")} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
    rendered.unmount();
    await waitFor(() => expect(document.querySelector(".ProseMirror")).toBeNull());
  });
});

function editorDocument(markdown: string): EditorAdapterDocument {
  return {
    generation: 2,
    editVersion: 3,
    markdown,
    selection: { kind: "visual", from: 0, to: 0 },
    anchor: {
      kind: "semantic",
      blockId: null,
      fallbackOffset: 0,
      scrollTop: 0,
    },
  };
}
