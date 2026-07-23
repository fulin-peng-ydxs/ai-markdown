import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ConflictOverwriteProposal,
  DesktopError,
  FileRevision,
  RecoverySnapshot,
  RecoverySnapshotMetadata,
  SaveCopyProposal,
} from "../../../services/desktop/contracts";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../documentSession";
import type {
  EditorRecoveryGateway,
  EditorSaveGateway,
} from "../editorGateway";
import { ConflictDialog } from "./ConflictDialog";
import { RecoveryDialog } from "./RecoveryDialog";
import { SaveCopyDialog } from "./SaveCopyDialog";

const revision: FileRevision = {
  modifiedAt: 1_750_000_000_000,
  size: 12,
  contentHash: "disk",
  encoding: "utf8",
  lineEnding: "lf",
};

function session(
  saveState: ReadyDocumentSession["saveState"] = { kind: "dirty" },
): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath: "note.md",
  });
  const ready = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath: "note.md",
      status: "ready",
      content: "# 当前内容",
      revision,
    },
    { mode: "visual", reasons: [] },
    true,
  ) as ReadyDocumentSession;
  return {
    ...ready,
    saveState,
    contentSafety: { kind: "recovery", snapshotId: "snapshot-a" },
    recoveryState: { kind: "available", snapshotId: "snapshot-a" },
  };
}

