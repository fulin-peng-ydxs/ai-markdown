import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDirectoryScanBatch,
  applyWorkspaceTreeMutationFailure,
  applyWorkspaceTreeMutationSuccess,
  applyWorkspaceTreeDeleteSuccess,
  applyWorkspaceWatchBatch,
  acknowledgeWorkspaceWatchRescan,
  beginDirectoryScan,
  beginWorkspaceWatch,
  beginWorkspaceWatchRescan,
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

function watchBatch({
  watchId = "watch-active",
  sequence = 1,
  rescanDirectories = [],
  status = "watching",
  issue = null,
  overflowed = false,
  complete = false,
} = {}) {
  return {
    watchId,
    sequence,
    events: [],
    rescanDirectories,
    status,
    issue,
    overflowed,
    complete,
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
    ...createWorkspaceTreeState(),
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
    ...createWorkspaceTreeState(),
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
    ...createWorkspaceTreeState(),
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
    ...createWorkspaceTreeState(),
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
    ...createWorkspaceTreeState(),
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

test("external watch batch queues targeted rescans without clearing loaded tree", () => {
  const populated = {
    ...createWorkspaceTreeState(),
    entries: {
      docs: entry("docs", "directory"),
      "docs/note.md": entry("docs/note.md"),
    },
    children: { "": ["docs"], docs: ["docs/note.md"] },
  };
  const watching = beginWorkspaceWatch(populated, {
    watchId: "watch-active",
    workspaceId,
  });
  const result = applyWorkspaceWatchBatch(
    watching,
    watchBatch({ rescanDirectories: ["docs", null] }),
  );

  assert.equal(result.entries, watching.entries);
  assert.equal(result.children, watching.children);
  assert.deepEqual(result.watch.rescanDirectories, ["docs", ""]);
});

test("watch rescan acknowledgment removes only the consumed directory", () => {
  const watching = beginWorkspaceWatch(createWorkspaceTreeState(), {
    watchId: "watch-active",
    workspaceId,
  });
  const queued = applyWorkspaceWatchBatch(
    watching,
    watchBatch({ rescanDirectories: ["docs", "archive"] }),
  );
  const result = acknowledgeWorkspaceWatchRescan(queued, "docs");

  assert.deepEqual(result.watch.rescanDirectories, ["archive"]);
});

test("watch reconciliation removes missing child and preserves surviving expansion", () => {
  const populated = {
    ...createWorkspaceTreeState(),
    entries: {
      docs: entry("docs", "directory"),
      "docs/keep": entry("docs/keep", "directory"),
      "docs/keep/note.md": entry("docs/keep/note.md"),
      "docs/removed.md": entry("docs/removed.md"),
    },
    children: {
      "": ["docs"],
      docs: ["docs/keep", "docs/removed.md"],
      "docs/keep": ["docs/keep/note.md"],
    },
  };
  const watching = beginWorkspaceWatch(populated, {
    watchId: "watch-active",
    workspaceId,
  });
  const queued = applyWorkspaceWatchBatch(
    watching,
    watchBatch({ rescanDirectories: ["docs"] }),
  );
  const reconciling = beginWorkspaceWatchRescan(
    queued,
    start("scan-reconcile", "docs"),
  );

  assert.ok(reconciling.entries["docs/removed.md"]);
  assert.deepEqual(reconciling.children["docs/keep"], ["docs/keep/note.md"]);
  const result = applyDirectoryScanBatch(
    reconciling,
    "docs",
    batch("scan-reconcile", [entry("docs/keep", "directory")], [], true),
  );

  assert.equal(result.entries["docs/removed.md"], undefined);
  assert.ok(result.entries["docs/keep/note.md"]);
  assert.deepEqual(result.children.docs, ["docs/keep"]);
  assert.deepEqual(result.children["docs/keep"], ["docs/keep/note.md"]);
  assert.deepEqual(result.watch.rescanDirectories, []);
});

test("failed watch reconciliation preserves the last tree and requeues refresh", () => {
  const populated = {
    ...createWorkspaceTreeState(),
    entries: { "note.md": entry("note.md") },
    children: { "": ["note.md"] },
  };
  const watching = beginWorkspaceWatch(populated, {
    watchId: "watch-active",
    workspaceId,
  });
  const queued = applyWorkspaceWatchBatch(
    watching,
    watchBatch({ rescanDirectories: [null] }),
  );
  const reconciling = beginWorkspaceWatchRescan(
    queued,
    start("scan-failed"),
  );
  const result = applyDirectoryScanBatch(
    reconciling,
    null,
    batch("scan-failed", [], [issue], true),
  );

  assert.ok(result.entries["note.md"]);
  assert.deepEqual(result.children[""], ["note.md"]);
  assert.deepEqual(result.watch.rescanDirectories, [""]);
});

test("stale watch batch cannot replace a restarted watcher", () => {
  const restarted = beginWorkspaceWatch(createWorkspaceTreeState(), {
    watchId: "watch-new",
    workspaceId,
  });
  const result = applyWorkspaceWatchBatch(
    restarted,
    watchBatch({ watchId: "watch-old", rescanDirectories: [null] }),
  );

  assert.equal(result, restarted);
  assert.deepEqual(result.watch.rescanDirectories, []);
});

test("terminal root loss clears inaccessible tree and exposes retry state", () => {
  const populated = {
    ...createWorkspaceTreeState(),
    entries: { "note.md": entry("note.md") },
    children: { "": ["note.md"] },
  };
  const watching = beginWorkspaceWatch(populated, {
    watchId: "watch-active",
    workspaceId,
  });
  const result = applyWorkspaceWatchBatch(
    watching,
    watchBatch({
      sequence: 2,
      status: "root_missing",
      issue,
      complete: true,
    }),
  );

  assert.deepEqual(result.entries, {});
  assert.deepEqual(result.children, {});
  assert.equal(result.watch.watchId, null);
  assert.equal(result.watch.status, "root_missing");
  assert.equal(result.watch.issue, issue);
});

test("watch backend failure preserves the last readable tree for manual refresh", () => {
  const populated = {
    ...createWorkspaceTreeState(),
    entries: { "note.md": entry("note.md") },
    children: { "": ["note.md"] },
  };
  const watching = beginWorkspaceWatch(populated, {
    watchId: "watch-active",
    workspaceId,
  });
  const result = applyWorkspaceWatchBatch(
    watching,
    watchBatch({ status: "failed", issue, complete: true }),
  );

  assert.ok(result.entries["note.md"]);
  assert.deepEqual(result.children[""], ["note.md"]);
  assert.equal(result.watch.watchId, null);
  assert.equal(result.watch.status, "failed");
});
