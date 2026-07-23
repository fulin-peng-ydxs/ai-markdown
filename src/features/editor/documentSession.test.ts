import { describe, expect, it, vi } from "vitest";

import type {
  DesktopError,
  FileRevision,
  LineEnding,
  MarkdownReadResult,
  TextEncoding,
} from "../../services/desktop/contracts";
import {
  applyDocumentEdit,
  beginDocumentLoad,
  beginDocumentSave,
  completeDocumentSave,
  createEmptyDocumentSession,
  failDocumentSave,
  lineEndingFromMarkdown,
  reassessDocumentCompatibility,
  resolveDocumentRead,
  undoDocumentSession,
  type ReadyDocumentSession,
} from "./documentSession";
import {
  applyDocumentLoadOutcome,
  requestDocumentLoad,
} from "./editorGateway";

const compatible = { mode: "visual", reasons: [] } as const;
const sourceOnly = { mode: "source-only", reasons: ["frontmatter"] } as const;

function revision(
  encoding: TextEncoding = "utf8",
  lineEnding: LineEnding = "lf",
  contentHash = "disk-a",
): FileRevision {
  return { modifiedAt: 1, size: 4, contentHash, encoding, lineEnding };
}

function read(
  content = "# A",
  fileRevision = revision(),
): MarkdownReadResult {
  return {
    relativePath: "note.md",
    status: "ready",
    content,
    revision: fileRevision,
  };
}

function readySession(
  options: { writable?: boolean; compatibility?: typeof compatible | typeof sourceOnly } = {},
): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath: "note.md",
  });
  const resolved = resolveDocumentRead(
    loading,
    loading.generation,
    read(),
    options.compatibility ?? compatible,
    options.writable ?? true,
  );
  if (resolved.status !== "ready") throw new Error("expected ready session");
  return resolved;
}

