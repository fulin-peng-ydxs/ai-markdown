import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const MIB = 1024 * 1024;
const sizes = [100 * 1024, 5 * MIB, 20 * MIB, 64 * MIB];
const sourceChunk = "# Plainroot performance\n\nLocal-first Markdown benchmark paragraph.\n\n";

function durationMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function makeMarkdown(byteLength) {
  const repeats = Math.ceil(byteLength / Buffer.byteLength(sourceChunk));
  return sourceChunk.repeat(repeats).slice(0, byteLength);
}

function measureDocument(byteLength) {
  const markdown = makeMarkdown(byteLength);

  const serializationStart = process.hrtime.bigint();
  const serialized = JSON.stringify({ markdown });
  const serializationMs = durationMs(serializationStart);

  const hashStart = process.hrtime.bigint();
  const digest = createHash("sha256").update(markdown).digest("hex");
  const hashMs = durationMs(hashStart);

  if (Buffer.byteLength(markdown) !== byteLength || digest.length !== 64) {
    throw new Error(`Document probe failed at ${byteLength} bytes.`);
  }

  return {
    byteLength,
    serializationMs: Number(serializationMs.toFixed(2)),
    serializedByteLength: Buffer.byteLength(serialized),
    sha256Ms: Number(hashMs.toFixed(2)),
  };
}

async function measureEditorBundle() {
  const entry = fileURLToPath(
    new URL("../src/features/editor/poc/editorBundleProbe.ts", import.meta.url),
  );
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      minify: "esbuild",
      write: false,
      rollupOptions: {
        external: ["react", "react-dom", "react/jsx-runtime"],
        input: entry,
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const chunks = outputs.filter((output) => output.type === "chunk");
  const code = chunks.map((chunk) => chunk.code).join("\n");

  return {
    rawBytes: Buffer.byteLength(code),
    gzipBytes: gzipSync(code).byteLength,
    chunks: chunks.map((chunk) => chunk.fileName),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  documents: sizes.map(measureDocument),
  editorBundleExcludingReact: await measureEditorBundle(),
  memoryAfterProbeMiB: Number((process.memoryUsage().rss / MIB).toFixed(1)),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
