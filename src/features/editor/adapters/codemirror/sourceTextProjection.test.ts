import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  applyEditorChangesToRawMarkdown,
  editorOffsetToRawOffset,
  projectSourceText,
  rawOffsetToEditorOffset,
} from "./sourceTextProjection";

describe("sourceTextProjection", () => {
  it("preserves mixed line separators while projecting one editor line model", () => {
    const raw = "first\r\nsecond\nthird\rfourth";
    const projection = projectSourceText(raw);
    expect(projection).toEqual({
      editorText: "first\nsecond\nthird\nfourth",
      preferredLineSeparator: "\r\n",
    });
    expect(rawOffsetToEditorOffset(raw, 7)).toBe(6);
    expect(editorOffsetToRawOffset(raw, 6)).toBe(7);
  });

  it("applies normalized editor changes to raw offsets without touching other separators", () => {
    const raw = "first\r\nsecond\nthird";
    const state = EditorState.create({ doc: "first\nsecond\nthird" });
    const changes = state.changes({
      from: 6,
      to: 12,
      insert: "changed\nnew",
    });
    expect(applyEditorChangesToRawMarkdown(raw, changes, "\r\n")).toBe(
      "first\r\nchanged\r\nnew\nthird",
    );
  });
});
