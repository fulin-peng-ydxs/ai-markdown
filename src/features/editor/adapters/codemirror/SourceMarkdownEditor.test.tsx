import { createRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditorAdapterDocument } from "../../editorAdapter";
import { editorAdapterTestDocument } from "../editorAdapterTestSupport";
import {
  SourceMarkdownEditor,
  type SourceMarkdownEditorHandle,
} from "./SourceMarkdownEditor";

describe("SourceMarkdownEditor", () => {
  it("mounts one CodeMirror surface and exposes the shared imperative contract", async () => {
    const editorRef = createRef<SourceMarkdownEditorHandle>();
    const rendered = render(
      <SourceMarkdownEditor
        document={sourceDocument("# Source")}
        onChange={vi.fn()}
        ref={editorRef}
      />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".cm-editor")).not.toBeNull());

    act(() => editorRef.current?.setSelection({ kind: "source", anchor: 2, head: 4 }));
    expect(editorRef.current?.getSelection()).toEqual({
      kind: "source",
      anchor: 2,
      head: 4,
    });
    expect(editorRef.current?.execute({ kind: "find" })).toBe(true);
    expect(rendered.getByLabelText("查找")).not.toBeNull();
  });

  it("updates from the same session projection without emitting an edit", async () => {
    const onChange = vi.fn();
    const rendered = render(
      <SourceMarkdownEditor
        document={sourceDocument("# Initial")}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(rendered.container.textContent).toContain("Initial"));

    rendered.rerender(
      <SourceMarkdownEditor
        document={sourceDocument("# External", { editVersion: 5 })}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(rendered.container.textContent).toContain("External"));
    expect(rendered.container.textContent).not.toContain("Initial");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports an incompatible visual projection instead of mounting stale source", () => {
    const onUnavailable = vi.fn();
    const rendered = render(
      <SourceMarkdownEditor
        document={editorAdapterTestDocument("# Visual", {
          kind: "visual",
          from: 0,
          to: 0,
        })}
        onChange={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    expect(onUnavailable).toHaveBeenCalledWith({
      code: "adapter_failed",
      message: expect.stringContaining("source selection"),
    });
    expect(rendered.container.querySelector(".cm-editor")).toBeNull();
  });

  it("destroys the CodeMirror surface on unmount", async () => {
    const rendered = render(
      <SourceMarkdownEditor document={sourceDocument("# Lifecycle")} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(rendered.container.querySelector(".cm-editor")).not.toBeNull());
    rendered.unmount();
    expect(document.querySelector(".cm-editor")).toBeNull();
  });
});

function sourceDocument(
  markdown: string,
  overrides: Partial<EditorAdapterDocument> = {},
): EditorAdapterDocument {
  return editorAdapterTestDocument(
    markdown,
    { kind: "source", anchor: 0, head: 0 },
    overrides,
  );
}
