import type { EditorCommand, EditorMode } from "./editorAdapter";
import type { DocumentSaveState } from "./documentSession";
import { SaveStatus } from "./SaveStatus";

export interface EditorToolbarProps {
  busy: boolean;
  canRedo: boolean;
  canUndo: boolean;
  mode: EditorMode;
  saveState: DocumentSaveState;
  sourceOnlyReason: string | null;
  onResolveConflict?(): void;
  onSave?(): void;
  onSaveCopy?(): void;
  onCommand(command: EditorCommand): void;
  onModeChange(mode: EditorMode): void;
}

export function EditorToolbar({
  busy,
  canRedo,
  canUndo,
  mode,
  saveState,
  sourceOnlyReason,
  onResolveConflict,
  onSave,
  onSaveCopy,
  onCommand,
  onModeChange,
}: EditorToolbarProps) {
  const readonly = saveState.kind === "readonly";
  const visualCommandsDisabled = readonly || busy || mode !== "visual";
  return (
    <div className="document-editor-toolbar" role="toolbar" aria-label="文档编辑工具">
      <div className="document-editor-toolbar__modes" aria-label="编辑模式">
        <button
          aria-pressed={mode === "visual"}
          disabled={busy}
          onClick={() => onModeChange("visual")}
          title={
            sourceOnlyReason
              ? `${sourceOnlyReason} 重新检查当前内容`
              : "切换到排版模式"
          }
          type="button"
        >
          排版
        </button>
        <button
          aria-pressed={mode === "source"}
          disabled={busy}
          onClick={() => onModeChange("source")}
          title="切换到 Markdown 源码模式"
          type="button"
        >
          源码
        </button>
      </div>

      <span aria-hidden="true" className="document-editor-toolbar__divider" />

      <div className="document-editor-toolbar__group" aria-label="历史">
        <ToolbarButton
          disabled={readonly || busy || !canUndo}
          label="撤销"
          onClick={() => onCommand({ kind: "history", direction: "undo" })}
        >
          ↶
        </ToolbarButton>
        <ToolbarButton
          disabled={readonly || busy || !canRedo}
          label="重做"
          onClick={() => onCommand({ kind: "history", direction: "redo" })}
        >
          ↷
        </ToolbarButton>
      </div>

      <span aria-hidden="true" className="document-editor-toolbar__divider" />

      <div className="document-editor-toolbar__group" aria-label="排版格式">
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="一级标题"
          onClick={() => onCommand({ kind: "heading", level: 1 })}
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="二级标题"
          onClick={() => onCommand({ kind: "heading", level: 2 })}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="加粗"
          onClick={() => onCommand({ kind: "format", format: "bold" })}
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="斜体"
          onClick={() => onCommand({ kind: "format", format: "italic" })}
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="引用"
          onClick={() => onCommand({ kind: "block", block: "quote" })}
        >
          “
        </ToolbarButton>
        <ToolbarButton
          disabled={visualCommandsDisabled}
          label="无序列表"
          onClick={() => onCommand({ kind: "block", block: "bullet_list" })}
        >
          •
        </ToolbarButton>
      </div>

      <span aria-hidden="true" className="document-editor-toolbar__divider" />

      {saveState.kind === "conflict" && onResolveConflict ? (
        <ToolbarButton
          disabled={busy}
          label="处理磁盘冲突"
          onClick={onResolveConflict}
        >
          处理冲突
        </ToolbarButton>
      ) : onSave ? (
        <ToolbarButton
          disabled={readonly || busy || saveState.kind === "saving"}
          label="保存当前文档"
          onClick={onSave}
        >
          保存
        </ToolbarButton>
      ) : null}

      {onSaveCopy ? (
        <ToolbarButton
          disabled={busy || saveState.kind === "saving"}
          label="另存当前内容副本"
          onClick={onSaveCopy}
        >
          另存副本
        </ToolbarButton>
      ) : null}

      <ToolbarButton
        disabled={busy}
        label={mode === "source" ? "在当前文档中查找" : "切换源码并查找"}
        onClick={() => onCommand({ kind: "find" })}
      >
        查找
      </ToolbarButton>

      <SaveStatus state={saveState} />
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
