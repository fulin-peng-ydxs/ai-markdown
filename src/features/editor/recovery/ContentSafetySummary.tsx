import type {
  DocumentContentSafety,
  DocumentSaveState,
} from "../documentSession";

export function ContentSafetySummary({
  contentSafety,
  saveState,
}: {
  contentSafety: DocumentContentSafety;
  saveState: DocumentSaveState;
}) {
  const safety = contentSafetyCopy(contentSafety);
  return (
    <dl className="editor-safety-summary">
      <div>
        <dt>当前编辑状态</dt>
        <dd>{saveStateCopy(saveState)}</dd>
      </div>
      <div>
        <dt>内容安全位置</dt>
        <dd data-safety={contentSafety.kind}>{safety}</dd>
      </div>
    </dl>
  );
}

export function contentSafetyCopy(safety: DocumentContentSafety): string {
  switch (safety.kind) {
    case "disk":
      return "当前内容已经写入磁盘";
    case "memory":
      return "当前修改仅保留在这个窗口的内存中";
    case "recovery":
      return "当前修改已有本机恢复副本，尚未覆盖原文件";
    case "at_risk":
      return `当前内容需要立即处理：${safety.reason}`;
  }
}

function saveStateCopy(state: DocumentSaveState): string {
  switch (state.kind) {
    case "clean":
      return "与磁盘版本一致";
    case "dirty":
      return "有尚未保存的修改";
    case "saving":
      return "正在写入磁盘";
    case "saved":
      return "最近一次保存已完成";
    case "save_failed":
      return "保存失败，编辑内容仍保留";
    case "readonly":
      return "原文件只读，可另存副本";
    case "conflict":
      return "磁盘版本已变化，需要选择处理方式";
  }
}
