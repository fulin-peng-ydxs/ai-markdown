import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  EditorAdapterChange,
  EditorAdapterLifecycleEvent,
  EditorAdapterDocument,
  EditorSelection,
  EditorSurfaceHandle,
} from "../../editorAdapter";
import {
  MilkdownVisualAdapter,
  type VisualEditorPerformanceSample,
} from "./MilkdownVisualAdapter";
import type {
  PreparedImageRelocation,
  ResolvedWorkspaceImage,
} from "./workspaceImageNodeView";
import {
  writeVisualClipboard,
  type VisualCopyFormat,
} from "./clipboard";
import { visualEditorEligibility } from "./visualEditorPolicy";
import "./VisualMarkdownEditor.css";

export interface VisualMarkdownEditorHandle extends EditorSurfaceHandle {
  copySelection(format: VisualCopyFormat): Promise<boolean>;
  requestImage(): Promise<boolean>;
}

export interface VisualMarkdownEditorProps {
  document: EditorAdapterDocument;
  readOnly?: boolean;
  onChange(change: EditorAdapterChange): void;
  onUnavailable?(reason: {
    code: "document_too_large" | "document_too_complex" | "adapter_failed";
    message: string;
  }): void;
  onPerformance?(sample: VisualEditorPerformanceSample): void;
  onHistoryCommand?(direction: "undo" | "redo"): boolean;
  onAdapterLifecycle?(event: EditorAdapterLifecycleEvent): void;
  onSelectionChange?(selection: EditorSelection): void;
  onRequestImage?(
    selection: EditorSelection,
  ): Promise<{ src: string; alt?: string; title?: string } | null>;
  onRequestLink?(selection: EditorSelection): Promise<{ href: string; title?: string } | null>;
  onRelocateImage?(
    source: string,
  ): Promise<PreparedImageRelocation | null>;
  onResolveImage?(
    source: string,
  ): Promise<ResolvedWorkspaceImage | null>;
}

export const VisualMarkdownEditor = forwardRef<
  VisualMarkdownEditorHandle,
  VisualMarkdownEditorProps
