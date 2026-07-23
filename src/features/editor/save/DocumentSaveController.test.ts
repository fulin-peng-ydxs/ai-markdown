import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FileRevision,
  RecoverySnapshotMetadata,
  SafeWriteResult,
} from "../../../services/desktop/contracts";
import {
  applyDocumentEdit,
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../documentSession";
import type {
  EditorRecoveryGateway,
  EditorSaveGateway,
} from "../editorGateway";
import {
  DocumentSaveController,
  recoveryDebounceFor,
  saveDebounceFor,
  utf8ByteLength,
} from "./DocumentSaveController";

const baseRevision: FileRevision = {
  modifiedAt: 1,
  size: 8,
  contentHash: "disk-hash",
  encoding: "utf8",
  lineEnding: "lf",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentSaveController", () => {
  it("uses the 800ms, 2s and 5s size bands and a 10s large recovery cadence", () => {
    expect(saveDebounceFor("a")).toBe(800);
    expect(saveDebounceFor("a".repeat(5 * 1024 * 1024 + 1))).toBe(2_000);
    expect(saveDebounceFor("a".repeat(20 * 1024 * 1024 + 1))).toBe(5_000);
    expect(recoveryDebounceFor("a")).toBe(2_000);
    expect(recoveryDebounceFor("a".repeat(5 * 1024 * 1024 + 1))).toBe(10_000);
    expect(utf8ByteLength("中文🙂")).toBe(
      new TextEncoder().encode("中文🙂").byteLength,
    );
  });

  it("debounces automatic save and commits only after the safe-write revision returns", async () => {
    vi.useFakeTimers();
    let current = editedSession("# edited");
    const write = vi.fn().mockResolvedValue(savedResult("# edited"));
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write });

    controller.observe(current);
    await vi.advanceTimersByTimeAsync(799);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    expect(current.saveState.kind).toBe("saved");
    expect(current.diskRevision.contentHash).toBe("saved-hash");
  });

  it("keeps one save in flight and chases an edit made while the first write is pending", async () => {
    vi.useFakeTimers();
    let current = editedSession("# first");
    let resolveFirst!: (value: SafeWriteResult) => void;
    const first = new Promise<SafeWriteResult>((resolve) => {
      resolveFirst = resolve;
    });
    const write = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(savedResult("# second", "saved-second"));
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write });

    controller.observe(current);
    const save = controller.manualSave();
    expect(current.saveState.kind).toBe("saving");
    current = edit(current, "# second");
    controller.observe(current);
    const duplicate = controller.manualSave();
    expect(write).toHaveBeenCalledTimes(1);

    resolveFirst(savedResult("# first", "saved-first"));
    await save;
    await duplicate;
    expect(write).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(current.saveState.kind).toBe("saved"));
    expect(write.mock.calls[1]?.[2]).toBe("# second");
    expect(current.diskRevision.contentHash).toBe("saved-second");
  });

  it("persists a dirty recovery snapshot and does not claim it covers a later edit", async () => {
    vi.useFakeTimers();
    let current = editedSession("# snapshot");
    let resolveSnapshot!: (value: ReturnType<typeof persistedRecovery>) => void;
    const upsert = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const write = vi.fn().mockReturnValue(new Promise(() => undefined));
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write }, { upsert });

    controller.observe(current);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(upsert).toHaveBeenCalledTimes(1);
    current = edit(current, "# newer");
    controller.observe(current);
    resolveSnapshot(persistedRecovery("snapshot-1"));
    await vi.runAllTicks();
    await vi.waitFor(() =>
      expect(current.recoveryState.kind).toBe("available"),
    );
    expect(current.contentSafety.kind).toBe("memory");
  });

  it("waits for active-session registration before writing the first recovery snapshot", async () => {
    vi.useFakeTimers();
    let current = editedSession("# register first");
    let resolveRegistration!: (value: boolean) => void;
    const registerActive = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRegistration = resolve;
      }),
    );
    const upsert = vi.fn().mockResolvedValue(persistedRecovery("snapshot-1"));
    const write = vi.fn().mockReturnValue(new Promise(() => undefined));
    const controller = controllerFor(
      () => current,
      (next) => {
        current = next;
        controller.observe(next);
      },
      { write },
      { registerActive, upsert },
    );

    controller.observe(current);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registerActive).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();

    resolveRegistration(true);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(current.recoveryState.kind).toBe("available"),
    );
  });

  it("reuses a completed active-session registration when the recovery timer fires", async () => {
    vi.useFakeTimers();
    let current = editedSession("# already registered");
    const registerActive = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const upsert = vi.fn().mockResolvedValue(persistedRecovery("snapshot-1"));
    const write = vi.fn().mockReturnValue(new Promise(() => undefined));
    const controller = controllerFor(
      () => current,
      (next) => {
        current = next;
        controller.observe(next);
      },
      { write },
      { registerActive, upsert },
    );

    controller.observe(current);
    await vi.waitFor(() => expect(registerActive).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));

    expect(registerActive).toHaveBeenCalledTimes(1);
    expect(current.recoveryState.kind).toBe("available");
  });

  it("turns a revision conflict into evidence without overwriting the disk", async () => {
    let current = editedSession("# mine");
    const conflict = desktopError("file_revision_conflict");
    const write = vi.fn().mockRejectedValue(conflict);
    const prepareOverwrite = vi.fn().mockResolvedValue({
      confirmationId: "conflict-1",
      relativePath: "note.md",
      latestRevision: { ...baseRevision, contentHash: "external" },
      currentContentHash: "mine",
      targetWritable: true,
    });
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write, prepareOverwrite });

    const result = await controller.manualSave();

    expect(result).toEqual({ status: "blocked", reason: "conflict" });
    expect(current.saveState).toEqual({
      kind: "conflict",
      evidenceId: "conflict-1",
    });
    expect(current.conflictEvidence?.diskRevision.contentHash).toBe("external");
  });

  it("deletes a late recovery snapshot instead of reviving it after the document saved", async () => {
    vi.useFakeTimers();
    let current = editedSession("# race");
    let resolveSnapshot!: (value: ReturnType<typeof persistedRecovery>) => void;
    let resolveWrite!: (value: SafeWriteResult) => void;
    const upsert = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const write = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const remove = vi.fn().mockResolvedValue(true);
    const controller = controllerFor(
      () => current,
      (next) => {
        current = next;
        controller.observe(next);
      },
      { write },
      { upsert, delete: remove },
    );

    controller.observe(current);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    resolveWrite(savedResult("# race"));
    await vi.waitFor(() => expect(current.saveState.kind).toBe("saved"));
    resolveSnapshot(persistedRecovery("late-snapshot"));
    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("late-snapshot", "workspace-a"),
    );

    expect(current.saveState.kind).toBe("saved");
    expect(current.recoveryState.kind).toBe("none");
    expect(remove).toHaveBeenCalledWith("late-snapshot", "workspace-a");
  });

  it("settlement retries a failed document, persists recovery on failure, and refuses close", async () => {
    let current = editedSession("# unsafe");
    const write = vi.fn().mockRejectedValue(desktopError("safe_write_failed"));
    const upsert = vi.fn().mockResolvedValue(persistedRecovery("safe-copy"));
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write }, { upsert });

    const result = await controller.settle();

    expect(result).toEqual({ status: "blocked", reason: "failed" });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(current.saveState.kind).toBe("save_failed");
    expect(current.contentSafety).toEqual({
      kind: "recovery",
      snapshotId: "safe-copy",
    });
  });

  it("does not loop recovery writes after a persistent failure without a new edit", async () => {
    vi.useFakeTimers();
    let current = editedSession("# memory only");
    const write = vi.fn().mockReturnValue(new Promise(() => undefined));
    const upsert = vi.fn().mockResolvedValue({
      status: "memory_only",
      snapshot: null,
      issue: desktopError("safe_write_failed"),
    });
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write }, { upsert });

    controller.observe(current);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(current.recoveryState.kind).toBe("failed");
  });

  it("settlement waits for the chased save when editing continues during the first write", async () => {
    let current = editedSession("# first");
    let resolveFirst!: (value: SafeWriteResult) => void;
    const write = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(savedResult("# second", "final"));
    const controller = controllerFor(() => current, (next) => {
      current = next;
      controller.observe(next);
    }, { write });

    const settlement = controller.settle();
    current = edit(current, "# second");
    controller.observe(current);
    resolveFirst(savedResult("# first", "first"));

    await expect(settlement).resolves.toEqual({ status: "saved" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[2]).toBe("# second");
    expect(current.diskRevision.contentHash).toBe("final");
  });
});

