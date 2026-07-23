import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import type {
  EditorAdapterChange,
  EditorAdapterDocument,
  EditorSurfaceHandle,
} from "../../editorAdapter";
import {
  CodeMirrorSourceAdapter,
  type SourceEditorPerformanceSample,
} from "./CodeMirrorSourceAdapter";
import "./SourceMarkdownEditor.css";

export type SourceMarkdownEditorHandle = EditorSurfaceHandle;

export interface SourceMarkdownEditorProps {
  document: EditorAdapterDocument;
  readOnly?: boolean;
  onChange(change: EditorAdapterChange): void;
  onHistoryCommand?(direction: "undo" | "redo"): boolean;
  onPerformance?(sample: SourceEditorPerformanceSample): void;
  onUnavailable?(reason: { code: "adapter_failed"; message: string }): void;
}

export const SourceMarkdownEditor = forwardRef<
  SourceMarkdownEditorHandle,
  SourceMarkdownEditorProps
>(function SourceMarkdownEditor(
  {
    document,
    readOnly = false,
    onChange,
    onHistoryCommand,
    onPerformance,
    onUnavailable,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<CodeMirrorSourceAdapter | null>(null);
  const loadedDocumentRef = useRef<EditorAdapterDocument | null>(null);
  const onChangeRef = useRef(onChange);
  const onHistoryCommandRef = useRef(onHistoryCommand);
  const onPerformanceRef = useRef(onPerformance);
  const onUnavailableRef = useRef(onUnavailable);

  onChangeRef.current = onChange;
  onHistoryCommandRef.current = onHistoryCommand;
  onPerformanceRef.current = onPerformance;
  onUnavailableRef.current = onUnavailable;

  useImperativeHandle(
    forwardedRef,
    () => ({
      execute: (command) => adapterRef.current?.execute(command) ?? false,
      focus: () => adapterRef.current?.focus(),
      getSelection: () =>
        adapterRef.current?.getSelection() ?? {
          kind: "source",
          anchor: 0,
          head: 0,
        },
      setSelection: (selection) => adapterRef.current?.setSelection(selection),
    }),
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren();

    const adapter = new CodeMirrorSourceAdapter(root, {
      readOnly,
      onHistoryCommand: (direction) =>
        onHistoryCommandRef.current?.(direction) ?? false,
      onPerformance: (sample) => onPerformanceRef.current?.(sample),
    });
    adapterRef.current = adapter;
    loadedDocumentRef.current = document;
    const unsubscribe = adapter.onChange((change) => onChangeRef.current(change));
    try {
      adapter.load(document);
    } catch (reason) {
      onUnavailableRef.current?.({
        code: "adapter_failed",
        message:
          reason instanceof Error ? reason.message : "源码编辑器初始化失败",
      });
    }

    return () => {
      unsubscribe();
      adapter.destroy();
      adapterRef.current = null;
      loadedDocumentRef.current = null;
      root.replaceChildren();
    };
    // Read-only changes recreate the editor configuration. Document revisions
    // use apply below and remain projections of the same DocumentSession.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    if (loadedDocumentRef.current === document) return;
    const adapter = adapterRef.current;
    if (!adapter) return;
    loadedDocumentRef.current = document;
    try {
      adapter.apply(document);
    } catch (reason) {
      onUnavailableRef.current?.({
        code: "adapter_failed",
        message:
          reason instanceof Error ? reason.message : "源码内容更新失败",
      });
    }
  }, [document]);

  return (
    <div
      className="source-markdown-editor"
      data-readonly={readOnly || undefined}
    >
      <div className="source-markdown-editor__canvas" ref={rootRef} />
    </div>
  );
});