>(function VisualMarkdownEditor(
  {
    document,
    readOnly = false,
    onChange,
    onAdapterLifecycle,
    onHistoryCommand,
    onUnavailable,
    onPerformance,
    onRequestImage,
    onRequestLink,
    onRelocateImage,
    onResolveImage,
    onSelectionChange,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<MilkdownVisualAdapter | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const loadedDocumentRef = useRef<EditorAdapterDocument | null>(null);
  const onChangeRef = useRef(onChange);
  const onAdapterLifecycleRef = useRef(onAdapterLifecycle);
  const onHistoryCommandRef = useRef(onHistoryCommand);
  const onPerformanceRef = useRef(onPerformance);
  const onRequestImageRef = useRef(onRequestImage);
  const onUnavailableRef = useRef(onUnavailable);
  const onRelocateImageRef = useRef(onRelocateImage);
  const onResolveImageRef = useRef(onResolveImage);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const [selection, setSelection] = useState<EditorSelection>(document.selection);
  const [ready, setReady] = useState(false);
  const [feedback, setFeedback] = useState("");
  const eligibility = useMemo(
    () => visualEditorEligibility(document.markdown),
    [document.markdown],
  );
  const eligibilityState = eligibility.eligible ? "eligible" : eligibility.reason;

  onChangeRef.current = onChange;
  onAdapterLifecycleRef.current = onAdapterLifecycle;
  onHistoryCommandRef.current = onHistoryCommand;
  onPerformanceRef.current = onPerformance;
  onRequestImageRef.current = onRequestImage;
  onUnavailableRef.current = onUnavailable;
  onRelocateImageRef.current = onRelocateImage;
  onResolveImageRef.current = onResolveImage;
  onSelectionChangeRef.current = onSelectionChange;

  useImperativeHandle(
    forwardedRef,
    () => ({
      execute: (command) => adapterRef.current?.execute(command) ?? false,
      focus: () => adapterRef.current?.focus(),
      getMarkdown: () =>
        adapterRef.current?.getMarkdown() ?? loadedDocumentRef.current?.markdown ?? "",
      getSelection: () =>
        adapterRef.current?.getSelection() ?? { kind: "visual", from: 0, to: 0 },
      getAnchor: () =>
        adapterRef.current?.getAnchor() ?? {
          kind: "semantic",
          blockId: null,
          fallbackOffset: 0,
          scrollTop: 0,
        },
      setSelection: (nextSelection) => adapterRef.current?.setSelection(nextSelection),
      setSelectionAtCoordinates: (x, y) =>
        adapterRef.current?.setSelectionAtCoordinates(x, y),
      copySelection: async (format) => copy(format),
      requestImage: async () => requestImage(),
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // React StrictMode intentionally replays effects. The canvas is component-owned,
    // so clear any late host from the discarded setup before creating the live adapter.
    root.replaceChildren();
    if (!eligibility.eligible) {
      onUnavailableRef.current?.({
        code: eligibility.reason,
        message: eligibility.message,
      });
      return;
    }

    let active = true;
    const adapter = new MilkdownVisualAdapter(root, {
      readOnly,
      onSelectionChange: (nextSelection) => {
        if (active) {
          setSelection(nextSelection);
          onSelectionChangeRef.current?.(nextSelection);
        }
      },
      onPerformance: (sample) => onPerformanceRef.current?.(sample),
      onHistoryCommand: (direction) => onHistoryCommandRef.current?.(direction) ?? false,
      onRelocateImage: (source) =>
        onRelocateImageRef.current?.(source) ?? Promise.resolve(null),
      onResolveImage: (source) =>
        onResolveImageRef.current?.(source) ?? Promise.resolve(null),
    });
    onAdapterLifecycleRef.current?.({
      mode: "visual",
      phase: "mounted",
    });
    adapterRef.current = adapter;
    loadedDocumentRef.current = document;
    const unsubscribe = adapter.onChange((change) => onChangeRef.current(change));
    const readyPromise = adapter.load(document)
      .then(() => {
        if (active) setReady(true);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        onUnavailableRef.current?.({
          code: "adapter_failed",
          message: reason instanceof Error ? reason.message : "排版编辑器初始化失败",
        });
      });
    readyRef.current = readyPromise;

    return () => {
      active = false;
      unsubscribe();
      adapter.destroy();
      onAdapterLifecycleRef.current?.({
        mode: "visual",
        phase: "unmounted",
      });
      root.replaceChildren();
      adapterRef.current = null;
      readyRef.current = null;
      loadedDocumentRef.current = null;
      setReady(false);
    };
    // The adapter is recreated only when the editable contract or eligibility class
    // changes. Eligible revisions flow through apply below without a second content source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibilityState, readOnly]);

  useEffect(() => {
    if (loadedDocumentRef.current === document) return;
    const adapter = adapterRef.current;
    const readyPromise = readyRef.current;
    if (!adapter || !readyPromise) return;
    loadedDocumentRef.current = document;
    void readyPromise.then(() => adapter.apply(document)).catch(() => undefined);
  }, [document]);

  const selected = selection.kind === "visual" && selection.from !== selection.to;

  async function requestLink() {
    if (!onRequestLink) return;
    try {
      const link = await onRequestLink(selection);
      if (link) adapterRef.current?.execute({ kind: "insert_link", ...link });
    } catch {
      setFeedback("链接操作未完成");
    }
  }

  async function requestImage(): Promise<boolean> {
    const adapter = adapterRef.current;
    const request = onRequestImageRef.current;
    if (!adapter || !request) return false;
    try {
      const image = await request(adapter.getSelection());
      return image ? adapter.execute({ kind: "insert_image", ...image }) : false;
    } catch {
      setFeedback("图片操作未完成");
      return false;
    }
  }

  async function copy(format: VisualCopyFormat): Promise<boolean> {
    const payload = adapterRef.current?.getSelectionClipboardPayload();
    if (!payload) return false;
    const copied = await writeVisualClipboard(format, payload);
    setFeedback(copied ? copySuccessMessage(format) : "当前环境无法写入剪贴板");
    return copied;
  }

  return (
    <div
      className="visual-markdown-editor"
      data-ready={ready || undefined}
      data-readonly={readOnly || undefined}
    >
      {selected && ready ? (
        <div
          aria-label="选区格式"
          className="visual-markdown-editor__selection-toolbar"
          role="toolbar"
        >
          <ToolbarButton label="加粗" onRun={() => adapterRef.current?.execute({ kind: "format", format: "bold" })}>B</ToolbarButton>
          <ToolbarButton label="斜体" onRun={() => adapterRef.current?.execute({ kind: "format", format: "italic" })}><em>I</em></ToolbarButton>
          <ToolbarButton label="删除线" onRun={() => adapterRef.current?.execute({ kind: "format", format: "strike" })}><s>S</s></ToolbarButton>
          <ToolbarButton label="行内代码" onRun={() => adapterRef.current?.execute({ kind: "format", format: "code" })}>{"<>"}</ToolbarButton>
          <ToolbarButton disabled={!onRequestLink} label="链接" onRun={() => void requestLink()}>链接</ToolbarButton>
          <span aria-hidden="true" className="visual-markdown-editor__toolbar-divider" />
          <ToolbarButton label="复制纯文本" onRun={() => void copy("plain_text")}>文本</ToolbarButton>
          <ToolbarButton label="复制 Markdown" onRun={() => void copy("markdown")}>MD</ToolbarButton>
          <ToolbarButton label="复制富文本" onRun={() => void copy("rich_text")}>富文本</ToolbarButton>
        </div>
      ) : null}
      <div className="visual-markdown-editor__canvas" ref={rootRef} />
      <p aria-live="polite" className="visual-markdown-editor__feedback">{feedback}</p>
    </div>
  );
});

function ToolbarButton({
  children,
  disabled = false,
  label,
  onRun,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onRun(): void;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onRun}
      onMouseDown={(event) => event.preventDefault()}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function copySuccessMessage(format: VisualCopyFormat): string {
  if (format === "markdown") return "已复制 Markdown";
  if (format === "rich_text") return "已复制富文本";
  return "已复制纯文本";
}
