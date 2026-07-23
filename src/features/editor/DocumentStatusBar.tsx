import type { LineEnding, TextEncoding } from "../../services/desktop/contracts";
import type { DocumentEditorMetrics } from "./DocumentEditorShell";
import type { DocumentSessionState, ReadyDocumentSession } from "./documentSession";
import { SaveStatus } from "./SaveStatus";

export interface DocumentStatusBarProps {
  activity: string;
  metrics: DocumentEditorMetrics | null;
  session: DocumentSessionState;
  workspaceWritable: boolean;
}

export function DocumentStatusBar({
  activity,
  metrics,
  session,
  workspaceWritable,
}: DocumentStatusBarProps) {
  return (
    <footer aria-label="文档状态栏" className="workbench__statusbar">
      <span
        aria-live="polite"
        className="workbench__status-activity"
        role="status"
        title={activity}
      >
        {activity}
      </span>
      {session.status === "ready" ? (
        <div className="workbench__document-status">
          <SaveStatus state={session.saveState} />
          <span data-status-priority="primary">
            {session.mode === "visual" ? "排版编辑" : "Markdown 源码"}
          </span>
          <span data-status-priority="secondary">
            {metrics
              ? `${metrics.wordCount} 字/词 · ${metrics.characterCount} 字符`
              : `${session.markdown.length} 字符`}
          </span>
          <span data-status-priority="secondary">
            {formatCopy(session.sourceFormat.encoding, session.sourceFormat.lineEnding)}
          </span>
          <span data-status-priority="primary">
            {cursorCopy(session)}
          </span>
        </div>
      ) : (
        <span data-status-priority="primary">
          {session.status === "empty"
            ? "未打开文档"
            : session.status === "loading"
              ? "正在载入文档"
              : "文档不可编辑"}
        </span>
      )}
      <span data-status-priority="tertiary">
        {workspaceWritable ? "工作区可写" : "工作区只读"}
      </span>
    </footer>
  );
}

function cursorCopy(session: ReadyDocumentSession): string {
  if (session.selection.kind === "visual") {
    return session.selection.from === session.selection.to
      ? "排版光标"
      : "排版选区";
  }
  const offset = Math.min(
    Math.max(session.selection.head, 0),
    session.markdown.length,
  );
  const before = session.markdown.slice(0, offset);
  const lineBreak = Math.max(
    before.lastIndexOf("\n"),
    before.lastIndexOf("\r"),
  );
  const line = (before.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
  const column = offset - lineBreak;
  return `行 ${line}，列 ${column}`;
}

function formatCopy(encoding: TextEncoding, lineEnding: LineEnding): string {
  return `${encodingCopy(encoding)} · ${lineEndingCopy(lineEnding)}`;
}

function encodingCopy(encoding: TextEncoding): string {
  if (encoding === "utf8_bom") return "UTF-8 BOM";
  if (encoding === "utf8") return "UTF-8";
  return "编码不支持";
}

function lineEndingCopy(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
    case "cr":
      return "CR";
    case "mixed":
      return "混合换行";
    case "none":
      return "无换行";
  }
}
