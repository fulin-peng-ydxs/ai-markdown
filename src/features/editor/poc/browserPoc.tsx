import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import commonmarkGfm from "../../../../tests/fixtures/markdown/commonmark-gfm.md?raw";
import { createCodeMirrorPoc } from "./codeMirrorPoc";
import { MilkdownReactPoc } from "./MilkdownReactPoc";

function BrowserPoc() {
  const codeMirrorRoot = useRef<HTMLDivElement>(null);
  const [milkdownReadyMs, setMilkdownReadyMs] = useState<number | null>(null);
  const [codeMirrorReadyMs, setCodeMirrorReadyMs] = useState<number | null>(null);

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
      <section aria-label="CodeMirror PoC">
        <h2>CodeMirror</h2>
        <div ref={codeMirrorRoot} />
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
