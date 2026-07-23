import { utf8ByteLength } from "../../documentMetrics";

export const MAX_INTERACTIVE_VISUAL_BYTES = 2 * 1024 * 1024;
export const MAX_INTERACTIVE_VISUAL_CONTENT_LINES = 2_000;

export type VisualEditorEligibility =
  | { eligible: true; byteLength: number }
  | {
      eligible: false;
      byteLength: number;
      contentLineCount?: number;
      reason: "document_too_large" | "document_too_complex";
      message: string;
    };

export function visualEditorEligibility(markdown: string): VisualEditorEligibility {
  const byteLength = utf8ByteLength(markdown);
  if (byteLength > MAX_INTERACTIVE_VISUAL_BYTES) {
    return {
      eligible: false,
      byteLength,
      reason: "document_too_large",
      message: "文档超过 2 MiB。为避免长文输入卡顿，请使用源码模式编辑。",
    };
  }

  const contentLineCount = countMarkdownContentLines(markdown);
  if (contentLineCount > MAX_INTERACTIVE_VISUAL_CONTENT_LINES) {
    return {
      eligible: false,
      byteLength,
      contentLineCount,
      reason: "document_too_complex",
      message: "文档包含过多内容行。为避免输入卡顿，请使用源码模式编辑。",
    };
  }

  return { eligible: true, byteLength };
}

/**
 * Counts non-empty physical lines without splitting the document into an array.
 * This deliberately conservative proxy catches dense lists, tables and headings,
 * whose ProseMirror node count is invisible to blank-line block estimates.
 */
export function countMarkdownContentLines(markdown: string): number {
  let contentLines = 0;
  let lineHasContent = false;
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code === 0x0a || code === 0x0d) {
      if (lineHasContent) contentLines += 1;
      lineHasContent = false;
      if (code === 0x0d && markdown.charCodeAt(index + 1) === 0x0a) index += 1;
      continue;
    }
    if (code !== 0x20 && code !== 0x09) lineHasContent = true;
  }
  return contentLines + (lineHasContent ? 1 : 0);
}
