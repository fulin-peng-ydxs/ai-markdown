import { performance } from "node:perf_hooks";

import {
  createDocumentHistory,
  recordDocumentChange,
  undoDocumentHistory,
} from "../src/features/editor/documentHistory.ts";

const sizeBytes = 64 * 1024 * 1024;
const before = "a".repeat(sizeBytes);
const after = `${before}b`;
const selection = { kind: "source", anchor: before.length, head: before.length };

const recordStartedAt = performance.now();
const history = recordDocumentChange(createDocumentHistory(), {
  beforeMarkdown: before,
  afterMarkdown: after,
  beforeSelection: selection,
  afterSelection: { kind: "source", anchor: after.length, head: after.length },
  beforeMode: "source",
  afterMode: "source",
  transactionGroup: "large-document-typing",
});
const recordDurationMs = performance.now() - recordStartedAt;

const undoStartedAt = performance.now();
const undo = undoDocumentHistory(history, after);
const undoDurationMs = performance.now() - undoStartedAt;

if (history.bytes !== 1 || undo.status !== "applied" || undo.markdown !== before) {
  throw new Error("64 MiB history performance probe failed its correctness checks");
}

process.stdout.write(
  `${JSON.stringify(
    {
      documentBytes: sizeBytes,
      patchBytes: history.bytes,
      recordDurationMs: Number(recordDurationMs.toFixed(2)),
      undoDurationMs: Number(undoDurationMs.toFixed(2)),
      note: "Single local run; latency is machine-specific and not a product threshold.",
    },
    null,
    2,
  )}\n`,
);
