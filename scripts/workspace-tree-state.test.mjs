import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDirectoryScanBatch,
  applyWorkspaceTreeMutationFailure,
  applyWorkspaceTreeMutationSuccess,
  applyWorkspaceTreeDeleteSuccess,
  beginDirectoryScan,
  beginWorkspaceTreeMutation,
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

test("successful create enters the loaded parent only after the disk result", () => {
  const initial = {
    ...createWorkspaceTreeState(),
    children: { "": [] },
  };
  const processing = beginWorkspaceTreeMutation(
    initial,
    "mutation-create",
    "create_file",
    null,
  );
  assert.deepEqual(processing.entries, {});
  const result = applyWorkspaceTreeMutationSuccess(processing, "mutation-create", {
    kind: "create_file",
    previousPath: null,
    entry: entry("note.md"),
  });
  assert.ok(result.entries["note.md"]);
  assert.deepEqual(result.children[""], ["note.md"]);
  assert.equal(result.mutation, null);
});

test("successful directory rename remaps descendants and invalidates affected scans", () => {
  const initial = {
    entries: {
      docs: entry("docs", "directory"),
      "docs/note.md": entry("docs/note.md"),
      "root.md": entry("root.md"),
    },
    children: {
      "": ["docs", "root.md"],
      docs: ["docs/note.md"],
    },
    scans: {
      "": { scanId: "root-scan", status: "loading", processed: 1, issues: [] },
      docs: { scanId: "docs-scan", status: "loading", processed: 1, issues: [] },
    },
    mutation: null,
  };
  const processing = beginWorkspaceTreeMutation(
    initial,
    "mutation-rename",
    "rename",
    "docs",
  );
  const result = applyWorkspaceTreeMutationSuccess(processing, "mutation-rename", {
    kind: "rename",
    previousPath: "docs",
    entry: entry("research", "directory"),
  });
  assert.equal(result.entries.docs, undefined);
  assert.ok(result.entries.research);
  assert.ok(result.entries["research/note.md"]);
  assert.deepEqual(result.children[""], ["research", "root.md"]);
  assert.deepEqual(result.children.research, ["research/note.md"]);
  assert.deepEqual(result.scans, {});
});

test("failed mutation preserves tree and exposes a retryable error", () => {
  const initial = {
    ...createWorkspaceTreeState(),
    entries: { "note.md": entry("note.md") },
    children: { "": ["note.md"] },
  };
  const processing = beginWorkspaceTreeMutation(
    initial,
    "mutation-failed",
    "rename",
    "note.md",
  );
  const failed = applyWorkspaceTreeMutationFailure(
    processing,
    "mutation-failed",
    issue,
  );
  assert.equal(failed.entries, processing.entries);
  assert.equal(failed.children, processing.children);
  assert.equal(failed.mutation.status, "failed");
  assert.equal(failed.mutation.error, issue);
});

test("move between parents removes the old child and adds the new child", () => {
  const initial = {
    entries: {
      docs: entry("docs", "directory"),
      archive: entry("archive", "directory"),
      "docs/note.md": entry("docs/note.md"),
    },
    children: {
      "": ["docs", "archive"],
      docs: ["docs/note.md"],
      archive: [],
    },
    scans: {},
    mutation: null,
  };
  const processing = beginWorkspaceTreeMutation(
    initial,
    "mutation-move",
    "move",
    "docs/note.md",
  );
  const result = applyWorkspaceTreeMutationSuccess(processing, "mutation-move", {
    kind: "move",
    previousPath: "docs/note.md",
    entry: entry("archive/note.md"),
  });
  assert.deepEqual(result.children.docs, []);
  assert.deepEqual(result.children.archive, ["archive/note.md"]);
  assert.equal(result.entries["docs/note.md"], undefined);
  assert.ok(result.entries["archive/note.md"]);
});

test("stale mutation result cannot commit into a newer tree operation", () => {
  const active = beginWorkspaceTreeMutation(
    createWorkspaceTreeState(),
    "mutation-new",
    "create_file",
    null,
  );
  const result = applyWorkspaceTreeMutationSuccess(active, "mutation-old", {
    kind: "create_file",
    previousPath: null,
    entry: entry("stale.md"),
  });
  assert.equal(result, active);
  assert.deepEqual(result.entries, {});
  assert.equal(result.mutation.id, "mutation-new");
});

test("successful delete removes the target subtree only after disk success", () => {
  const initial = {
    entries: {
      docs: entry("docs", "directory"),
      "docs/note.md": entry("docs/note.md"),
      "root.md": entry("root.md"),
    },
    children: {
      "": ["docs", "root.md"],
      docs: ["docs/note.md"],
    },
    scans: {
      "": { scanId: null, status: "ready", processed: 2, issues: [] },
      docs: { scanId: null, status: "ready", processed: 1, issues: [] },
    },
    mutation: null,
  };
  const processing = beginWorkspaceTreeMutation(
    initial,
    "delete-docs",
    "trash",
    "docs",
  );
  assert.ok(processing.entries["docs/note.md"]);
  const result = applyWorkspaceTreeDeleteSuccess(processing, "delete-docs", {
    kind: "trash",
    relativePath: "docs",
    entryKind: "directory",
  });
  assert.equal(result.entries.docs, undefined);
  assert.equal(result.entries["docs/note.md"], undefined);
  assert.ok(result.entries["root.md"]);
  assert.deepEqual(result.children[""], ["root.md"]);
  assert.equal(result.children.docs, undefined);
  assert.deepEqual(result.scans, {});
  assert.equal(result.mutation, null);
});

test("stale delete result cannot remove a newer tree target", () => {
  const active = beginWorkspaceTreeMutation(
    {
      ...createWorkspaceTreeState(),
      entries: { "note.md": entry("note.md") },
      children: { "": ["note.md"] },
    },
    "delete-new",
    "trash",
    "note.md",
  );
  const result = applyWorkspaceTreeDeleteSuccess(active, "delete-old", {
    kind: "trash",
    relativePath: "note.md",
    entryKind: "markdown_file",
  });
  assert.equal(result, active);
  assert.ok(result.entries["note.md"]);
});
