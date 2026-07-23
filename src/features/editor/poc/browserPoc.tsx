import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import commonmarkGfm from "../../../../tests/fixtures/markdown/commonmark-gfm.md?raw";
import "../../../styles/tokens.css";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../documentSession";
import { DocumentEditorShell } from "../DocumentEditorShell";
import type { EditorAdapterDocument } from "../editorAdapter";
import {
  VisualMarkdownEditor,
  type VisualMarkdownEditorHandle,
} from "../adapters/milkdown/VisualMarkdownEditor";
import type { VisualEditorPerformanceSample } from "../adapters/milkdown/MilkdownVisualAdapter";
import {
  SourceMarkdownEditor,
  type SourceMarkdownEditorHandle,
} from "../adapters/codemirror/SourceMarkdownEditor";
import type { SourceEditorPerformanceSample } from "../adapters/codemirror/CodeMirrorSourceAdapter";
import { createCodeMirrorPoc } from "./codeMirrorPoc";
import { MilkdownReactPoc } from "./MilkdownReactPoc";
import "./poc.css";

function BrowserPoc() {
  const codeMirrorRoot = useRef<HTMLDivElement>(null);
  const visualEditorRef = useRef<VisualMarkdownEditorHandle>(null);
  const sourceEditorRef = useRef<SourceMarkdownEditorHandle>(null);
  const [milkdownReadyMs, setMilkdownReadyMs] = useState<number | null>(null);
  const [codeMirrorReadyMs, setCodeMirrorReadyMs] = useState<number | null>(null);
  const [visualDocument, setVisualDocument] = useState<EditorAdapterDocument>({
    generation: 1,
    editVersion: 0,
    markdown: commonmarkGfm,
    selection: { kind: "visual", from: 0, to: 0 },
    anchor: { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 },
  });
  const [visualKey, setVisualKey] = useState(0);
  const [visualSample, setVisualSample] = useState<VisualEditorPerformanceSample | null>(null);
  const [visualUnavailable, setVisualUnavailable] = useState("");
  const [sourceDocument, setSourceDocument] = useState<EditorAdapterDocument>({
    generation: 1,
    editVersion: 0,
    markdown: commonmarkGfm,
    selection: { kind: "source", anchor: 0, head: 0 },
    anchor: { kind: "source", offset: 0, scrollTop: 0 },
  });
  const [sourceSample, setSourceSample] =
    useState<SourceEditorPerformanceSample | null>(null);
  const [shellSession, setShellSession] = useState<ReadyDocumentSession>(() =>
    createShellSession(commonmarkGfm),
  );
  const [shellNarrow, setShellNarrow] = useState(false);

  useEffect(() => {
    const host = codeMirrorRoot.current;
    if (!host) return;
    const startedAt = performance.now();
    const view = createCodeMirrorPoc(host, commonmarkGfm);
    setCodeMirrorReadyMs(performance.now() - startedAt);
    return () => view.destroy();
  }, []);

  return (
    <main>
      <h1>Plainroot T18 Editor PoC</h1>
      <p data-testid="runtime-report">
        Milkdown: {milkdownReadyMs === null ? "loading" : `${milkdownReadyMs.toFixed(1)}ms`} ·
        CodeMirror: {codeMirrorReadyMs === null ? "loading" : `${codeMirrorReadyMs.toFixed(1)}ms`}
      </p>
      <section aria-label="Milkdown PoC">
        <h2>Milkdown</h2>
        <MilkdownReactPoc markdown={commonmarkGfm} onReady={setMilkdownReadyMs} />
      </section>
      <section aria-label="T23 生产视觉编辑器">
        <h2>T23 生产视觉编辑器</h2>
        <p data-testid="visual-runtime-report">
          {visualSample
            ? `${visualSample.phase}: ${visualSample.durationMs.toFixed(1)}ms · ${visualSample.byteLength} bytes`
            : "loading"}
        </p>
        <button
          onClick={() => visualEditorRef.current?.setSelection({ kind: "visual", from: 1, to: 10 })}
          type="button"
        >
          开发验证：选择标题
        </button>
        <button
          onClick={() => {
            setVisualUnavailable("");
            setVisualDocument({
              generation: 2,
              editVersion: 0,
              markdown:
                "# 100 KiB\n\n" +
                `${"performance content ".repeat(50)}\n\n`.repeat(100),
              selection: { kind: "visual", from: 0, to: 0 },
              anchor: { kind: "semantic", blockId: null, fallbackOffset: 0, scrollTop: 0 },
            });
            setVisualKey((current) => current + 1);
          }}
          type="button"
        >
          开发验证：加载 100 KiB
        </button>
        {visualUnavailable ? <p data-testid="visual-unavailable">{visualUnavailable}</p> : null}
        <VisualMarkdownEditor
          document={visualDocument}
          key={visualKey}
          onChange={(change) => {
            setVisualDocument((current) => ({
              ...current,
              editVersion: current.editVersion + 1,
              markdown: change.markdown,
              selection: change.selection,
              anchor: change.anchor,
            }));
          }}
          onPerformance={setVisualSample}
          onUnavailable={(reason) => setVisualUnavailable(reason.message)}
          onRequestLink={async () => ({ href: "https://example.com" })}
          ref={visualEditorRef}
        />
      </section>
      <section aria-label="CodeMirror PoC">
        <h2>CodeMirror</h2>
        <div ref={codeMirrorRoot} />
      </section>
      <section aria-label="T24 生产源码编辑器">
        <h2>T24 生产源码编辑器</h2>
        <p data-testid="source-runtime-report">
          {sourceSample
            ? `${sourceSample.phase}: ${sourceSample.durationMs.toFixed(1)}ms · ${sourceSample.byteLength} bytes`
            : "loading"}
        </p>
        <button
          onClick={() => sourceEditorRef.current?.execute({ kind: "find" })}
          type="button"
        >
          开发验证：查找
        </button>
        <button
          onClick={() =>
            sourceEditorRef.current?.setSelection({
              kind: "source",
              anchor: 0,
              head: 12,
            })
          }
          type="button"
        >
          开发验证：选择源码
        </button>
        <SourceMarkdownEditor
          document={sourceDocument}
          onChange={(change) => {
            setSourceDocument((current) => ({
              ...current,
              editVersion: current.editVersion + 1,
              markdown: change.markdown,
              selection: change.selection,
              anchor: change.anchor,
            }));
          }}
          onPerformance={setSourceSample}
          ref={sourceEditorRef}
        />
      </section>
      <section aria-label="T25 统一编辑器壳">
        <h2>T25 统一编辑器壳</h2>
        <button onClick={() => setShellNarrow((current) => !current)} type="button">
          开发验证：{shellNarrow ? "恢复宽窗" : "窄窗 700px"}
        </button>
        <div
          className="editor-shell-poc"
          data-narrow={shellNarrow || undefined}
        >
          <DocumentEditorShell
            onSessionChange={setShellSession}
            session={shellSession}
          />
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("T18 PoC root is missing.");

createRoot(root).render(
  <StrictMode>
    <BrowserPoc />
  </StrictMode>,
);

function createShellSession(markdown: string): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "poc-workspace",
    relativePath: "commonmark-gfm.md",
  });
  const resolved = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath: "commonmark-gfm.md",
      status: "ready",
      content: markdown,
      revision: {
        modifiedAt: 1,
        size: markdown.length,
        contentHash: "poc",
        encoding: "utf8",
        lineEnding: "lf",
      },
    },
    { mode: "visual", reasons: [] },
    true,
  );
  if (resolved.status !== "ready") throw new Error("T25 PoC session failed");
  return resolved;
}
