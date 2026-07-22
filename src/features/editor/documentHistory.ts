import type {
  EditorMode,
  EditorSelection,
} from "./editorAdapter";

export const DEFAULT_DOCUMENT_HISTORY_BUDGET_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DOCUMENT_HISTORY_ENTRY_LIMIT = 500;

export interface ReversibleTextPatch {
  start: number;
  removed: string;
  inserted: string;
}

interface HistoryStep {
  forward: ReversibleTextPatch;
  inverse: ReversibleTextPatch;
}

export interface DocumentHistoryEntry {
  transactionGroup: string | null;
  beforeHash: string;
  afterHash: string;
  beforeSelection: EditorSelection;
  afterSelection: EditorSelection;
  beforeMode: EditorMode;
  afterMode: EditorMode;
  steps: HistoryStep[];
  bytes: number;
}

export interface DocumentHistory {
  past: DocumentHistoryEntry[];
  future: DocumentHistoryEntry[];
  bytes: number;
  maxBytes: number;
  maxEntries: number;
  truncated: boolean;
}

export interface RecordHistoryChange {
  beforeMarkdown: string;
  afterMarkdown: string;
  beforeSelection: EditorSelection;
  afterSelection: EditorSelection;
  beforeMode: EditorMode;
  afterMode: EditorMode;
  transactionGroup: string | null;
}

export type HistoryApplyResult =
  | {
      status: "applied";
      history: DocumentHistory;
      markdown: string;
      selection: EditorSelection;
      mode: EditorMode;
    }
  | {
      status: "unavailable";
      history: DocumentHistory;
      reason: "empty" | "content_mismatch";
    };

const textEncoder = new TextEncoder();

export function createDocumentHistory(
  options: {
    maxBytes?: number;
    maxEntries?: number;
  } = {},
): DocumentHistory {
  const maxBytes = options.maxBytes ?? DEFAULT_DOCUMENT_HISTORY_BUDGET_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_DOCUMENT_HISTORY_ENTRY_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Document history maxBytes must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError("Document history maxEntries must be a non-negative integer");
  }
  return {
    past: [],
    future: [],
    bytes: 0,
    maxBytes,
    maxEntries,
    truncated: false,
  };
}

export function createReversibleTextPatch(
  before: string,
  after: string,
): ReversibleTextPatch {
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;
  prefix = avoidSplittingSurrogatePair(before, prefix);
  prefix = avoidSplittingSurrogatePair(after, prefix);

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  beforeEnd = avoidSplittingSurrogatePair(before, beforeEnd);
  afterEnd = avoidSplittingSurrogatePair(after, afterEnd);

  return {
    start: prefix,
    removed: before.slice(prefix, beforeEnd),
    inserted: after.slice(prefix, afterEnd),
  };
}

export function invertTextPatch(patch: ReversibleTextPatch): ReversibleTextPatch {
  return {
    start: patch.start,
    removed: patch.inserted,
    inserted: patch.removed,
  };
}

export function applyTextPatch(
  markdown: string,
  patch: ReversibleTextPatch,
): string | null {
  const actual = markdown.slice(patch.start, patch.start + patch.removed.length);
  if (actual !== patch.removed) return null;
  return `${markdown.slice(0, patch.start)}${patch.inserted}${markdown.slice(
    patch.start + patch.removed.length,
  )}`;
}

