import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { AsyncStatePanel } from "../../components/AsyncStatePanel";
import type { SourceMarkdownEditorHandle } from "./adapters/codemirror/SourceMarkdownEditor";
import type { VisualMarkdownEditorHandle } from "./adapters/milkdown/VisualMarkdownEditor";
import {
  applyDocumentEdit,
  reassessDocumentCompatibility,
  redoDocumentSession,
  undoDocumentSession,
  type ReadyDocumentSession,
  type SessionMutationResult,
} from "./documentSession";
import type {
  DocumentAnchor,
  EditorAdapterLifecycleEvent,
  EditorAdapterChange,
  EditorCommand,
  EditorMode,
  EditorSelection,
  EditorSurfaceHandle,
} from "./editorAdapter";
import type { MarkdownCompatibilityParser } from "./editorGateway";
import { assessVisualEditingCompatibility } from "./markdownCompatibility";
import { remarkMarkdownCompatibilityParser } from "./remarkMarkdownParser";
import { EditorToolbar } from "./EditorToolbar";
import { countDocumentWords } from "./documentMetrics";
import type { EditorAssetGateway } from "./editorGateway";
import {
  prepareFileAssetImport,
  prepareSelectedAssetImport,
  type PreparedAssetImport,
} from "./assets/assetImport";
import { AssetDirectoryDialog } from "./assets/AssetDirectoryDialog";
import { detectAssetImageKind, mediaTypeForKind } from "./assets/assetImport";
import { markdownImageSourceToWorkspacePath } from "./assets/workspaceAssetPath";
import type {
  PreparedImageRelocation,
  ResolvedWorkspaceImage,
} from "./adapters/milkdown/workspaceImageNodeView";
import "./DocumentEditorShell.css";

const LazySourceMarkdownEditor = lazy(async () => {
  const module = await import(
    "./adapters/codemirror/SourceMarkdownEditor"
  );
  return { default: module.SourceMarkdownEditor };
});
const LazyVisualMarkdownEditor = lazy(async () => {
  const module = await import(
    "./adapters/milkdown/VisualMarkdownEditor"
  );
  return { default: module.VisualMarkdownEditor };
});

export interface DocumentEditorMetrics {
  characterCount: number;
  wordCount: number;
  selection: EditorSelection;
}

export interface DocumentEditorShellHandle {
  commitProjection(): ReadyDocumentSession;
  execute(command: EditorCommand): void;
  focus(): void;
  switchMode(mode: EditorMode): void;
}

export interface DocumentEditorRuntimeState {
  busy: boolean;
}

export interface DocumentEditorShellProps {
  assetGateway?: EditorAssetGateway;
  session: ReadyDocumentSession;
  parser?: MarkdownCompatibilityParser;
  onMetricsChange?(metrics: DocumentEditorMetrics): void;
  onAdapterLifecycle?(event: EditorAdapterLifecycleEvent): void;
  onRuntimeStateChange?(state: DocumentEditorRuntimeState): void;
  onResolveConflict?(): void;
  onSave?(): void;
  onSaveCopy?(): void;
  onSessionChange(session: ReadyDocumentSession): void;
}

export const DocumentEditorShell = forwardRef<
  DocumentEditorShellHandle,
  DocumentEditorShellProps
