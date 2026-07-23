import type { ChangeSet } from "@codemirror/state";

export interface SourceTextProjection {
  editorText: string;
  preferredLineSeparator: "\n" | "\r\n" | "\r";
}

/**
 * CodeMirror stores line breaks separately from text and serializes them with a
 * single separator. Keep that normalized representation inside the editor, but
 * retain the raw Markdown outside it so CRLF, CR and mixed files are not
 * silently normalized.
 */
export function projectSourceText(rawMarkdown: string): SourceTextProjection {
  return {
    editorText: rawMarkdown.replace(/\r\n?|\n/g, "\n"),
    preferredLineSeparator: firstLineSeparator(rawMarkdown) ?? "\n",
  };
}

export function rawOffsetToEditorOffset(
  rawMarkdown: string,
  rawOffset: number,
): number {
  const target = clamp(rawOffset, 0, rawMarkdown.length);
  let rawIndex = 0;
  let editorOffset = 0;
  while (rawIndex < target) {
    if (
      rawMarkdown.charCodeAt(rawIndex) === 0x0d &&
      rawMarkdown.charCodeAt(rawIndex + 1) === 0x0a
    ) {
      if (rawIndex + 2 > target) break;
      rawIndex += 2;
    } else {
      rawIndex += 1;
    }
    editorOffset += 1;
  }
  return editorOffset;
}

export function editorOffsetToRawOffset(
  rawMarkdown: string,
  editorOffset: number,
): number {
  const target = Math.max(0, editorOffset);
  let rawIndex = 0;
  let normalizedIndex = 0;
  while (normalizedIndex < target && rawIndex < rawMarkdown.length) {
    if (
      rawMarkdown.charCodeAt(rawIndex) === 0x0d &&
      rawMarkdown.charCodeAt(rawIndex + 1) === 0x0a
    ) {
      rawIndex += 2;
    } else {
      rawIndex += 1;
    }
    normalizedIndex += 1;
  }
  return rawIndex;
}

export function applyEditorChangesToRawMarkdown(
  rawMarkdown: string,
  changes: ChangeSet,
  preferredLineSeparator: SourceTextProjection["preferredLineSeparator"],
): string {
  const replacements: Array<{
    rawFrom: number;
    rawTo: number;
    inserted: string;
  }> = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    replacements.push({
      rawFrom: editorOffsetToRawOffset(rawMarkdown, fromA),
      rawTo: editorOffsetToRawOffset(rawMarkdown, toA),
      inserted: inserted.toString().replace(/\n/g, preferredLineSeparator),
    });
  });

  let next = rawMarkdown;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    next =
      next.slice(0, replacement.rawFrom) +
      replacement.inserted +
      next.slice(replacement.rawTo);
  }
  return next;
}

function firstLineSeparator(
  markdown: string,
): SourceTextProjection["preferredLineSeparator"] | null {
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) === 0x0d) {
      return markdown.charCodeAt(index + 1) === 0x0a ? "\r\n" : "\r";
    }
    if (markdown.charCodeAt(index) === 0x0a) return "\n";
  }
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