export function hashMarkdown(markdown: string): string {
  // This hash only guards in-memory history ordering; disk conflict security still
  // relies on Rust's SHA-256 FileRevision.contentHash.
  let hash = 0x811c9dc5;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${markdown.length}`;
}

export function recordDocumentChange(
  history: DocumentHistory,
  change: RecordHistoryChange,
): DocumentHistory {
  if (change.beforeMarkdown === change.afterMarkdown) return history;

  const forward = createReversibleTextPatch(
    change.beforeMarkdown,
    change.afterMarkdown,
  );
  const step: HistoryStep = { forward, inverse: invertTextPatch(forward) };
  const stepBytes = patchBytes(step);
  const previous = history.past.at(-1);
  const canMerge =
    change.transactionGroup !== null &&
    previous?.transactionGroup === change.transactionGroup &&
    previous.afterHash === hashMarkdown(change.beforeMarkdown);

  let past: DocumentHistoryEntry[];
  let bytes: number;
  if (canMerge && previous) {
    const merged: DocumentHistoryEntry = {
      ...previous,
      afterHash: hashMarkdown(change.afterMarkdown),
      afterSelection: change.afterSelection,
      afterMode: change.afterMode,
      steps: [...previous.steps, step],
      bytes: previous.bytes + stepBytes,
    };
    past = [...history.past.slice(0, -1), merged];
    bytes = history.bytes + stepBytes;
  } else {
    const entry: DocumentHistoryEntry = {
      transactionGroup: change.transactionGroup,
      beforeHash: hashMarkdown(change.beforeMarkdown),
      afterHash: hashMarkdown(change.afterMarkdown),
      beforeSelection: change.beforeSelection,
      afterSelection: change.afterSelection,
      beforeMode: change.beforeMode,
      afterMode: change.afterMode,
      steps: [step],
      bytes: stepBytes,
    };
    past = [...history.past, entry];
    bytes = history.bytes + stepBytes;
  }

  let truncated = history.truncated;
  while (
    past.length > 0 &&
    (past.length > history.maxEntries || bytes > history.maxBytes)
  ) {
    const removed = past[0];
    if (!removed) break;
    past = past.slice(1);
    bytes -= removed.bytes;
    truncated = true;
  }

  return {
    ...history,
    past,
    future: [],
    bytes,
    truncated,
  };
}

export function undoDocumentHistory(
  history: DocumentHistory,
  markdown: string,
): HistoryApplyResult {
  const entry = history.past.at(-1);
  if (!entry) return { status: "unavailable", history, reason: "empty" };
  if (hashMarkdown(markdown) !== entry.afterHash) {
    return { status: "unavailable", history, reason: "content_mismatch" };
  }
  const restored = applySteps(
    markdown,
    [...entry.steps].reverse().map((step) => step.inverse),
  );
  if (restored === null || hashMarkdown(restored) !== entry.beforeHash) {
    return { status: "unavailable", history, reason: "content_mismatch" };
  }
  return {
    status: "applied",
    markdown: restored,
    selection: entry.beforeSelection,
    mode: entry.beforeMode,
    history: {
      ...history,
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
      bytes: history.bytes - entry.bytes,
    },
  };
}

export function redoDocumentHistory(
  history: DocumentHistory,
  markdown: string,
): HistoryApplyResult {
  const entry = history.future[0];
  if (!entry) return { status: "unavailable", history, reason: "empty" };
  if (hashMarkdown(markdown) !== entry.beforeHash) {
    return { status: "unavailable", history, reason: "content_mismatch" };
  }
  const restored = applySteps(
    markdown,
    entry.steps.map((step) => step.forward),
  );
  if (restored === null || hashMarkdown(restored) !== entry.afterHash) {
    return { status: "unavailable", history, reason: "content_mismatch" };
  }
  return {
    status: "applied",
    markdown: restored,
    selection: entry.afterSelection,
    mode: entry.afterMode,
    history: {
      ...history,
      past: [...history.past, entry],
      future: history.future.slice(1),
      bytes: history.bytes + entry.bytes,
    },
  };
}

function applySteps(
  markdown: string,
  patches: ReversibleTextPatch[],
): string | null {
  let next = markdown;
  for (const patch of patches) {
    const applied = applyTextPatch(next, patch);
    if (applied === null) return null;
    next = applied;
  }
  return next;
}

function patchBytes(step: HistoryStep): number {
  return (
    textEncoder.encode(step.forward.removed).byteLength +
    textEncoder.encode(step.forward.inserted).byteLength
  );
}

function avoidSplittingSurrogatePair(value: string, index: number): number {
  if (
    index > 0 &&
    index < value.length &&
    isHighSurrogate(value.charCodeAt(index - 1)) &&
    isLowSurrogate(value.charCodeAt(index))
  ) {
    return index - 1;
  }
  return index;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
