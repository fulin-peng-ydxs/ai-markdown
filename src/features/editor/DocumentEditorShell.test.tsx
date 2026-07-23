import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  applyDocumentEdit,
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "./documentSession";
import { DocumentEditorShell } from "./DocumentEditorShell";
import type { EditorAssetGateway } from "./editorGateway";

const compatible = { mode: "visual", reasons: [] } as const;

describe("DocumentEditorShell", () => {
  it("switches visual to source and back through one controlled session", async () => {
    const user = userEvent.setup();
    const rendered = render(<Harness initial={readySession("# One\n\nBody")} />);
    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "源码" }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "源码" }).getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "排版" }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    expect(screen.getByText("磁盘版本")).toBeTruthy();
  });

  it("reassesses the current edit before leaving source-only mode", async () => {
    const user = userEvent.setup();
    const parser = {
      parse: vi.fn().mockResolvedValue({
        root: { type: "root", children: [{ type: "paragraph" }] },
        parseError: null,
        unmappedSyntax: [],
      }),
    };
    const sourceOnly = readySession("# safe now", {
      mode: "source-only",
      reasons: ["frontmatter"],
    });
    const rendered = render(<Harness initial={sourceOnly} parser={parser} />);

    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    const modeButton = screen.getByRole("button", { name: "排版" });
    expect((modeButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(modeButton);

    await waitFor(() => expect(parser.parse).toHaveBeenCalledWith("# safe now"));
    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );
  });

  it("rejects a stale asynchronous parse result", async () => {
    let resolveParse!: (value: {
      root: { type: string; children: { type: string }[] };
      parseError: null;
      unmappedSyntax: never[];
    }) => void;
    const parser = {
      parse: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveParse = resolve;
          }),
      ),
    };
    const onSessionChange = vi.fn();
    const initial = readySession("# source", {
      mode: "source-only",
      reasons: ["frontmatter"],
    });
    const rendered = render(
      <DocumentEditorShell
        onSessionChange={onSessionChange}
        parser={parser}
        session={{
          ...initial,
          compatibility: compatible,
          mode: "source",
          selection: { kind: "source", anchor: 0, head: 0 },
          anchor: { kind: "source", offset: 0, scrollTop: 0 },
        }}
      />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: "排版" }));
    rendered.rerender(
      <DocumentEditorShell
        onSessionChange={onSessionChange}
        parser={parser}
        session={{
          ...initial,
          compatibility: compatible,
          mode: "source",
          editVersion: 1,
          markdown: "# newer",
          selection: { kind: "source", anchor: 7, head: 7 },
          anchor: { kind: "source", offset: 7, scrollTop: 0 },
        }}
      />,
    );
    await act(async () => {
      resolveParse({
        root: { type: "root", children: [{ type: "paragraph" }] },
        parseError: null,
        unmappedSyntax: [],
      });
    });

    expect(onSessionChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("文档已发生变化，请再次切换排版模式"),
    ).toBeTruthy();
    expect(rendered.container.querySelector(".cm-editor")).not.toBeNull();
  });

  it("restores content and mode through the shared cross-mode history", async () => {
    const user = userEvent.setup();
    const base = readySession("# Before");
    const changed = applyDocumentEdit(base, {
      generation: base.generation,
      expectedEditVersion: base.editVersion,
      markdown: "# After",
      mode: "source",
      selection: { kind: "source", anchor: 7, head: 7 },
      anchor: { kind: "source", offset: 7, scrollTop: 10 },
      transactionGroup: null,
    });
    if (changed.status !== "applied") throw new Error("expected edit");

    const rendered = render(<Harness initial={changed.session} />);
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    expect(rendered.container.textContent).toContain("Before");
    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("keeps an empty-document placeholder outside the Markdown value", async () => {
    const onSessionChange = vi.fn();
    const rendered = render(
      <DocumentEditorShell
        onSessionChange={onSessionChange}
        session={readySession("")}
      />,
    );
    expect(
      screen.getByText("开始输入 Markdown；此提示不会写入文档。"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it("disables mutations but keeps source find available for readonly documents", async () => {
    const user = userEvent.setup();
    const rendered = render(
      <Harness initial={readySession("# Readonly", compatible, false)} />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull(),
    );
    expect(
      (screen.getByRole("button", { name: "加粗" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("只读")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "切换源码并查找" }));
    await waitFor(() => expect(screen.getByLabelText("查找")).toBeTruthy());
  });

  it("routes manual save through the shell without claiming success itself", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <DocumentEditorShell
        onSave={onSave}
        onSessionChange={() => undefined}
        session={readySession("# Save")}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存当前文档" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByText("磁盘版本")).toBeTruthy();
  });

  it("inserts a selected image only after the workspace resource is prepared", async () => {
    const api = assetGateway();
    const user = userEvent.setup();
    const rendered = render(
      <Harness assetGateway={api} initial={readySession("# Images")} />,
    );
    await user.click(screen.getByRole("button", { name: "源码" }));
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "从本机选择并插入图片" }),
    );

    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(
      "workspace-a",
      "import-1",
    ));
    expect(rendered.container.querySelector(".cm-content")?.textContent).toContain(
      "![picture](assets/picture.png)",
    );
  });

  it("rolls back only the just-inserted image when resource confirmation fails", async () => {
    const api = assetGateway();
    vi.mocked(api.confirm).mockRejectedValue(new Error("confirmation failed"));
    const user = userEvent.setup();
    const rendered = render(
      <Harness
        assetGateway={api}
        initial={{
          ...readySession("# Images"),
          mode: "source",
          selection: { kind: "source", anchor: 8, head: 8 },
          anchor: { kind: "source", offset: 8, scrollTop: 0 },
        }}
      />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );

    await user.click(
      screen.getByRole("button", { name: "从本机选择并插入图片" }),
    );

    expect(
      await screen.findByText(
        "图片确认失败，链接已回退；未确认资源不会被误删。",
      ),
    ).toBeTruthy();
    expect(
      rendered.container.querySelector(".cm-content")?.textContent,
    ).not.toContain("assets/picture.png");
  });

  it("allows only one native image selection while an import is pending", async () => {
    const api = assetGateway();
    let resolveSelection!: (
      value: Awaited<ReturnType<EditorAssetGateway["select"]>>,
    ) => void;
    vi.mocked(api.select).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    render(
      <Harness assetGateway={api} initial={readySession("# Images")} />,
    );
    const button = screen.getByRole("button", {
      name: "从本机选择并插入图片",
    });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.select).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSelection({ status: "cancelled" });
    });
  });

  it("reports partial clipboard image failures without inserting a failed link", async () => {
    const api = assetGateway();
    vi.mocked(api.beginUpload).mockResolvedValue({
      uploadId: "upload-1",
      maxBytes: 20 * 1024 * 1024,
      acceptedKind: "png",
    });
    vi.mocked(api.upload).mockResolvedValue({
      importId: "import-upload",
      workspaceId: "workspace-a",
      assetPath: "assets/clipboard.png",
      fileName: "clipboard.png",
      imageKind: "png",
      mediaType: "image/png",
      byteLength: 8,
    });
    const rendered = render(
      <Harness
        assetGateway={api}
        initial={{
          ...readySession("# Images"),
          mode: "source",
          selection: { kind: "source", anchor: 8, head: 8 },
          anchor: { kind: "source", offset: 8, scrollTop: 0 },
        }}
      />,
    );
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-editor")).not.toBeNull(),
    );
    const png = fileWithBytes(
      "clipboard.png",
      "image/png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const svg = fileWithBytes(
      "active.svg",
      "image/svg+xml",
      new TextEncoder().encode("<svg><script/></svg>"),
    );
    fireEvent.paste(
      rendered.container.querySelector(".document-editor-shell__surface")!,
      { clipboardData: { files: [png, svg] } },
    );

    expect(
      await screen.findByText(
        "已插入 1 张图片，1 张未完成；失败项没有写入链接。",
      ),
    ).toBeTruthy();
    expect(api.confirm).toHaveBeenCalledWith(
      "workspace-a",
      "import-upload",
    );
    expect(rendered.container.querySelector(".cm-content")?.textContent).not.toContain(
      "active.svg",
    );
  });
});