>(function DocumentEditorShell(
  {
    assetGateway,
    session,
    parser = remarkMarkdownCompatibilityParser,
    onMetricsChange,
    onAdapterLifecycle,
    onRuntimeStateChange,
    onResolveConflict,
    onSave,
    onSaveCopy,
    onSessionChange,
  },
  ref,
) {
  const sessionRef = useRef(session);
  const editorRef = useRef<EditorSurfaceHandle | null>(null);
  const pendingFindRef = useRef(false);
  const switchSequenceRef = useRef(0);
  const switchInFlightRef = useRef(false);
  const assetImportInFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [adapterError, setAdapterError] = useState("");
  const [assetDirectoryOpen, setAssetDirectoryOpen] = useState(false);
  sessionRef.current = session;

  useEffect(
    () => () => {
      switchSequenceRef.current += 1;
      switchInFlightRef.current = false;
    },
    [],
  );

  const readOnly = session.saveState.kind === "readonly";
  const editorDocument = useMemo(
    () => ({
      generation: session.generation,
      editVersion: session.editVersion,
      markdown: session.markdown,
      selection: session.selection,
      anchor: session.anchor,
    }),
    [
      session.anchor,
      session.editVersion,
      session.generation,
      session.markdown,
      session.selection,
    ],
  );
  const sourceOnlyReason =
    session.compatibility.mode === "source-only"
      ? compatibilityMessage(session.compatibility.reasons)
      : null;

  useEffect(() => {
    onMetricsChange?.({
      characterCount: session.markdown.length,
      wordCount: countDocumentWords(session.markdown),
      selection: session.selection,
    });
  }, [onMetricsChange, session.markdown, session.selection]);

  useEffect(() => {
    onRuntimeStateChange?.({ busy });
  }, [busy, onRuntimeStateChange]);

  useEffect(() => {
    if (session.mode !== "source" || !pendingFindRef.current) return;
    pendingFindRef.current = false;
    queueMicrotask(() => {
      if (!editorRef.current?.execute({ kind: "find" })) {
        setFeedback("当前文档查找暂时不可用");
      }
    });
  }, [session.mode]);

  const commitResult = useCallback(
    (result: SessionMutationResult): boolean => {
      if (result.status !== "applied") return false;
      sessionRef.current = result.session;
      onSessionChange(result.session);
      return true;
    },
    [onSessionChange],
  );

  const applyAdapterChange = useCallback(
    (mode: EditorMode, change: EditorAdapterChange) => {
      const result = applyDocumentEdit(sessionRef.current, {
        ...change,
        mode,
      });
      if (!commitResult(result) && result.status !== "stale") {
        setFeedback(mutationFeedback(result.status));
      }
    },
    [commitResult],
  );

  const applyHistory = useCallback(
    (direction: "undo" | "redo"): boolean => {
      const current = sessionRef.current;
      const result =
        direction === "undo"
          ? undoDocumentSession(current)
          : redoDocumentSession(current);
      const applied = commitResult(result);
      if (!applied && result.status !== "history_unavailable") {
        setFeedback(mutationFeedback(result.status));
      }
      return applied;
    },
    [commitResult],
  );

  const commitProjection = useCallback(
    (
      current: ReadyDocumentSession,
      targetMode: EditorMode,
    ): ReadyDocumentSession | null => {
      const markdown = editorRef.current?.getMarkdown() ?? current.markdown;
      const projection = projectionForMode(
        targetMode,
        markdown,
        editorRef.current?.getSelection() ?? current.selection,
        editorRef.current?.getAnchor() ?? current.anchor,
      );
      if (
        markdown === current.markdown &&
        targetMode === current.mode &&
        sameSelection(projection.selection, current.selection) &&
        sameAnchor(projection.anchor, current.anchor)
      ) {
        return current;
      }
      const result = applyDocumentEdit(current, {
        generation: current.generation,
        expectedEditVersion: current.editVersion,
        markdown,
        mode: targetMode,
        selection: projection.selection,
        anchor: projection.anchor,
        transactionGroup: null,
      });
      return commitResult(result) ? result.session : null;
    },
    [commitResult],
  );

  const switchMode = useCallback(
    async (targetMode: EditorMode) => {
      const current = sessionRef.current;
      if (switchInFlightRef.current || current.mode === targetMode) {
        if (current.mode === targetMode) editorRef.current?.focus();
        return;
      }
      setFeedback("");
      setAdapterError("");

      if (targetMode === "source") {
        commitProjection(current, "source");
        return;
      }

      const captured = commitProjection(current, current.mode);
      if (!captured) return;
      const sequence = ++switchSequenceRef.current;
      const generation = captured.generation;
      const editVersion = captured.editVersion;
      const markdown = captured.markdown;
      switchInFlightRef.current = true;
      setBusy(true);
      try {
        const evidence = await parser.parse(markdown);
        if (sequence !== switchSequenceRef.current) return;
        const reassessed = reassessDocumentCompatibility(
          sessionRef.current,
          generation,
          editVersion,
          assessVisualEditingCompatibility(evidence),
        );
        if (reassessed.status !== "applied") {
          if (reassessed.status === "stale") {
            setFeedback("文档已发生变化，请再次切换排版模式");
          }
          return;
        }
        if (reassessed.session.compatibility.mode === "source-only") {
          sessionRef.current = reassessed.session;
          onSessionChange(reassessed.session);
          setFeedback(
            compatibilityMessage(reassessed.session.compatibility.reasons),
          );
          return;
        }
        commitProjection(reassessed.session, "visual");
      } catch {
        setFeedback("当前内容无法安全解析，已保留在源码模式");
      } finally {
        if (sequence === switchSequenceRef.current) {
          switchInFlightRef.current = false;
          setBusy(false);
        }
      }
    },
    [commitProjection, onSessionChange, parser],
  );

  const executeCommand = useCallback(
    (command: EditorCommand) => {
      if (command.kind === "history") {
        applyHistory(command.direction);
        return;
      }
      if (command.kind === "find" && sessionRef.current.mode === "visual") {
        pendingFindRef.current = true;
        void switchMode("source");
        return;
      }
      if (!editorRef.current?.execute(command)) {
        setFeedback("当前模式不支持这个操作");
      }
    },
    [applyHistory, switchMode],
  );

  useImperativeHandle(
    ref,
    () => ({
      commitProjection: () =>
        commitProjection(sessionRef.current, sessionRef.current.mode) ??
        sessionRef.current,
      execute: executeCommand,
      focus: () => editorRef.current?.focus(),
      switchMode: (mode) => {
        void switchMode(mode);
      },
    }),
    [commitProjection, executeCommand, switchMode],
  );

  const insertPreparedAsset = useCallback(
    async (
      prepared: PreparedAssetImport,
      target: {
        generation: number;
        editVersion: number;
        selection: EditorSelection;
      },
    ): Promise<boolean> => {
      const current = sessionRef.current;
      const editor = editorRef.current;
      if (
        !assetGateway ||
        !editor ||
        current.saveState.kind === "readonly" ||
        current.generation !== target.generation ||
        current.editVersion !== target.editVersion
      ) {
        await assetGateway
          ?.cancel(current.workspaceId, prepared.proposal.importId)
          .catch(() => false);
        if (
          current.generation !== target.generation ||
          current.editVersion !== target.editVersion
        ) {
          setFeedback(
            "导入期间文档已变化，图片链接未插入，未使用资源已清理。",
          );
        }
        return false;
      }
      editor.setSelection(target.selection);
      const inserted = editor.execute({
        kind: "insert_image",
        src: prepared.markdownSource,
        alt: prepared.proposal.fileName.replace(/\.[^.]+$/, ""),
      });
      if (!inserted) {
        await assetGateway
          .cancel(current.workspaceId, prepared.proposal.importId)
          .catch(() => false);
        setFeedback("当前选择无法插入图片，已清理未使用的资源文件。");
        return false;
      }
      const insertedSession = sessionRef.current;
      try {
        await assetGateway.confirm(
          current.workspaceId,
          prepared.proposal.importId,
        );
        return true;
      } catch {
        const latest = sessionRef.current;
        const canUndoOnlyInsertedImage =
          insertedSession.generation === current.generation &&
          insertedSession.editVersion === current.editVersion + 1 &&
          latest.generation === insertedSession.generation &&
          latest.editVersion === insertedSession.editVersion;
        if (canUndoOnlyInsertedImage) applyHistory("undo");
        await assetGateway
          .cancel(current.workspaceId, prepared.proposal.importId)
          .catch(() => false);
        setFeedback(
          canUndoOnlyInsertedImage
            ? "图片确认失败，链接已回退；未确认资源不会被误删。"
            : "图片确认失败；文档随后已变化，未自动撤销后续内容，请检查该图片链接。",
        );
        return false;
      }
    },
    [applyHistory, assetGateway],
  );

  const insertFiles = useCallback(
    async (files: readonly File[], initialSelection?: EditorSelection) => {
      const current = sessionRef.current;
      if (
        !assetGateway ||
        current.saveState.kind === "readonly" ||
        files.length === 0 ||
        switchInFlightRef.current ||
        assetImportInFlightRef.current
      ) {
        if (current.saveState.kind === "readonly") {
          setFeedback("当前文档只读，图片没有写入工作区。");
        }
        return;
      }
      assetImportInFlightRef.current = true;
      setBusy(true);
      try {
        let inserted = 0;
        let failed = 0;
        let targetSelection =
          initialSelection ??
          editorRef.current?.getSelection() ??
          current.selection;
        for (const file of files) {
          const targetSession = sessionRef.current;
          try {
            const prepared = await prepareFileAssetImport(
              assetGateway,
              targetSession.workspaceId,
              targetSession.relativePath,
              file,
            );
            if (
              await insertPreparedAsset(prepared, {
                generation: targetSession.generation,
                editVersion: targetSession.editVersion,
                selection: targetSelection,
              })
            ) {
              inserted += 1;
              targetSelection =
                editorRef.current?.getSelection() ??
                sessionRef.current.selection;
            } else failed += 1;
          } catch {
            failed += 1;
          }
        }
        setFeedback(
          failed === 0
            ? `已插入 ${inserted} 张图片。`
            : `已插入 ${inserted} 张图片，${failed} 张未完成；失败项没有写入链接。`,
        );
      } finally {
        assetImportInFlightRef.current = false;
        setBusy(false);
      }
    },
    [assetGateway, insertPreparedAsset],
  );

  const selectAndInsertImage = useCallback(async () => {
    const current = sessionRef.current;
    if (
      !assetGateway ||
      current.saveState.kind === "readonly" ||
      busy ||
      switchInFlightRef.current ||
      assetImportInFlightRef.current
    ) {
      return;
    }
    assetImportInFlightRef.current = true;
    setBusy(true);
    setFeedback("");
    const target = {
      generation: current.generation,
      editVersion: current.editVersion,
      selection: editorRef.current?.getSelection() ?? current.selection,
    };
    try {
      const prepared = await prepareSelectedAssetImport(
        assetGateway,
        current.workspaceId,
        current.relativePath,
      );
      if (prepared) {
        const inserted = await insertPreparedAsset(prepared, target);
        if (inserted) setFeedback("图片已写入资源目录并插入当前文档。");
      }
    } catch {
      setFeedback("图片导入没有完成；正文未插入失败资源的链接。");
    } finally {
      assetImportInFlightRef.current = false;
      setBusy(false);
    }
  }, [assetGateway, busy, insertPreparedAsset]);

  const resolveWorkspaceImage = useCallback(
    async (source: string): Promise<ResolvedWorkspaceImage | null> => {
      const current = sessionRef.current;
      if (!assetGateway) return null;
      const path = markdownImageSourceToWorkspacePath(
        current.relativePath,
        source,
      );
      if (!path) return null;
      const response = await assetGateway.read(current.workspaceId, path);
      const bytes =
        response instanceof Uint8Array ? response : new Uint8Array(response);
      const kind = detectAssetImageKind(bytes);
      const url = URL.createObjectURL(
        new Blob([Uint8Array.from(bytes).buffer], {
          type: mediaTypeForKind(kind),
        }),
      );
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    [assetGateway],
  );

  const relocateWorkspaceImage = useCallback(
    async (): Promise<PreparedImageRelocation | null> => {
      const current = sessionRef.current;
      if (!assetGateway || current.saveState.kind === "readonly") return null;
      const prepared = await prepareSelectedAssetImport(
        assetGateway,
        current.workspaceId,
        current.relativePath,
      );
      if (!prepared) return null;
      return {
        source: prepared.markdownSource,
        confirm: async () => {
          await assetGateway.confirm(
            current.workspaceId,
            prepared.proposal.importId,
          );
        },
        cancel: async () => {
          await assetGateway.cancel(
            current.workspaceId,
            prepared.proposal.importId,
          );
        },
      };
    },
    [assetGateway],
  );

  function handleUnavailable(reason: { message: string }) {
    setAdapterError(reason.message);
    if (sessionRef.current.mode === "visual") {
      commitProjection(sessionRef.current, "source");
      setFeedback(`${reason.message} 已保留内容并切换到源码模式。`);
    }
  }

  function handleSelectionChange(selection: EditorSelection) {
    onMetricsChange?.({
      characterCount: sessionRef.current.markdown.length,
      wordCount: countDocumentWords(sessionRef.current.markdown),
      selection,
    });
  }

  return (
    <div className="document-editor-shell" data-mode={session.mode}>
      <EditorToolbar
        busy={busy}
        canRedo={session.history.future.length > 0}
        canUndo={session.history.past.length > 0}
        mode={session.mode}
        onCommand={executeCommand}
        onModeChange={(mode) => void switchMode(mode)}
        onResolveConflict={onResolveConflict}
        onSave={onSave}
        onSaveCopy={onSaveCopy}
        onAssetSettings={
          assetGateway ? () => setAssetDirectoryOpen(true) : undefined
        }
        onInsertImage={
          assetGateway ? () => void selectAndInsertImage() : undefined
        }
        saveState={session.saveState}
        sourceOnlyReason={sourceOnlyReason}
      />
      {sourceOnlyReason || feedback || adapterError ? (
        <div
          aria-live={adapterError ? "assertive" : "polite"}
          className="document-editor-shell__notice"
          data-error={adapterError || undefined}
        >
          {adapterError || feedback || sourceOnlyReason}
        </div>
      ) : null}
      <div
        className="document-editor-shell__surface"
        data-editor-scroll-owner
        data-mode={session.mode}
        onDragOver={(event) => {
          if (
            !readOnly &&
            !busy &&
            !assetImportInFlightRef.current &&
            Array.from(event.dataTransfer.items).some(
              (item) =>
                item.kind === "file" &&
                (item.type.startsWith("image/") || item.type === ""),
            )
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files).filter(
            (file) => file.type.startsWith("image/") || !file.type,
          );
          if (busy || assetImportInFlightRef.current || files.length === 0) {
            return;
          }
          event.preventDefault();
          editorRef.current?.setSelectionAtCoordinates(
            event.clientX,
            event.clientY,
          );
          void insertFiles(files, editorRef.current?.getSelection());
        }}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.files).filter(
            (file) => file.type.startsWith("image/") || !file.type,
          );
          if (busy || assetImportInFlightRef.current || files.length === 0) {
            return;
          }
          event.preventDefault();
          void insertFiles(files, editorRef.current?.getSelection());
        }}
      >
        {session.markdown.length === 0 ? (
          <p className="document-editor-shell__placeholder">
            开始输入 Markdown
          </p>
        ) : null}
        <Suspense
          fallback={
            <AsyncStatePanel
              compact
              description="文档内容保持在统一会话中。"
              state="loading"
              title={`正在准备${session.mode === "visual" ? "排版" : "源码"}编辑器`}
            />
          }
        >
          {session.mode === "visual" ? (
            <LazyVisualMarkdownEditor
              document={editorDocument}
              onAdapterLifecycle={onAdapterLifecycle}
              onChange={(change) => applyAdapterChange("visual", change)}
              onHistoryCommand={applyHistory}
              onSelectionChange={handleSelectionChange}
              onUnavailable={handleUnavailable}
              onRelocateImage={relocateWorkspaceImage}
              onResolveImage={resolveWorkspaceImage}
              readOnly={readOnly}
              ref={(handle: VisualMarkdownEditorHandle | null) => {
                editorRef.current = handle;
              }}
            />
          ) : (
            <LazySourceMarkdownEditor
              document={editorDocument}
              onAdapterLifecycle={onAdapterLifecycle}
              onChange={(change) => applyAdapterChange("source", change)}
              onHistoryCommand={applyHistory}
              onSelectionChange={handleSelectionChange}
              onUnavailable={handleUnavailable}
              readOnly={readOnly}
              ref={(handle: SourceMarkdownEditorHandle | null) => {
                editorRef.current = handle;
              }}
            />
          )}
        </Suspense>
      </div>
      {assetGateway ? (
        <AssetDirectoryDialog
          gateway={assetGateway}
          onRequestClose={() => setAssetDirectoryOpen(false)}
          open={assetDirectoryOpen}
          workspaceId={session.workspaceId}
        />
      ) : null}
    </div>
  );
});

