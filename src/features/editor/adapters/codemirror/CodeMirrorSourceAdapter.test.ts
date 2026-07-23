import { syntaxTree } from "@codemirror/language";
import { replaceAll, SearchQuery, setSearchQuery } from "@codemirror/search";
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorAdapterTestDocument } from "../editorAdapterTestSupport";
import { CodeMirrorSourceAdapter } from "./CodeMirrorSourceAdapter";

const mountedRoots: HTMLElement[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove();
});

describe("CodeMirrorSourceAdapter", () => {
  it("loads exact Markdown with line numbers, syntax parsing and source selection", () => {
    const root = mountRoot();
    const markdown = "---\ntitle: Plainroot\n---\n\n# Heading\n\n[unknown]{.attr}\r\n";
    const adapter = new CodeMirrorSourceAdapter(root);
    adapter.load(sourceDocument(markdown, 4));

    const view = sourceView(adapter);
    expect(view.state.doc.toString()).toBe(
      "---\ntitle: Plainroot\n---\n\n# Heading\n\n[unknown]{.attr}\n",
    );
    expect(root.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(syntaxTree(view.state).toString()).toContain("ATXHeading1");
    expect(adapter.getSelection()).toEqual({ kind: "source", anchor: 4, head: 4 });
    adapter.destroy();
  });

  it("emits generation-bound changes without normalizing unsupported syntax or line endings", () => {
    const root = mountRoot();
    const markdown = "---\r\ncustom: value\r\n---\r\n\r\n:::unknown\r\n";
    const adapter = new CodeMirrorSourceAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    adapter.load(sourceDocument(markdown, markdown.length));

    const view = sourceView(adapter);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "tail\r\n" },
      selection: { anchor: view.state.doc.length + 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generation: 7,
        expectedEditVersion: 4,
        markdown: `${markdown}tail\r\n`,
        selection: {
          kind: "source",
          anchor: markdown.length + 6,
          head: markdown.length + 6,
        },
      }),
    );
    adapter.destroy();
  });

  it("advances rapid local transactions and ignores an older same-generation projection", () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    const initial = sourceDocument("# Rapid", 7);
    adapter.load(initial);

    const view = sourceView(adapter);
    view.dispatch({ changes: { from: view.state.doc.length, insert: " a" } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: " b" } });

    expect(
      changes.mock.calls.map(
        (call) =>
          (call[0] as { expectedEditVersion: number }).expectedEditVersion,
      ),
    ).toEqual([4, 5]);
    expect(adapter.getMarkdown()).toBe("# Rapid a b");

    adapter.apply({
      ...initial,
      markdown: "# Stale projection",
      editVersion: 5,
    });
    expect(adapter.getMarkdown()).toBe("# Rapid a b");
    expect(view.state.doc.toString()).toBe("# Rapid a b");
    adapter.destroy();
  });

  it("applies a newer session projection without emitting a user edit", () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    adapter.load(sourceDocument("# Initial", 0));
    adapter.apply(
      sourceDocument("# External", 10, {
        editVersion: 5,
        anchor: { kind: "source", offset: 10, scrollTop: 32 },
      }),
    );

    expect(sourceView(adapter).state.doc.toString()).toBe("# External");
    expect(adapter.getSelection()).toEqual({ kind: "source", anchor: 10, head: 10 });
    expect(adapter.getAnchor()).toMatchObject({ kind: "source", scrollTop: 32 });
    expect(changes).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("opens localized find/replace controls and replaces through the real search state", async () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    adapter.load(sourceDocument("alpha beta alpha", 0));

    expect(adapter.execute({ kind: "find" })).toBe(true);
    const findInput = root.querySelector<HTMLInputElement>('input[aria-label="查找"]');
    const replaceInput = root.querySelector<HTMLInputElement>('input[aria-label="替换"]');
    expect(findInput).not.toBeNull();
    expect(replaceInput).not.toBeNull();

    const view = sourceView(adapter);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "alpha", replace: "omega" }),
      ),
    });
    expect(replaceAll(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("omega beta omega");
    expect(changes).toHaveBeenCalled();
    adapter.destroy();
  });

  it("bridges keyboard undo/redo to the session without installing CodeMirror history", () => {
    const root = mountRoot();
    const onHistoryCommand = vi.fn(() => true);
    const adapter = new CodeMirrorSourceAdapter(root, { onHistoryCommand });
    adapter.load(sourceDocument("# History", 0));

    const content = sourceView(adapter).contentDOM;
    fireEvent.keyDown(content, { key: "z", ctrlKey: true });
    fireEvent.keyDown(content, { key: "z", ctrlKey: true, shiftKey: true });

    expect(onHistoryCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(adapter.execute({ kind: "history", direction: "redo" })).toBe(true);
    expect(onHistoryCommand).toHaveBeenLastCalledWith("redo");
    expect(sourceView(adapter).state.doc.toString()).toBe("# History");
    adapter.destroy();
  });

  it("groups source transactions during browser composition", () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    adapter.load(sourceDocument("中文", 2));

    sourceView(adapter).contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { data: "输入" }),
    );
    sourceView(adapter).dispatch({
      changes: { from: 2, insert: "输入" },
      annotations: Transaction.userEvent.of("input.type.compose"),
    });

    expect(changes.mock.lastCall?.[0].transactionGroup).toEqual(expect.any(String));
    adapter.destroy();
  });

  it("keeps read-only source selectable and searchable while blocking replace/history", () => {
    const root = mountRoot();
    const onHistoryCommand = vi.fn(() => true);
    const adapter = new CodeMirrorSourceAdapter(root, {
      readOnly: true,
      onHistoryCommand,
    });
    adapter.load(sourceDocument("# Read only", 0));

    const view = sourceView(adapter);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
    expect(adapter.execute({ kind: "find" })).toBe(true);
    expect(adapter.execute({ kind: "replace" })).toBe(false);
    expect(adapter.execute({ kind: "history", direction: "undo" })).toBe(false);
    expect(root.querySelector('input[aria-label="替换"]')).toBeNull();
    expect(onHistoryCommand).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("reports mount and input latency for a real 5 MiB source document", () => {
    const root = mountRoot();
    const markdown = "a".repeat(5 * 1024 * 1024);
    const samples: Array<{ phase: string; durationMs: number; byteLength: number }> = [];
    const adapter = new CodeMirrorSourceAdapter(root, {
      onPerformance: (sample) => samples.push(sample),
    });
    adapter.load(sourceDocument(markdown, markdown.length));
    expect(samples[0]).toMatchObject({
      phase: "mount",
      byteLength: 5 * 1024 * 1024,
    });

    sourceView(adapter).contentDOM.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "b" }),
    );
    sourceView(adapter).dispatch({
      changes: { from: markdown.length, insert: "b" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(samples.at(-1)).toMatchObject({
      phase: "input_to_change",
      byteLength: 5 * 1024 * 1024 + 1,
    });
    expect(samples.every((sample) => sample.durationMs >= 0)).toBe(true);
    adapter.destroy();
  }, 15_000);

  it("destroys the editor DOM and listeners", () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);
    adapter.load(sourceDocument("# Lifecycle", 0));
    expect(root.querySelector(".cm-editor")).not.toBeNull();

    adapter.destroy();
    expect(root.querySelector(".cm-editor")).toBeNull();
    expect(adapter.execute({ kind: "find" })).toBe(false);
  });
});

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mountedRoots.push(root);
  return root;
}

function sourceDocument(
  markdown: string,
  cursor: number,
  overrides: Parameters<typeof editorAdapterTestDocument>[2] = {},
) {
  return editorAdapterTestDocument(
    markdown,
    { kind: "source", anchor: cursor, head: cursor },
    overrides,
  );
}

function sourceView(adapter: CodeMirrorSourceAdapter): EditorView {
  return (adapter as unknown as { view: EditorView }).view;
}
