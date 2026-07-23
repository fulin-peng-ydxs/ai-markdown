import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  schemaCtx,
  serializerCtx,
  type CmdKey,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { keymap } from "@milkdown/kit/prose/keymap";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import {
  insertHrCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  imageSchema,
  commonmark,
} from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  insertTableCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { $prose, $view, callCommand, getMarkdown, replaceAll } from "@milkdown/kit/utils";

import type {
  DocumentAnchor,
  EditorAdapter,
  EditorAdapterChange,
  EditorAdapterDocument,
  EditorCommand,
  EditorSelection,
} from "../../editorAdapter";
import { utf8ByteLength } from "../../documentMetrics";
import {
  clipboardPayloadFromSlice,
  sanitizeRichClipboardHtml,
  type VisualClipboardPayload,
} from "./clipboard";
import { visualEditorEligibility } from "./visualEditorPolicy";
import {
  createWorkspaceImageNodeView,
  type PreparedImageRelocation,
  type ResolvedWorkspaceImage,
} from "./workspaceImageNodeView";

export interface MilkdownVisualAdapterOptions {
  readOnly?: boolean;
  onSelectionChange?: (selection: EditorSelection) => void;
  onPerformance?: (sample: VisualEditorPerformanceSample) => void;
  onHistoryCommand?: (direction: "undo" | "redo") => boolean;
  onRelocateImage?: (
    source: string,
  ) => Promise<PreparedImageRelocation | null>;
  onResolveImage?: (
    source: string,
  ) => Promise<ResolvedWorkspaceImage | null>;
}

export interface VisualEditorPerformanceSample {
  phase: "mount" | "external_apply" | "input_to_markdown";
  durationMs: number;
  byteLength: number;
}

export class VisualEditorUnavailableError extends Error {
  readonly code = "visual_editor_unavailable";
  readonly byteLength: number;

  constructor(message: string, byteLength: number) {
    super(message);
    this.byteLength = byteLength;
  }
}

export class MilkdownVisualAdapter implements EditorAdapter {
  readonly mode = "visual" as const;

  private editor: Editor | null = null;
  private document: EditorAdapterDocument | null = null;
  private readonly listeners = new Set<(change: EditorAdapterChange) => void>();
  private destroyed = false;
  private compositionGroup: string | null = null;
  private currentMarkdown = "";
  private lastAppliedMarkdown = "";
  private lastInputStartedAt: number | null = null;
  private applyingExternalDocument = false;
  private acceptingInputTransactions = false;
  private creationPromise: Promise<void> | null = null;
  private mountHost: HTMLDivElement | null = null;
  private readonly root: HTMLElement;
  private readonly options: MilkdownVisualAdapterOptions;

  constructor(root: HTMLElement, options: MilkdownVisualAdapterOptions = {}) {
    this.root = root;
    this.options = options;
  }

