import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { useEffect, useRef } from "react";

import { createMilkdownPocEditor } from "./milkdownPoc";

function MilkdownReactEditor({
  markdown,
  onReady,
}: {
  markdown: string;
  onReady?: (elapsedMs: number) => void;
}) {
  const startedAt = useRef(performance.now());
  const notified = useRef(false);
  const editor = useEditor((root) => createMilkdownPocEditor(root, markdown), [markdown]);

  useEffect(() => {
    if (!editor.loading && editor.get() && !notified.current) {
      notified.current = true;
      onReady?.(performance.now() - startedAt.current);
    }
  }, [editor, onReady]);

  return <Milkdown />;
}

export function MilkdownReactPoc({
  markdown,
  onReady,
}: {
  markdown: string;
  onReady?: (elapsedMs: number) => void;
}) {
  return (
    <MilkdownProvider>
      <MilkdownReactEditor markdown={markdown} onReady={onReady} />
    </MilkdownProvider>
  );
}
