import { describe, expect, it } from "vitest";

import {
  applyTextPatch,
  createDocumentHistory,
  createReversibleTextPatch,
  invertTextPatch,
  recordDocumentChange,
  redoDocumentHistory,
  undoDocumentHistory,
} from "./documentHistory";
import type { EditorSelection } from "./editorAdapter";

const visualStart: EditorSelection = { kind: "visual", from: 0, to: 0 };
const sourceEnd: EditorSelection = { kind: "source", anchor: 8, head: 8 };

describe("DocumentHistory", () => {
  it("creates a reversible minimal patch without splitting an emoji", () => {
    const before = "A😀B";
    const after = "A🌱B";
    const patch = createReversibleTextPatch(before, after);

    expect(applyTextPatch(before, patch)).toBe(after);
    expect(applyTextPatch(after, invertTextPatch(patch))).toBe(before);
    expect(patch.removed).toBe("😀");
    expect(patch.inserted).toBe("🌱");
  });

  it("groups adjacent transactions without storing full document snapshots", () => {
    let history = createDocumentHistory();
    history = recordDocumentChange(history, {
      beforeMarkdown: "# A",
      afterMarkdown: "# AB",
      beforeSelection: visualStart,
      afterSelection: { kind: "visual", from: 4, to: 4 },
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: "typing-1",
    });
    history = recordDocumentChange(history, {
      beforeMarkdown: "# AB",
      afterMarkdown: "# ABC",
      beforeSelection: { kind: "visual", from: 4, to: 4 },
      afterSelection: { kind: "visual", from: 5, to: 5 },
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: "typing-1",
    });

    expect(history.past).toHaveLength(1);
    expect(history.past[0]?.steps).toHaveLength(2);
    expect(history.bytes).toBe(2);
  });

  it("restores content, mode and selection across adapters", () => {
    const history = recordDocumentChange(createDocumentHistory(), {
      beforeMarkdown: "# visual",
      afterMarkdown: "# source",
      beforeSelection: visualStart,
      afterSelection: sourceEnd,
      beforeMode: "visual",
      afterMode: "source",
      transactionGroup: null,
    });

    const undone = undoDocumentHistory(history, "# source");
    expect(undone).toMatchObject({
      status: "applied",
      markdown: "# visual",
      mode: "visual",
      selection: visualStart,
    });
    if (undone.status !== "applied") throw new Error("undo should apply");

    const redone = redoDocumentHistory(undone.history, undone.markdown);
    expect(redone).toMatchObject({
      status: "applied",
      markdown: "# source",
      mode: "source",
      selection: sourceEnd,
    });
  });

  it("rejects history when the current content no longer matches its hash", () => {
    const history = recordDocumentChange(createDocumentHistory(), {
      beforeMarkdown: "a",
      afterMarkdown: "ab",
      beforeSelection: visualStart,
      afterSelection: visualStart,
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: null,
    });

    expect(undoDocumentHistory(history, "external")).toMatchObject({
      status: "unavailable",
      reason: "content_mismatch",
    });
  });

  it("evicts oldest entries at both byte and entry limits", () => {
    let history = createDocumentHistory({ maxBytes: 2, maxEntries: 1 });
    history = recordDocumentChange(history, {
      beforeMarkdown: "",
      afterMarkdown: "a",
      beforeSelection: visualStart,
      afterSelection: visualStart,
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: null,
    });
    history = recordDocumentChange(history, {
      beforeMarkdown: "a",
      afterMarkdown: "ab",
      beforeSelection: visualStart,
      afterSelection: visualStart,
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: null,
    });

    expect(history.past).toHaveLength(1);
    expect(history.bytes).toBeLessThanOrEqual(2);
    expect(history.truncated).toBe(true);
  });

  it("drops a single patch that is larger than the configured budget", () => {
    const history = recordDocumentChange(createDocumentHistory({ maxBytes: 1 }), {
      beforeMarkdown: "",
      afterMarkdown: "中文",
      beforeSelection: visualStart,
      afterSelection: visualStart,
      beforeMode: "visual",
      afterMode: "visual",
      transactionGroup: null,
    });

    expect(history.past).toEqual([]);
    expect(history.bytes).toBe(0);
    expect(history.truncated).toBe(true);
  });

  it(
    "keeps a one-character edit to a 64 MiB document within the patch budget",
    () => {
      const before = "a".repeat(64 * 1024 * 1024);
      const history = recordDocumentChange(createDocumentHistory(), {
        beforeMarkdown: before,
        afterMarkdown: `${before}b`,
        beforeSelection: visualStart,
        afterSelection: visualStart,
        beforeMode: "source",
        afterMode: "source",
        transactionGroup: "large-typing",
      });

      expect(history.past).toHaveLength(1);
      expect(history.bytes).toBe(1);
      expect(history.past[0]?.steps[0]?.forward).toEqual({
        start: before.length,
        removed: "",
        inserted: "b",
      });
    },
    15_000,
  );
});
