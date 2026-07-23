import type { DocumentSaveState } from "./documentSession";

export interface SaveStatusProps {
  state: DocumentSaveState;
}

export function SaveStatus({ state }: SaveStatusProps) {
  const copy = saveStatusCopy(state);
  return (
    <span
      aria-label={`保存状态：${copy}`}
      className="document-save-status"
      data-state={state.kind}
      title={copy}
    >
      <span aria-hidden="true" className="document-save-status__dot" />
      {copy}
    </span>
  );
}

function saveStatusCopy(state: DocumentSaveState): string {
  switch (state.kind) {
    case "clean":
      return "磁盘版本";
    case "dirty":
      return "未保存";
    case "saving":
      return state.changedAfterStart ? "保存中 · 有新修改" : "保存中";
    case "saved":
      return "已保存";
    case "save_failed":
      return "保存失败";
    case "readonly":
      return "只读";
    case "conflict":
      return "存在磁盘冲突";
  }
}