function saveGateway(
  overrides: Partial<EditorSaveGateway> = {},
): EditorSaveGateway {
  return {
    write: vi.fn(),
    prepareOverwrite: vi.fn(),
    confirmOverwrite: vi.fn(),
    cancelOverwrite: vi.fn().mockResolvedValue(true),
    prepareSaveCopy: vi.fn(),
    confirmSaveCopy: vi.fn(),
    cancelSaveCopy: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function recoveryMetadata(id = "snapshot-a"): RecoverySnapshotMetadata {
  return {
    snapshotId: id,
    workspaceId: "workspace-a",
    relativePath: id === "snapshot-a" ? "note.md" : "other.md",
    baseRevision: revision,
    contentHash: `content-${id}`,
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_100_000,
    expiresAt: 1_750_604_800_000,
    sizeBytes: 128,
  };
}

function recoveryGateway(
  overrides: Partial<EditorRecoveryGateway> = {},
): EditorRecoveryGateway {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    registerActive: vi.fn().mockResolvedValue(true),
    releaseActive: vi.fn().mockResolvedValue(true),
    upsert: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
    cleanup: vi.fn(),
    ...overrides,
  };
}

describe("T27 recovery and conflict dialogs", () => {
  it("requires a visible second confirmation before overwriting a conflict", async () => {
    const user = userEvent.setup();
    const proposal: ConflictOverwriteProposal = {
      confirmationId: "conflict-new",
      relativePath: "note.md",
      latestRevision: { ...revision, contentHash: "external" },
      currentContentHash: "current",
      targetWritable: true,
    };
    const api = saveGateway({
      prepareOverwrite: vi.fn().mockResolvedValue(proposal),
      confirmOverwrite: vi.fn().mockResolvedValue({
        relativePath: "note.md",
        revision: { ...revision, contentHash: "saved" },
        bytesWritten: 12,
      }),
    });
    const onOverwrite = vi.fn();
    const conflicted: ReadyDocumentSession = {
      ...session({ kind: "conflict", evidenceId: "conflict-old" }),
      conflictEvidence: {
        evidenceId: "conflict-old",
        diskRevision: { ...revision, contentHash: "external" },
      },
    };
    render(
      <ConflictDialog
        gateway={api}
        onClose={() => undefined}
        onOverwrite={onOverwrite}
        onReload={vi.fn()}
        onSaveCopy={() => undefined}
        open
        session={conflicted}
      />,
    );

    expect(screen.getByText(/本机恢复副本/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "准备覆盖磁盘版本" }),
    );
    expect(
      await screen.findByRole("heading", { name: "再次确认覆盖磁盘版本" }),
    ).toBeTruthy();
    expect(onOverwrite).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "覆盖磁盘版本" }));
    await waitFor(() => expect(onOverwrite).toHaveBeenCalledTimes(1));
    expect(api.cancelOverwrite).toHaveBeenCalledWith("conflict-old");
  });

  it("keeps the conflict dialog open with an actionable error when a token expires", async () => {
    const user = userEvent.setup();
    const expired: DesktopError = {
      code: "conflict_confirmation_not_found",
      messageKey: "error.desktop.conflict_confirmation_not_found",
      pathHint: null,
      contentSafe: true,
      retryable: true,
    };
    const api = saveGateway({
      prepareOverwrite: vi.fn().mockResolvedValue({
        confirmationId: "conflict-new",
        relativePath: "note.md",
        latestRevision: revision,
        currentContentHash: "current",
        targetWritable: true,
      }),
      confirmOverwrite: vi.fn().mockRejectedValue(expired),
    });
    const conflicted: ReadyDocumentSession = {
      ...session({ kind: "conflict", evidenceId: "conflict-old" }),
      conflictEvidence: {
        evidenceId: "conflict-old",
        diskRevision: revision,
      },
    };
    render(
      <ConflictDialog
        gateway={api}
        onClose={() => undefined}
        onOverwrite={() => undefined}
        onReload={vi.fn()}
        onSaveCopy={() => undefined}
        open
        session={conflicted}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "准备覆盖磁盘版本" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "覆盖磁盘版本" }),
    );

    expect(await screen.findByText(/覆盖确认已经过期/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "准备覆盖磁盘版本" }),
    ).toBeTruthy();
  });

  it("uses the native target proposal and explicit overwrite verb for save copy", async () => {
    const user = userEvent.setup();
    const proposal: SaveCopyProposal = {
      confirmationId: "save-copy-a",
      displayPath: "/tmp/copy.md",
      fileName: "copy.md",
      targetState: "existing",
      targetRevision: revision,
      outputEncoding: "utf8",
      outputLineEnding: "lf",
      workspaceId: null,
      relativePath: null,
    };
    const api = saveGateway({
      prepareSaveCopy: vi
        .fn()
        .mockResolvedValue({ status: "ready", proposal }),
      confirmSaveCopy: vi.fn().mockResolvedValue({
        displayPath: "/tmp/copy.md",
        workspaceId: null,
        relativePath: null,
        revision,
        bytesWritten: 12,
      }),
    });
    const onSaved = vi.fn();
    render(
      <SaveCopyDialog
        gateway={api}
        onClose={() => undefined}
        onSaved={onSaved}
        open
        session={session()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(await screen.findByText("/tmp/copy.md")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "覆盖并保存副本" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.confirmSaveCopy).toHaveBeenCalledWith(
      "save-copy-a",
      "# 当前内容",
      true,
    );
  });

  it("saves a conflicted or externally deleted session as a detached document", async () => {
    const user = userEvent.setup();
    const api = saveGateway({
      prepareSaveCopy: vi.fn().mockResolvedValue({ status: "cancelled" }),
    });
    const conflicted: ReadyDocumentSession = {
      ...session({ kind: "conflict", evidenceId: "conflict-a" }),
      conflictEvidence: {
        evidenceId: "conflict-a",
        diskRevision: revision,
      },
    };
    render(
      <SaveCopyDialog
        gateway={api}
        onClose={() => undefined}
        onSaved={() => undefined}
        open
        session={conflicted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(api.prepareSaveCopy).toHaveBeenCalledWith(
      { kind: "new_document", suggestedName: "note.md" },
      "utf8_lf",
    );
  });

  it("loads one recovery item without letting another item failure remove it", async () => {
    const user = userEvent.setup();
    const first = recoveryMetadata();
    const second = recoveryMetadata("snapshot-b");
    const full: RecoverySnapshot = {
      metadata: first,
      content: "# 恢复内容",
    };
    const failure: DesktopError = {
      code: "recovery_snapshot_corrupt",
      messageKey: "error.desktop.recovery_snapshot_corrupt",
      pathHint: null,
      contentSafe: true,
      retryable: false,
    };
    const api = recoveryGateway({
      get: vi.fn().mockResolvedValue(full),
      delete: vi
        .fn()
        .mockImplementation((id) =>
          id === "snapshot-b" ? Promise.reject(failure) : Promise.resolve(true),
        ),
    });
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(
      <RecoveryDialog
        gateway={api}
        onClose={() => undefined}
        onDeleted={() => undefined}
        onRestore={onRestore}
        open
        snapshots={[first, second]}
      />,
    );

    await user.click(screen.getByText("other.md"));
    const secondItem = screen.getByText("other.md").closest("li");
    await user.click(
      secondItem!.querySelector<HTMLButtonElement>(
        "button.plainroot-button",
      )!,
    );
    expect(await screen.findByText(/恢复副本校验失败/)).toBeTruthy();
    expect(screen.getByText("note.md")).toBeTruthy();

    await user.click(screen.getByText("note.md"));
    await user.click(screen.getByRole("button", { name: "恢复到编辑区" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(full));
  });

  it("prevents Escape from closing a recovery dialog while an item is loading", async () => {
    const first = recoveryMetadata();
    let resolveSnapshot!: (snapshot: RecoverySnapshot) => void;
    const pending = new Promise<RecoverySnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const onClose = vi.fn();
    const api = recoveryGateway({ get: vi.fn().mockReturnValue(pending) });
    render(
      <RecoveryDialog
        gateway={api}
        onClose={onClose}
        onDeleted={() => undefined}
        onRestore={vi.fn()}
        open
        snapshots={[first]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复到编辑区" }));
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
    resolveSnapshot({ metadata: first, content: "# 恢复" });
  });
});
