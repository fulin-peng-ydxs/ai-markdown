import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import commonmarkGfm from "../../../../../tests/fixtures/markdown/commonmark-gfm.md?raw";
import type { EditorAdapterDocument } from "../../editorAdapter";
import { MilkdownVisualAdapter } from "./MilkdownVisualAdapter";
import {
  sanitizeRichClipboardHtml,
  writeVisualClipboard,
} from "./clipboard";
import {
  MAX_INTERACTIVE_VISUAL_BYTES,
  MAX_INTERACTIVE_VISUAL_CONTENT_LINES,
  countMarkdownContentLines,
  utf8ByteLength,
  visualEditorEligibility,
} from "./visualEditorPolicy";

const mountedRoots: HTMLElement[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove();
});

describe("MilkdownVisualAdapter", () => {
  it("loads CommonMark/GFM, edits one selection and emits a unified-session transaction", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    await adapter.load(editorDocument("# Hello\n\n- item\n"));

    adapter.setSelection({ kind: "visual", from: 1, to: 6 });
    expect(adapter.execute({ kind: "format", format: "bold" })).toBe(true);

    await waitFor(() => expect(changes).toHaveBeenCalled(), { timeout: 1_000 });
    expect(changes.mock.lastCall?.[0]).toMatchObject({
      generation: 7,
      expectedEditVersion: 4,
      selection: { kind: "visual", from: 1, to: 6 },
    });
    expect(changes.mock.lastCall?.[0].markdown).toContain("**Hello**");

    adapter.destroy();
    await waitFor(() => expect(root.querySelector(".ProseMirror")).toBeNull());
  });

  it("supports structural commands and retains the required semantic corpus", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    await adapter.load(editorDocument(commonmarkGfm));
    const before = root.textContent;

    adapter.setSelection({ kind: "visual", from: 1, to: 1 });
    expect(adapter.execute({ kind: "insert_divider" })).toBe(true);
    expect(adapter.execute({ kind: "insert_table", rows: 2, columns: 2 })).toBe(true);
    expect(before).toContain("粗体");
    expect(root.querySelector('img[alt="示例图片"]')).not.toBeNull();
    expect(root.querySelector("table")).not.toBeNull();

    adapter.destroy();
  });

  it("does not emit a user change when a newer DocumentSession projection is applied", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    await adapter.load(editorDocument("# Initial"));
    await adapter.apply({
      ...editorDocument("# External"),
      editVersion: 5,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 260));
    expect(root.textContent).toContain("External");
    expect(changes).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("keeps read-only projection inert", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root, { readOnly: true });
    await adapter.load(editorDocument("# Read only"));

    expect(root.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    expect(adapter.execute({ kind: "format", format: "bold" })).toBe(false);
    adapter.destroy();
  });

  it("routes undo and redo to DocumentSession instead of keeping a second adapter history", async () => {
    const root = mountRoot();
    const onHistoryCommand = vi.fn(() => true);
    const adapter = new MilkdownVisualAdapter(root, { onHistoryCommand });
    await adapter.load(editorDocument("# Shared history"));

    expect(adapter.execute({ kind: "history", direction: "undo" })).toBe(true);
    expect(adapter.execute({ kind: "history", direction: "redo" })).toBe(true);
    expect(onHistoryCommand.mock.calls).toEqual([["undo"], ["redo"]]);
    adapter.destroy();
  });

  it("groups the first transaction after browser composition starts", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    const changes = vi.fn();
    adapter.onChange(changes);
    await adapter.load(editorDocument("# 中文输入"));
    adapter.setSelection({ kind: "visual", from: 1, to: 5 });

    root.querySelector(".ProseMirror")?.dispatchEvent(
      new CompositionEvent("compositionstart", { data: "中文" }),
    );
    adapter.execute({ kind: "format", format: "bold" });

    await waitFor(() => expect(changes).toHaveBeenCalled(), { timeout: 1_000 });
    expect(changes.mock.lastCall?.[0].transactionGroup).toEqual(expect.any(String));
    adapter.destroy();
  });

  it("reports transaction-to-Markdown latency independently from session patch/hash work", async () => {
    const root = mountRoot();
    const samples: Array<{ phase: string; durationMs: number }> = [];
    const adapter = new MilkdownVisualAdapter(root, {
      onPerformance: (sample) => samples.push(sample),
    });
    await adapter.load(editorDocument("# Latency"));
    adapter.setSelection({ kind: "visual", from: 1, to: 8 });
    adapter.execute({ kind: "format", format: "italic" });

    await waitFor(
      () => expect(samples.some((sample) => sample.phase === "input_to_markdown")).toBe(true),
      { timeout: 1_000 },
    );
    expect(
      samples.find((sample) => sample.phase === "input_to_markdown")?.durationMs,
    ).toBeGreaterThanOrEqual(0);
    adapter.destroy();
  });

  it("removes an editor destroyed while its asynchronous creation is still pending", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    const loading = adapter.load(editorDocument("# Strict lifecycle"));
    const lateApply = loading.then(() => adapter.apply(editorDocument("# Must stay destroyed")));
    adapter.destroy();
    await Promise.all([loading, lateApply]);

    await waitFor(() => expect(root.querySelector(".ProseMirror")).toBeNull());
  });

  it("builds plain, Markdown and rich payloads from the same selection", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);
    await adapter.load(editorDocument("# **Hello** world"));
    adapter.setSelection({ kind: "visual", from: 1, to: 6 });

    const payload = adapter.getSelectionClipboardPayload();
    expect(payload?.plainText).toBe("Hello");
    expect(payload?.markdown).toContain("**Hello**");
    expect(payload?.html).toContain("<strong>Hello</strong>");
    adapter.destroy();
  });

  it("measures a real 100 KiB mount and rejects larger documents before editor allocation", async () => {
    const hundredKiB =
      "# Performance\n\n" +
      `${"performance content ".repeat(50)}\n\n`.repeat(100);
    const samples: Array<{ phase: string; durationMs: number; byteLength: number }> = [];
    const adapter = new MilkdownVisualAdapter(mountRoot(), {
      onPerformance: (sample) => samples.push(sample),
    });
    await adapter.load(editorDocument(hundredKiB));
    expect(samples[0]).toMatchObject({
      phase: "mount",
      byteLength: utf8ByteLength(hundredKiB),
    });
    expect(samples[0]?.durationMs).toBeGreaterThanOrEqual(0);
    adapter.destroy();

    for (const mebibytes of [5, 20, 64]) {
      const markdown = "a".repeat(mebibytes * 1024 * 1024);
      expect(visualEditorEligibility(markdown)).toMatchObject({
        eligible: false,
        byteLength: mebibytes * 1024 * 1024,
        reason: "document_too_large",
      });
    }
  }, 15_000);
});