describe("DocumentSession", () => {
  it.each([
    ["utf8", "none"],
    ["utf8", "lf"],
    ["utf8", "crlf"],
    ["utf8", "cr"],
    ["utf8_bom", "mixed"],
  ] satisfies [TextEncoding, LineEnding][]) (
    "projects %s/%s from the disk revision",
    (encoding, lineEnding) => {
      const loading = beginDocumentLoad(createEmptyDocumentSession(), {
        workspaceId: "workspace-a",
        relativePath: "note.md",
      });
      const session = resolveDocumentRead(
        loading,
        loading.generation,
        read("", revision(encoding, lineEnding)),
        compatible,
        true,
      );

      expect(session).toMatchObject({
        status: "ready",
        markdown: "",
        sourceFormat: { encoding, lineEnding },
      });
      if (lineEnding === "mixed") {
        expect(session).toMatchObject({
          mode: "source",
          compatibility: {
            mode: "source-only",
            reasons: ["mixed-line-endings"],
          },
        });
      }
    },
  );

  it("keeps unsupported encodings and oversized files outside a writable session", () => {
    for (const status of ["unsupported_encoding", "too_large"] as const) {
      const loading = beginDocumentLoad(createEmptyDocumentSession(), {
        workspaceId: "workspace-a",
        relativePath: "note.md",
      });
      expect(
        resolveDocumentRead(
          loading,
          loading.generation,
          {
            relativePath: "note.md",
            status,
            content: null,
            revision: revision(status === "unsupported_encoding" ? "unsupported" : "utf8"),
          },
          sourceOnly,
          true,
        ),
      ).toMatchObject({ status: "unavailable", reason: status });
    }

    const malformedReady = beginDocumentLoad(createEmptyDocumentSession(), {
      workspaceId: "workspace-a",
      relativePath: "note.md",
    });
    expect(
      resolveDocumentRead(
        malformedReady,
        malformedReady.generation,
        read("unsafe", revision("unsupported")),
        compatible,
        true,
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "unsupported_encoding",
    });
  });

  it("rejects stale generation and edit-version results", () => {
    const first = beginDocumentLoad(createEmptyDocumentSession(), {
      workspaceId: "workspace-a",
      relativePath: "first.md",
    });
    const second = beginDocumentLoad(first, {
      workspaceId: "workspace-a",
      relativePath: "second.md",
    });
    expect(
      resolveDocumentRead(first, first.generation, { ...read(), relativePath: "first.md" }, compatible, true),
    ).toMatchObject({ status: "ready", relativePath: "first.md" });
    expect(
      resolveDocumentRead(second, first.generation, { ...read(), relativePath: "first.md" }, compatible, true),
    ).toBe(second);

    const session = readySession();
    expect(
      applyDocumentEdit(session, {
        generation: session.generation,
        expectedEditVersion: session.editVersion + 1,
        markdown: "stale",
        mode: "visual",
        selection: { kind: "visual", from: 0, to: 0 },
        anchor: { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 },
        transactionGroup: null,
      }),
    ).toMatchObject({ status: "stale", session: { markdown: "# A" } });
  });

  it("forces parser-incompatible documents into source mode", () => {
    const session = readySession({ compatibility: sourceOnly });
    expect(session.mode).toBe("source");
    expect(
      applyDocumentEdit(session, {
        generation: session.generation,
        expectedEditVersion: session.editVersion,
        markdown: "# visual attempt",
        mode: "visual",
        selection: { kind: "visual", from: 0, to: 0 },
        anchor: { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 },
        transactionGroup: null,
      }).status,
    ).toBe("mode_unavailable");
  });

  it("reassesses current source after unsupported syntax or mixed endings are removed", () => {
    const mixedLoading = beginDocumentLoad(createEmptyDocumentSession(), {
      workspaceId: "workspace-a",
      relativePath: "note.md",
    });
    const mixed = resolveDocumentRead(
      mixedLoading,
      mixedLoading.generation,
      read("one\r\ntwo\n", revision("utf8", "mixed")),
      sourceOnly,
      true,
    );
    if (mixed.status !== "ready") throw new Error("expected ready source session");
    const normalized = applyDocumentEdit(mixed, {
      generation: mixed.generation,
      expectedEditVersion: mixed.editVersion,
      markdown: "one\ntwo\n",
      mode: "source",
      selection: { kind: "source", anchor: 8, head: 8 },
      anchor: { kind: "source", offset: 8, scrollTop: 20 },
      transactionGroup: null,
    });
    if (normalized.status !== "applied") throw new Error("normalization should apply");

    const reassessed = reassessDocumentCompatibility(
      normalized.session,
      normalized.session.generation,
      normalized.session.editVersion,
      compatible,
    );
    expect(reassessed).toMatchObject({
      status: "applied",
      session: {
        mode: "source",
        compatibility: compatible,
        sourceFormat: { lineEnding: "mixed" },
      },
    });
    if (reassessed.status !== "applied") throw new Error("reassessment should apply");
    expect(
      applyDocumentEdit(reassessed.session, {
        generation: reassessed.session.generation,
        expectedEditVersion: reassessed.session.editVersion,
        markdown: reassessed.session.markdown,
        mode: "visual",
        selection: { kind: "visual", from: 8, to: 8 },
        anchor: { kind: "semantic", blockId: null, fallbackOffset: 8, scrollTop: 20 },
        transactionGroup: null,
      }).status,
    ).toBe("applied");
  });

  it("safely downgrades visual mode, rejects stale parses and detects line endings", () => {
    const visualSession = readySession();
    expect(
      reassessDocumentCompatibility(
        visualSession,
        visualSession.generation,
        visualSession.editVersion,
        sourceOnly,
      ),
    ).toMatchObject({
      status: "applied",
      session: {
        mode: "source",
        selection: { kind: "source", anchor: 0, head: 0 },
        anchor: { kind: "source", offset: 0, scrollTop: 0 },
      },
    });

    const session = readySession({ compatibility: sourceOnly });
    expect(
      reassessDocumentCompatibility(
        session,
        session.generation,
        session.editVersion + 1,
        compatible,
      ).status,
    ).toBe("stale");
    expect(lineEndingFromMarkdown("plain")).toBe("none");
    expect(lineEndingFromMarkdown("a\nb")).toBe("lf");
    expect(lineEndingFromMarkdown("a\r\nb")).toBe("crlf");
    expect(lineEndingFromMarkdown("a\rb")).toBe("cr");
    expect(lineEndingFromMarkdown("a\r\nb\n")).toBe("mixed");
  });

  it("records a cross-mode edit and restores the former mode and selection", () => {
    const session = readySession();
    const edited = applyDocumentEdit(session, {
      generation: session.generation,
      expectedEditVersion: session.editVersion,
      markdown: "# B",
      mode: "source",
      selection: { kind: "source", anchor: 3, head: 3 },
      anchor: { kind: "source", offset: 3, scrollTop: 12 },
      transactionGroup: null,
    });
    expect(edited.status).toBe("applied");
    if (edited.status !== "applied") throw new Error("edit should apply");

    const undone = undoDocumentSession(edited.session);
    expect(undone).toMatchObject({
      status: "applied",
      session: {
        markdown: "# A",
        mode: "visual",
        selection: { kind: "visual", from: 0, to: 0 },
        saveState: { kind: "dirty" },
      },
    });
  });

  it("refreshes source format only from a successful save revision", () => {
    const session = readySession();
    const saving = beginDocumentSave(session, "save-1");
    if (saving.status !== "applied") throw new Error("save should start");
    const completed = completeDocumentSave(
      saving.session,
      "save-1",
      revision("utf8_bom", "crlf", "disk-b"),
      20,
    );

    expect(completed).toMatchObject({
      status: "applied",
      session: {
        persistedContentHash: "disk-b",
        sourceFormat: { encoding: "utf8_bom", lineEnding: "crlf" },
        saveState: { kind: "saved", savedAt: 20 },
        contentSafety: { kind: "disk" },
      },
    });
  });

  it("rejects a second save request while one is already in flight", () => {
    const saving = beginDocumentSave(readySession(), "save-first");
    if (saving.status !== "applied") throw new Error("save should start");

    expect(beginDocumentSave(saving.session, "save-second")).toEqual({
      status: "save_in_flight",
      session: saving.session,
    });
  });

  it("keeps edits dirty when input arrives during an in-flight save", () => {
    const session = readySession();
    const saving = beginDocumentSave(session, "save-1");
    if (saving.status !== "applied") throw new Error("save should start");
    const edited = applyDocumentEdit(saving.session, {
      generation: session.generation,
      expectedEditVersion: session.editVersion,
      markdown: "# newer",
      mode: "visual",
      selection: { kind: "visual", from: 7, to: 7 },
      anchor: { kind: "semantic", blockId: null, fallbackOffset: 7, scrollTop: 0 },
      transactionGroup: "typing",
    });
    if (edited.status !== "applied") throw new Error("edit should apply");

    expect(
      completeDocumentSave(
        edited.session,
        "save-1",
        revision("utf8", "lf", "older-save"),
        30,
      ),
    ).toMatchObject({
      status: "applied",
      session: {
        markdown: "# newer",
        persistedContentHash: "older-save",
        saveState: { kind: "dirty" },
        contentSafety: { kind: "memory" },
      },
    });
  });

  it("keeps the in-flight request identifiable when undo happens during save", () => {
    const session = readySession();
    const edited = applyDocumentEdit(session, {
      generation: session.generation,
      expectedEditVersion: session.editVersion,
      markdown: "# B",
      mode: "visual",
      selection: { kind: "visual", from: 3, to: 3 },
      anchor: { kind: "semantic", blockId: null, fallbackOffset: 3, scrollTop: 0 },
      transactionGroup: null,
    });
    if (edited.status !== "applied") throw new Error("edit should apply");
    const saving = beginDocumentSave(edited.session, "save-undo");
    if (saving.status !== "applied") throw new Error("save should start");
    const undone = undoDocumentSession(saving.session);
    if (undone.status !== "applied") throw new Error("undo should apply");

    expect(undone.session.saveState).toEqual({
      kind: "saving",
      requestId: "save-undo",
      editVersion: 1,
      changedAfterStart: true,
    });
    expect(
      completeDocumentSave(
        undone.session,
        "save-undo",
        revision("utf8", "lf", "saved-b"),
        31,
      ),
    ).toMatchObject({
      status: "applied",
      session: {
        markdown: "# A",
        persistedContentHash: "saved-b",
        saveState: { kind: "dirty" },
      },
    });
  });

  it("keeps content in memory and exposes the real error when saving fails", () => {
    const error: DesktopError = {
      code: "safe_write_failed",
      messageKey: "error.desktop.safe_write_failed",
      pathHint: "note.md",
      contentSafe: true,
      retryable: true,
    };
    const saving = beginDocumentSave(readySession(), "save-1");
    if (saving.status !== "applied") throw new Error("save should start");

    expect(failDocumentSave(saving.session, "save-1", error)).toMatchObject({
      status: "applied",
      session: {
        saveState: { kind: "save_failed", error },
        contentSafety: { kind: "memory" },
      },
    });
  });

  it("applies asynchronous reads only to the matching current generation", async () => {
    const first = beginDocumentLoad(createEmptyDocumentSession(), {
      workspaceId: "workspace-a",
      relativePath: "first.md",
    });
    const outcome = await requestDocumentLoad(
      {
        generation: first.generation,
        workspaceId: "workspace-a",
        relativePath: "first.md",
        writable: true,
      },
      { read: vi.fn().mockResolvedValue({ ...read(), relativePath: "first.md" }) },
      {
        parse: vi.fn().mockResolvedValue({
          root: { type: "root", children: [{ type: "paragraph" }] },
          parseError: null,
          unmappedSyntax: [],
        }),
      },
    );
    const second = beginDocumentLoad(first, {
      workspaceId: "workspace-a",
      relativePath: "second.md",
    });

    expect(applyDocumentLoadOutcome(second, outcome)).toBe(second);
    const otherWorkspace = {
      ...first,
      workspaceId: "workspace-b",
    };
    expect(applyDocumentLoadOutcome(otherWorkspace, outcome)).toBe(otherWorkspace);
    expect(applyDocumentLoadOutcome(first, outcome)).toMatchObject({
      status: "ready",
      relativePath: "first.md",
      compatibility: compatible,
    });
  });

  it("degrades parser exceptions to source mode without discarding read content", async () => {
    const loading = beginDocumentLoad(createEmptyDocumentSession(), {
      workspaceId: "workspace-a",
      relativePath: "note.md",
    });
    const outcome = await requestDocumentLoad(
      {
        generation: loading.generation,
        workspaceId: "workspace-a",
        relativePath: "note.md",
        writable: true,
      },
      { read: vi.fn().mockResolvedValue(read("unknown syntax")) },
      { parse: vi.fn().mockRejectedValue(new Error("parser failed")) },
    );

    expect(applyDocumentLoadOutcome(loading, outcome)).toMatchObject({
      status: "ready",
      markdown: "unknown syntax",
      mode: "source",
      compatibility: { mode: "source-only", reasons: ["parse-error"] },
    });
  });
});