function controllerFor(
  getSession: () => ReadyDocumentSession,
  onSessionChange: (session: ReadyDocumentSession) => void,
  saveOverrides: Partial<EditorSaveGateway> = {},
  recoveryOverrides: Partial<EditorRecoveryGateway> = {},
) {
  return new DocumentSaveController({
    getSession,
    onSessionChange,
    createRequestId: (() => {
      let id = 0;
      return () => `save-${++id}`;
    })(),
    saveGateway: {
      write: vi.fn().mockResolvedValue(savedResult("")),
      prepareOverwrite: vi.fn(),
      confirmOverwrite: vi.fn(),
      cancelOverwrite: vi.fn(),
      prepareSaveCopy: vi.fn(),
      confirmSaveCopy: vi.fn(),
      cancelSaveCopy: vi.fn(),
      ...saveOverrides,
    },
    recoveryGateway: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      registerActive: vi.fn().mockResolvedValue(true),
      releaseActive: vi.fn().mockResolvedValue(true),
      upsert: vi.fn().mockResolvedValue(persistedRecovery("snapshot")),
      delete: vi.fn().mockResolvedValue(true),
      cleanup: vi.fn(),
      ...recoveryOverrides,
    },
  });
}

function cleanSession(): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath: "note.md",
  });
  const resolved = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath: "note.md",
      status: "ready",
      content: "# disk",
      revision: baseRevision,
    },
    { mode: "visual", reasons: [] },
    true,
  );
  if (resolved.status !== "ready") throw new Error("expected ready session");
  return resolved;
}

