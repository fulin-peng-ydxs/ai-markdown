import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import {
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Annotation,
  EditorState,
  Transaction,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";

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
  applyEditorChangesToRawMarkdown,
  editorOffsetToRawOffset,
  projectSourceText,
  rawOffsetToEditorOffset,
  type SourceTextProjection,
} from "./sourceTextProjection";

export interface CodeMirrorSourceAdapterOptions {
  readOnly?: boolean;
  onHistoryCommand?: (direction: "undo" | "redo") => boolean;
  onPerformance?: (sample: SourceEditorPerformanceSample) => void;
  onSelectionChange?: (selection: EditorSelection) => void;
}

export interface SourceEditorPerformanceSample {
  phase: "mount" | "external_apply" | "input_to_change";
  durationMs: number;
  byteLength: number;
}

const externalProjection = Annotation.define<boolean>();

export class CodeMirrorSourceAdapter implements EditorAdapter {
  readonly mode = "source" as const;

  private view: EditorView | null = null;
  private document: EditorAdapterDocument | null = null;
  private readonly listeners = new Set<(change: EditorAdapterChange) => void>();
  private compositionGroup: string | null = null;
  private inputStartedAt: number | null = null;
  private rawMarkdown = "";
  private preferredLineSeparator: SourceTextProjection["preferredLineSeparator"] =
    "\n";
  private destroyed = false;
  private readonly root: HTMLElement;
  private readonly options: CodeMirrorSourceAdapterOptions;

  constructor(root: HTMLElement, options: CodeMirrorSourceAdapterOptions = {}) {
    this.root = root;
    this.options = options;
  }

  load(document: EditorAdapterDocument): void {
    if (this.destroyed) return;
    this.ensureSourceDocument(document);
    this.view?.destroy();
    this.root.replaceChildren();
    this.document = document;
    const projection = projectSourceText(document.markdown);
    this.rawMarkdown = document.markdown;
    this.preferredLineSeparator = projection.preferredLineSeparator;

    const startedAt = performance.now();
    const selection = sourceSelection(document.selection, this.rawMarkdown);
    const view = new EditorView({
      state: EditorState.create({
        doc: projection.editorText,
        selection,
        extensions: this.extensions(),
      }),
      parent: this.root,
    });
    if (this.destroyed) {
      view.destroy();
      this.root.replaceChildren();
      return;
    }
    this.view = view;
    this.restoreScroll(document.anchor);
    this.recordPerformance("mount", startedAt, document.markdown);
  }

  apply(document: EditorAdapterDocument): void {
    if (this.destroyed) return;
    this.ensureSourceDocument(document);
    if (!this.view) {
      this.load(document);
      return;
    }

    const startedAt = performance.now();
    const current = this.view.state.doc.toString();
    const projection = projectSourceText(document.markdown);
    this.document = document;
    this.rawMarkdown = document.markdown;
    this.preferredLineSeparator = projection.preferredLineSeparator;
    const selection = sourceSelection(document.selection, this.rawMarkdown);
    this.view.dispatch({
      changes:
        current === projection.editorText
          ? undefined
          : { from: 0, to: current.length, insert: projection.editorText },
      selection,
      annotations: [
        externalProjection.of(true),
        Transaction.addToHistory.of(false),
        Transaction.remote.of(true),
      ],
    });
    this.restoreScroll(document.anchor);
    if (current !== projection.editorText) {
      this.recordPerformance("external_apply", startedAt, document.markdown);
    }
  }

  focus(): void {
    this.view?.focus();
  }

  getSelection(): EditorSelection {
    const main = this.view?.state.selection.main;
    return main
      ? {
          kind: "source",
          anchor: editorOffsetToRawOffset(this.rawMarkdown, main.anchor),
          head: editorOffsetToRawOffset(this.rawMarkdown, main.head),
        }
      : { kind: "source", anchor: 0, head: 0 };
  }

  setSelection(selection: EditorSelection): void {
    const view = this.view;
    if (!view || selection.kind !== "source") return;
    view.dispatch({
      selection: sourceSelection(selection, this.rawMarkdown),
      scrollIntoView: true,
      annotations: Transaction.addToHistory.of(false),
    });
  }

  getAnchor(): DocumentAnchor {
    const selection = this.getSelection();
    return {
      kind: "source",
      offset: selection.kind === "source" ? selection.head : 0,
      scrollTop: this.view?.scrollDOM.scrollTop ?? 0,
    };
  }