function projectionForMode(
  mode: EditorMode,
  markdown: string,
  currentSelection: EditorSelection,
  currentAnchor: DocumentAnchor,
): { selection: EditorSelection; anchor: DocumentAnchor } {
  const selectionStart =
    currentSelection.kind === "visual"
      ? currentSelection.from
      : currentSelection.anchor;
  const selectionEnd =
    currentSelection.kind === "visual"
      ? currentSelection.to
      : currentSelection.head;
  const offset = clamp(selectionEnd, 0, markdown.length);
  const scrollTop = Math.max(0, currentAnchor.scrollTop);
  if (mode === "source") {
    return {
      selection: {
        kind: "source",
        anchor: clamp(selectionStart, 0, markdown.length),
        head: offset,
      },
      anchor: { kind: "source", offset, scrollTop },
    };
  }
  return {
    selection: {
      kind: "visual",
      from: clamp(Math.min(selectionStart, selectionEnd), 0, markdown.length),
      to: clamp(Math.max(selectionStart, selectionEnd), 0, markdown.length),
    },
    anchor: {
      kind: "semantic",
      blockId:
        currentAnchor.kind === "semantic" ? currentAnchor.blockId : null,
      fallbackOffset: offset,
      scrollTop,
    },
  };
}

function compatibilityMessage(reasons: readonly string[]): string {
  if (reasons.includes("parse-error")) {
    return "排版解析失败；源码内容仍完整，可继续在源码模式编辑。";
  }
  if (reasons.includes("mixed-line-endings")) {
    return "文档混用了多种换行符；规范化换行后可再次尝试排版模式。";
  }
  if (reasons.includes("visual-document-too-large")) {
    return "文档超过排版模式的安全上限，已使用源码模式避免页面卡顿。";
  }
  if (reasons.includes("visual-document-too-complex")) {
    return "文档结构过密，已使用源码模式避免页面卡顿。";
  }
  return "当前文档包含排版模式无法无损映射的语法，请在源码模式编辑。";
}

function mutationFeedback(status: SessionMutationResult["status"]): string {
  if (status === "readonly") return "当前文档只读，内容没有被修改。";
  if (status === "mode_unavailable") return "当前内容只能在源码模式安全编辑。";
  if (status === "save_in_flight") return "正在提交磁盘版本，请稍后重试。";
  if (status === "history_unavailable") return "没有可用的撤销或重做记录。";
  return "文档状态已变化，本次操作没有应用。";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sameSelection(left: EditorSelection, right: EditorSelection): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "visual" && right.kind === "visual"
    ? left.from === right.from && left.to === right.to
    : left.kind === "source" &&
        right.kind === "source" &&
        left.anchor === right.anchor &&
        left.head === right.head;
}

function sameAnchor(left: DocumentAnchor, right: DocumentAnchor): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "semantic" && right.kind === "semantic"
    ? left.blockId === right.blockId &&
        left.fallbackOffset === right.fallbackOffset &&
        left.scrollTop === right.scrollTop
    : left.kind === "source" &&
        right.kind === "source" &&
        left.offset === right.offset &&
        left.scrollTop === right.scrollTop;
}