function editedSession(markdown: string): ReadyDocumentSession {
  return edit(cleanSession(), markdown);
}

function edit(
  session: ReadyDocumentSession,
  markdown: string,
): ReadyDocumentSession {
  const result = applyDocumentEdit(session, {
    generation: session.generation,
    expectedEditVersion: session.editVersion,
    markdown,
    selection: session.selection,
    anchor: session.anchor,
    mode: session.mode,
    transactionGroup: null,
  });
  if (result.status !== "applied") throw new Error(result.status);
  return result.session;
}

function savedResult(
  content: string,
  contentHash = "saved-hash",
): SafeWriteResult {
  return {
    relativePath: "note.md",
    bytesWritten: new TextEncoder().encode(content).byteLength,
    revision: {
      ...baseRevision,
      size: content.length,
      contentHash,
      modifiedAt: 2,
    },
  };
}

function persistedRecovery(snapshotId: string) {
  const snapshot: RecoverySnapshotMetadata = {
    snapshotId,
    workspaceId: "workspace-a",
    relativePath: "note.md",
    baseRevision,
    contentHash: "snapshot-hash",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    sizeBytes: 10,
  };
  return { status: "persisted" as const, snapshot, issue: null };
}

function desktopError(code: "file_revision_conflict" | "safe_write_failed") {
  return {
    code,
    messageKey: `error.desktop.${code}`,
    pathHint: "note.md",
    contentSafe: true,
    retryable: true,
  } as const;
}
