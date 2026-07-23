export const MAX_INTERACTIVE_VISUAL_BYTES = 2 * 1024 * 1024;
export const MAX_INTERACTIVE_VISUAL_BLOCKS = 2_000;

export type VisualEditorEligibility =
  | { eligible: true; byteLength: number }
  | {
      eligible: false;
      byteLength: number;
      blockCount?: number;
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

  const blockCount = estimateMarkdownBlockCount(markdown);
  if (blockCount > MAX_INTERACTIVE_VISUAL_BLOCKS) {
    return {
      eligible: false,
      byteLength,
      blockCount,
      reason: "document_too_complex",
      message: "文档包含过多独立内容块。为避免输入卡顿，请使用源码模式编辑。",
    };
  }

  return { eligible: true, byteLength };
}

export function estimateMarkdownBlockCount(markdown: string): number {
  if (!markdown.trim()) return 0;
  let blocks = 1;
  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (markdown[index] === "\n" && markdown[index + 1] === "\n") {
      blocks += 1;
      index += 1;
    }
  }
  return blocks;
}

/**
 * Counts UTF-8 bytes without allocating a second full-size byte buffer. This matters
 * for the 64 MiB file boundary, where eligibility must be decided before Milkdown mounts.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