function Harness({
  assetGateway,
  initial,
  parser,
}: {
  assetGateway?: EditorAssetGateway;
  initial: ReadyDocumentSession;
  parser?: React.ComponentProps<typeof DocumentEditorShell>["parser"];
}) {
  const [session, setSession] = useState(initial);
  return (
    <DocumentEditorShell
      assetGateway={assetGateway}
      onSessionChange={setSession}
      parser={parser}
      session={session}
    />
  );
}

function assetGateway(): EditorAssetGateway {
  return {
    getPreference: vi.fn().mockResolvedValue({
      workspaceId: "workspace-a",
      assetDirectory: "assets",
    }),
    setDirectory: vi.fn(),
    resetDirectory: vi.fn(),
    beginUpload: vi.fn(),
    upload: vi.fn(),
    select: vi.fn().mockResolvedValue({
      status: "ready",
      proposal: {
        importId: "import-1",
        workspaceId: "workspace-a",
        assetPath: "assets/picture.png",
        fileName: "picture.png",
        imageKind: "png",
        mediaType: "image/png",
        byteLength: 8,
      },
    }),
    confirm: vi.fn().mockResolvedValue({
      workspaceId: "workspace-a",
      assetPath: "assets/picture.png",
      fileName: "picture.png",
      imageKind: "png",
      mediaType: "image/png",
      byteLength: 8,
    }),
    cancel: vi.fn().mockResolvedValue(false),
    read: vi.fn(),
  };
}

function fileWithBytes(
  name: string,
  type: string,
  bytes: Uint8Array,
): File {
  const file = new File([Uint8Array.from(bytes).buffer], name, { type });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => Uint8Array.from(bytes).buffer,
  });
  return file;
}

function readySession(
  markdown: string,
  compatibility:
    | typeof compatible
    | { mode: "source-only"; reasons: readonly string[] } = compatible,
  writable = true,
): ReadyDocumentSession {
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
      content: markdown,
      revision: {
        modifiedAt: 1,
        size: markdown.length,
        contentHash: "disk",
        encoding: "utf8",
        lineEnding: "lf",
      },
    },
    compatibility,
    writable,
  );
  if (resolved.status !== "ready") throw new Error("expected ready session");
  return resolved;
}