  onChange(listener: (change: EditorAdapterChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(command: EditorCommand): boolean {
    const view = this.view;
    if (!view) return false;
    if (command.kind === "find") return openSearchPanel(view);
    if (command.kind === "replace") {
      if (this.options.readOnly) return false;
      return openSearchPanel(view);
    }
    if (command.kind === "history") {
      if (this.options.readOnly) return false;
      return this.options.onHistoryCommand?.(command.direction) ?? false;
    }
    return false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
    this.view?.destroy();
    this.view = null;
    this.document = null;
    this.rawMarkdown = "";
    this.root.replaceChildren();
  }

  private extensions(): Extension[] {
    return [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      markdownLanguage(),
      search({ top: true }),
      keymap.of([...searchKeymap, indentWithTab, ...defaultKeymap]),
      EditorState.readOnly.of(Boolean(this.options.readOnly)),
      EditorState.phrases.of(SOURCE_EDITOR_PHRASES),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Markdown 源码编辑区",
        "aria-readonly": this.options.readOnly ? "true" : "false",
        spellcheck: "false",
      }),
      EditorView.domEventHandlers({
        keydown: (event) => {
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
          const key = event.key.toLowerCase();
          const direction =
            key === "z"
              ? event.shiftKey
                ? "redo"
                : "undo"
              : key === "y"
                ? "redo"
                : null;
          if (!direction) return false;
          event.preventDefault();
          if (!this.options.readOnly) {
            this.options.onHistoryCommand?.(direction);
          }
          // Always consume browser undo/redo so the session remains the sole
          // history source even when it has no matching history entry.
          return true;
        },
        beforeinput: () => {
          this.inputStartedAt = performance.now();
          return false;
        },
        compositionstart: () => {
          this.compositionGroup = crypto.randomUUID();
          return false;
        },
        compositionend: () => {
          this.compositionGroup = null;
          return false;
        },
      }),
      EditorView.updateListener.of((update) => this.handleUpdate(update)),
    ];
  }

  private handleUpdate(update: ViewUpdate): void {
    if (this.destroyed || !this.document) return;
    if (!update.docChanged) {
      if (update.selectionSet) {
        this.options.onSelectionChange?.(
          this.sourceSelectionFromRange(update.state.selection.main),
        );
      }
      return;
    }
    if (
      update.transactions.some((transaction) =>
        transaction.annotation(externalProjection),
      )
    ) {
      return;
    }

    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue;
      this.rawMarkdown = applyEditorChangesToRawMarkdown(
        this.rawMarkdown,
        transaction.changes,
        this.preferredLineSeparator,
      );
    }
    if (update.selectionSet) {
      this.options.onSelectionChange?.(
        this.sourceSelectionFromRange(update.state.selection.main),
      );
    }
    const markdown = this.rawMarkdown;
    if (this.inputStartedAt !== null) {
      this.recordPerformance("input_to_change", this.inputStartedAt, markdown);
      this.inputStartedAt = null;
    }
    const change: EditorAdapterChange = {
      generation: this.document.generation,
      expectedEditVersion: this.document.editVersion,
      markdown,
      selection: this.sourceSelectionFromRange(update.state.selection.main),
      anchor: {
        kind: "source",
        offset: editorOffsetToRawOffset(
          this.rawMarkdown,
          update.state.selection.main.head,
        ),
        scrollTop: update.view.scrollDOM.scrollTop,
      },
      transactionGroup: this.compositionGroup,
    };
    if (!update.view.composing) this.compositionGroup = null;
    for (const listener of this.listeners) listener(change);
  }

  private restoreScroll(anchor: DocumentAnchor): void {
    if (!this.view || anchor.kind !== "source") return;
    this.view.scrollDOM.scrollTop = Math.max(0, anchor.scrollTop);
  }

  private ensureSourceDocument(document: EditorAdapterDocument): void {
    if (document.selection.kind !== "source") {
      throw new Error("CodeMirror source adapter requires a source selection");
    }
  }

  private sourceSelectionFromRange(range: SelectionRange): EditorSelection {
    return {
      kind: "source",
      anchor: editorOffsetToRawOffset(this.rawMarkdown, range.anchor),
      head: editorOffsetToRawOffset(this.rawMarkdown, range.head),
    };
  }

  private recordPerformance(
    phase: SourceEditorPerformanceSample["phase"],
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

function sourceSelection(selection: EditorSelection, rawMarkdown: string) {
  if (selection.kind !== "source") {
    return { anchor: 0, head: 0 };
  }
  return {
    anchor: rawOffsetToEditorOffset(rawMarkdown, selection.anchor),
    head: rawOffsetToEditorOffset(rawMarkdown, selection.head),
  };
}

const SOURCE_EDITOR_PHRASES: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "选择全部匹配",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全词匹配",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "on line": "位于第",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处匹配",
};
