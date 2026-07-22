import assert from "node:assert/strict";
import test from "node:test";

import {
  isSameOrInside,
  parentPath,
  replacePrefix,
} from "../src/features/workbench/workspacePath.ts";

test("parentPath distinguishes a root entry from a nested parent", () => {
  assert.equal(parentPath("note.md"), null);
  assert.equal(parentPath("docs/note.md"), "docs");
  assert.equal(parentPath("docs/guides/note.md"), "docs/guides");
});

test("isSameOrInside respects complete path segment boundaries", () => {
  assert.equal(isSameOrInside("docs", "docs"), true);
  assert.equal(isSameOrInside("docs/note.md", "docs"), true);
  assert.equal(isSameOrInside("docs-old/note.md", "docs"), false);
});

test("replacePrefix remaps only the target path and its descendants", () => {
  assert.equal(replacePrefix("docs", "docs", "archive"), "archive");
  assert.equal(
    replacePrefix("docs/guides/note.md", "docs", "archive"),
    "archive/guides/note.md",
  );
  assert.equal(
    replacePrefix("docs-old/note.md", "docs", "archive"),
    "docs-old/note.md",
  );
});
