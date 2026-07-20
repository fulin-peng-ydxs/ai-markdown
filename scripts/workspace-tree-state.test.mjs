import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDirectoryScanBatch,
  beginDirectoryScan,
  createWorkspaceTreeState,
} from "../src/features/workbench/workspaceTreeState.ts";

const workspaceId = "workspace-test";

function start(scanId, directory = null) {
  return { scanId, workspaceId, directory };
}

function entry(relativePath, kind = "markdown_file") {
  return {
    relativePath,
    name: relativePath.split("/").at(-1),
    kind,
    writable: true,
    symlink: false,
    childrenState: kind === "directory" ? "not_loaded" : "loaded",
  };
}

function batch(scanId, entries = [], issues = [], complete = false) {
  return {
    scanId,
    processed: entries.length + issues.length,
    entries,
    issues,
    complete,
    cancelled: false,
  };
}

const issue = {
  code: "permission_denied",
  messageKey: "error.path.permissionDenied",
  pathHint: "private",
  contentSafe: true,
  retryable: true,
};

test("stale scan batch cannot overwrite the active directory scan", () => {
  const active = beginDirectoryScan(createWorkspaceTreeState(), start("scan-new"));
  const result = applyDirectoryScanBatch(
    active,
    null,
    batch("scan-old", [entry("stale.md")], [], true),
  );

  assert.equal(result, active);
  assert.deepEqual(result.entries, {});
  assert.equal(result.scans[""].scanId, "scan-new");
});

test("root rescan invalidates every previous tree entry and child list", () => {
  const populated = {
    entries: {
      docs: entry("docs", "directory"),
      "docs/note.md": entry("docs/note.md"),
      "root.md": entry("root.md"),
    },
    children: {
      "": ["docs", "root.md"],
      docs: ["docs/note.md"],
    },
    scans: {},
  };

  const result = beginDirectoryScan(populated, start("scan-root"));

  assert.deepEqual(result.entries, {});
  assert.deepEqual(result.children, {});
  assert.equal(result.scans[""].status, "loading");
});

test("child rescan clears only that subtree and preserves unrelated entries", () => {
  const populated = {
    entries: {
      docs: entry("docs", "directory"),
      "docs/note.md": entry("docs/note.md"),
      "root.md": entry("root.md"),
    },
    children: {
      "": ["docs", "root.md"],
      docs: ["docs/note.md"],
    },
    scans: {},
  };

  const result = beginDirectoryScan(populated, start("scan-docs", "docs"));

  assert.ok(result.entries.docs);
  assert.ok(result.entries["root.md"]);
  assert.equal(result.entries["docs/note.md"], undefined);
  assert.deepEqual(result.children[""], ["docs", "root.md"]);
  assert.equal(result.children.docs, undefined);
});

test("partial issues remain visible without turning a populated directory into error", () => {
  const loading = beginDirectoryScan(createWorkspaceTreeState(), start("scan-partial"));
  const partial = applyDirectoryScanBatch(
    loading,
    null,
    batch("scan-partial", [entry("safe.md")], [issue], true),
  );
  assert.equal(partial.scans[""].status, "ready");
  assert.equal(partial.scans[""].issues.length, 1);

  const emptyLoading = beginDirectoryScan(
    createWorkspaceTreeState(),
    start("scan-error"),
  );
  const failed = applyDirectoryScanBatch(
    emptyLoading,
    null,
    batch("scan-error", [], [issue], true),
  );
  assert.equal(failed.scans[""].status, "error");
});