  async load(document: EditorAdapterDocument): Promise<void> {
    if (this.destroyed) return;
    this.ensureVisualDocument(document);
    this.acceptingInputTransactions = false;
    this.lastInputStartedAt = null;
    if (this.editor) await this.editor.destroy();
    this.document = document;
    this.currentMarkdown = document.markdown;
    this.lastAppliedMarkdown = document.markdown;
    this.mountHost?.remove();
    const mountHost = this.root.ownerDocument.createElement("div");
    mountHost.className = "visual-markdown-editor__milkdown-host";
    this.root.append(mountHost);
    this.mountHost = mountHost;

    const mountStartedAt = performance.now();
    const sessionHistoryBridge = $prose(() =>
      keymap({
        "Mod-z": () => this.options.onHistoryCommand?.("undo") ?? false,
        "Shift-Mod-z": () => this.options.onHistoryCommand?.("redo") ?? false,
        "Mod-y": () => this.options.onHistoryCommand?.("redo") ?? false,
      }),
    );
    const inputLatencyProbe = $prose(
      () =>
        new Plugin({
          state: {
            init: () => null,
            apply: (transaction) => {
              if (
                transaction.docChanged &&
                this.acceptingInputTransactions &&
                !this.applyingExternalDocument &&
                this.lastInputStartedAt === null
              ) {
                this.lastInputStartedAt = performance.now();
              }
              return null;
            },
          },
        }),
    );
    const workspaceImageView = $view(imageSchema.node, () => (node, view, getPos) =>
      createWorkspaceImageNodeView(node, view, getPos, {
        readOnly: Boolean(this.options.readOnly),
        relocate: this.options.onRelocateImage,
        resolve: this.options.onResolveImage,
      }),
    );
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, mountHost);
        ctx.set(defaultValueCtx, document.markdown);
        ctx.update(editorViewOptionsCtx, (current) => ({
          ...current,
          editable: () => !this.options.readOnly,
          transformPastedHTML: (html, view) => {
            const transformed = current.transformPastedHTML
              ? current.transformPastedHTML(html, view)
              : html;
            return sanitizeRichClipboardHtml(transformed);
          },
          attributes: {
            ...current.attributes,
            "aria-label": "Markdown 排版编辑区",
            "data-readonly": this.options.readOnly ? "true" : "false",
          },
          handleDOMEvents: {
            ...current.handleDOMEvents,
            beforeinput: () => {
              this.lastInputStartedAt = performance.now();
              return false;
            },
            compositionstart: () => {
              this.compositionGroup = crypto.randomUUID();
              return false;
            },
          },
        }));
        ctx.get(listenerCtx)
          .markdownUpdated((_listenerCtx, markdown) => this.emitMarkdownChange(markdown))
          .selectionUpdated((_listenerCtx, selection) => {
            this.options.onSelectionChange?.({
              kind: "visual",
              from: selection.from,
              to: selection.to,
            });
          });
      })
      .use(commonmark)
      .use(workspaceImageView)
      .use(gfm)
      .use(clipboard)
      .use(sessionHistoryBridge)
      .use(inputLatencyProbe)
      .use(listener);

    this.editor = editor;
    const creationPromise = editor.create().then(() => undefined);
    this.creationPromise = creationPromise;
    await creationPromise;
    if (this.destroyed || this.editor !== editor) {
      await editor.destroy();
      mountHost.remove();
      return;
    }
    this.acceptingInputTransactions = true;
    this.lastInputStartedAt = null;
    this.setSelection(document.selection);
    this.recordPerformance("mount", mountStartedAt, document.markdown);
  }

  async apply(document: EditorAdapterDocument): Promise<void> {
    if (this.destroyed) return;
    this.ensureVisualDocument(document);
    if (!this.editor) return this.load(document);

    this.document = document;
    const markdown = this.editor.action(getMarkdown());
    if (markdown !== document.markdown) {
      const applyStartedAt = performance.now();
      this.lastAppliedMarkdown = document.markdown;
      this.applyingExternalDocument = true;
      try {
        this.editor.action(replaceAll(document.markdown, true));
      } finally {
        this.applyingExternalDocument = false;
      }
      this.recordPerformance("external_apply", applyStartedAt, document.markdown);
    } else {
      this.lastAppliedMarkdown = markdown;
    }
    this.currentMarkdown = document.markdown;
    this.setSelection(document.selection);
  }

  focus(): void {
    this.view()?.focus();
  }

  getMarkdown(): string {
    if (!this.editor) return this.currentMarkdown;
    return this.lastInputStartedAt === null
      ? this.currentMarkdown
      : this.editor.action(getMarkdown());
  }

  getSelection(): EditorSelection {
    const selection = this.view()?.state.selection;
    return selection
      ? { kind: "visual", from: selection.from, to: selection.to }
      : { kind: "visual", from: 0, to: 0 };
  }

  setSelection(selection: EditorSelection): void {
    const view = this.view();
    if (!view || selection.kind !== "visual") return;
    const max = view.state.doc.content.size;
    const from = clamp(selection.from, 0, max);
    const to = clamp(selection.to, from, max);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to)),
      ),
    );
  }

  setSelectionAtCoordinates(x: number, y: number): void {
    const view = this.view();
    const position = view?.posAtCoords({ left: x, top: y })?.pos;
    if (!view || position === undefined) return;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(position)),
      ),
    );
  }

  getAnchor(): DocumentAnchor {
    const view = this.view();
    if (!view) return { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 };
    const selection = view.state.selection;
    const resolved = selection.$from;
    let blockId: string | null = null;
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      const id = resolved.node(depth).attrs.id;
      if (typeof id === "string" && id) {
        blockId = id;
        break;
      }
    }
    return {
      kind: "semantic",
      blockId,
      fallbackOffset: selection.from,
      scrollTop:
        this.root.closest<HTMLElement>("[data-editor-scroll-owner]")?.scrollTop ??
        this.root.scrollTop,
    };
  }

  onChange(listenerFn: (change: EditorAdapterChange) => void): () => void {
    this.listeners.add(listenerFn);
    return () => this.listeners.delete(listenerFn);
  }

  execute(command: EditorCommand): boolean {
    if (!this.editor || this.options.readOnly) return false;
    switch (command.kind) {
      case "format":
        return this.run(
          command.format === "bold"
            ? toggleStrongCommand
            : command.format === "italic"
              ? toggleEmphasisCommand
              : command.format === "strike"
                ? toggleStrikethroughCommand
                : toggleInlineCodeCommand,
        );
      case "heading":
        return this.run(wrapInHeadingCommand, command.level);
      case "block":
        if (command.block === "paragraph") return this.run(turnIntoTextCommand);
        if (command.block === "quote") return this.run(wrapInBlockquoteCommand);
        if (command.block === "ordered_list") return this.run(wrapInOrderedListCommand);
        if (command.block === "bullet_list" || command.block === "task_list") {
          const wrapped = this.run(wrapInBulletListCommand);
          if (wrapped && command.block === "task_list") this.markSelectedListItemsAsTasks();
          return wrapped;
        }
        return false;
      case "insert_link":
        return this.run(toggleLinkCommand, { href: command.href, title: command.title });
      case "insert_image":
        return this.run(insertImageCommand, {
          src: command.src,
          alt: command.alt,
          title: command.title,
        });
      case "insert_table":
        return this.run(insertTableCommand, {
          row: command.rows ?? 3,
          col: command.columns ?? 3,
        });
      case "insert_divider":
        return this.run(insertHrCommand);
      case "history":
        return this.options.onHistoryCommand?.(command.direction) ?? false;
      case "find":
      case "replace":
        return false;
    }
  }

  getSelectionClipboardPayload(): VisualClipboardPayload | null {
    const editor = this.editor;
    const view = this.view();
    if (!editor || !view || view.state.selection.empty) return null;
    const slice = view.state.selection.content();
    const schema = editor.ctx.get(schemaCtx);
    const serialize = editor.ctx.get(serializerCtx);
    return clipboardPayloadFromSlice(slice, schema, serialize);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.acceptingInputTransactions = false;
    this.listeners.clear();
    const editor = this.editor;
    const creationPromise = this.creationPromise;
    const mountHost = this.mountHost;
    this.editor = null;
    this.creationPromise = null;
    this.mountHost = null;
    this.document = null;
    this.currentMarkdown = "";
    mountHost?.remove();
    if (editor) {
      void (creationPromise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => editor.destroy())
        .catch(() => undefined);
    }
  }

  private run<T>(command: { key: CmdKey<T> }, payload?: T): boolean {
    if (!this.editor) return false;
    return this.editor.action(callCommand(command.key, payload));
  }

  private markSelectedListItemsAsTasks(): void {
    const view = this.view();
    if (!view) return;
    const { from, to } = view.state.selection;
    let transaction = view.state.tr;
    view.state.doc.nodesBetween(from, to, (node, position) => {
      if (node.type.name === "list_item" && node.attrs.checked == null) {
        transaction = transaction.setNodeMarkup(position, undefined, {
          ...node.attrs,
          checked: false,
        });
      }
    });
    if (transaction.docChanged) view.dispatch(transaction);
  }

  private emitMarkdownChange(markdown: string): void {
    if (this.destroyed || !this.document || markdown === this.lastAppliedMarkdown) return;
    this.currentMarkdown = markdown;
    if (this.lastInputStartedAt !== null) {
      this.recordPerformance("input_to_markdown", this.lastInputStartedAt, markdown);
      this.lastInputStartedAt = null;
    }
    const selection = this.getSelection();
    const change: EditorAdapterChange = {
      generation: this.document.generation,
      expectedEditVersion: this.document.editVersion,
      markdown,
      selection,
      anchor: this.getAnchor(),
      transactionGroup: this.compositionGroup,
    };
    this.compositionGroup = null;
    for (const listenerFn of this.listeners) listenerFn(change);
  }

  private ensureVisualDocument(document: EditorAdapterDocument): void {
    if (document.selection.kind !== "visual") {
      throw new Error("Milkdown visual adapter requires a visual selection");
    }
    const eligibility = visualEditorEligibility(document.markdown);
    if (!eligibility.eligible) {
      throw new VisualEditorUnavailableError(eligibility.message, eligibility.byteLength);
    }
  }

  private view() {
    const view = this.editor?.ctx.get(editorViewCtx);
    return view?.state ? view : null;
  }

  private recordPerformance(
    phase: VisualEditorPerformanceSample["phase"],
    startedAt: number,
    markdown: string,
  ): void {
    this.options.onPerformance?.({
      phase,
      durationMs: performance.now() - startedAt,
      byteLength: utf8ByteLength(markdown),
    });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