describe("visual editing safety utilities", () => {
  it("counts UTF-8 without allocating a mirror buffer and keeps surrogate pairs exact", () => {
    expect(utf8ByteLength("Plainroot")).toBe(9);
    expect(utf8ByteLength("中文")).toBe(6);
    expect(utf8ByteLength("🙂")).toBe(4);
    expect(visualEditorEligibility("a".repeat(MAX_INTERACTIVE_VISUAL_BYTES))).toMatchObject({
      eligible: true,
    });
  });

  it("degrades a small but excessively fragmented document before Milkdown mounts", () => {
    const fragmented = "short\n\n".repeat(MAX_INTERACTIVE_VISUAL_CONTENT_LINES + 1);
    expect(countMarkdownContentLines(fragmented)).toBeGreaterThan(
      MAX_INTERACTIVE_VISUAL_CONTENT_LINES,
    );
    expect(visualEditorEligibility(fragmented)).toMatchObject({
      eligible: false,
      reason: "document_too_complex",
    });
  });

  it("rejects compact high-density lists and tables that have no blank separators", () => {
    const compactList = Array.from(
      { length: MAX_INTERACTIVE_VISUAL_CONTENT_LINES + 1 },
      (_, index) => `- item ${index}`,
    ).join("\n");
    const compactTable = [
      "| key | value |",
      "| --- | --- |",
      ...Array.from(
        { length: MAX_INTERACTIVE_VISUAL_CONTENT_LINES },
        (_, index) => `| ${index} | value |`,
      ),
    ].join("\n");

    for (const markdown of [compactList, compactTable]) {
      expect(utf8ByteLength(markdown)).toBeLessThan(MAX_INTERACTIVE_VISUAL_BYTES);
      expect(visualEditorEligibility(markdown)).toMatchObject({
        eligible: false,
        contentLineCount: expect.any(Number),
        reason: "document_too_complex",
      });
    }
  });

  it("counts LF, CRLF and CR content lines without treating blank rows as nodes", () => {
    expect(countMarkdownContentLines("one\n\n two")).toBe(2);
    expect(countMarkdownContentLines("one\r\n\r\n two")).toBe(2);
    expect(countMarkdownContentLines("one\r\r two")).toBe(2);
  });

  it("unwraps unsupported rich HTML and removes active or unsafe attributes", () => {
    const sanitized = sanitizeRichClipboardHtml(
      '<section><p onclick="steal()">safe <a href="javascript:steal()">link</a></p><script>steal()</script><img src="https://tracker.invalid/pixel"></section>',
    );
    expect(sanitized).toContain("<p>safe <a>link</a></p>");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("<img");
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("javascript:");
  });

  it("reports clipboard permission failures without leaking an unhandled rejection", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });

    await expect(
      writeVisualClipboard("markdown", {
        plainText: "plain",
        markdown: "**markdown**",
        html: "<strong>rich</strong>",
      }),
    ).resolves.toBe(false);
  });
});

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mountedRoots.push(root);
  return root;
}

function editorDocument(markdown: string): EditorAdapterDocument {
  return {
    generation: 7,
    editVersion: 4,
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
