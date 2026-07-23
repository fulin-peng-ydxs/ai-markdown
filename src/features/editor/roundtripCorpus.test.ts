import { afterEach, describe, expect, it } from "vitest";

import commonmarkGfm from "../../../tests/fixtures/markdown/commonmark-gfm.md?raw";
import rawHtml from "../../../tests/fixtures/markdown/raw-html.md?raw";
import sourceOnly from "../../../tests/fixtures/markdown/source-only.md?raw";
import { CodeMirrorSourceAdapter } from "./adapters/codemirror/CodeMirrorSourceAdapter";
import { MilkdownVisualAdapter } from "./adapters/milkdown/MilkdownVisualAdapter";
import { editorAdapterTestDocument } from "./adapters/editorAdapterTestSupport";

const mountedRoots: HTMLElement[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove();
});

describe("production Markdown roundtrip corpus", () => {
  it("round-trips the required CommonMark/GFM structures to one stable semantic form", async () => {
    const firstRoot = mountRoot();
    const secondRoot = mountRoot();
    const first = new MilkdownVisualAdapter(firstRoot);
    const second = new MilkdownVisualAdapter(secondRoot);

    await first.load(visualDocument(commonmarkGfm));
    const serialized = first.getMarkdown();
    await second.load(visualDocument(serialized));

    expect(second.getMarkdown()).toBe(serialized);
    expect(serialized).toContain("**粗体**");
    expect(serialized).toContain("*斜体*");
    expect(serialized).toContain("~~删除线~~");
    expect(serialized).toContain("[链接](https://example.com)");
    expect(serialized).toContain("> 长文引用保持语义。");
    expect(serialized).toContain("1. 有序项目");
    expect(serialized).toMatch(/\| 能力 \| 状态\s+\|/);
    expect(serialized).toMatch(/[*-] \[x\] 已完成/);
    expect(serialized).toContain("```ts");
    expect(serialized).toContain('![示例图片](assets/example.png "图片标题")');

    first.destroy();
    second.destroy();
  });

  it("preserves supported raw HTML as inert Markdown source", async () => {
    const root = mountRoot();
    const adapter = new MilkdownVisualAdapter(root);

    await adapter.load(visualDocument(rawHtml));

    expect(adapter.getMarkdown()).toContain("<details>");
    expect(adapter.getMarkdown()).toContain("<summary>保留原始 HTML</summary>");
    expect(adapter.getMarkdown()).toContain(
      "<script>globalThis.__plainrootRawHtmlExecuted = true;</script>",
    );
    expect(root.querySelector("script")).toBeNull();
    expect(
      (globalThis as typeof globalThis & { __plainrootRawHtmlExecuted?: boolean })
        .__plainrootRawHtmlExecuted,
    ).toBeUndefined();

    adapter.destroy();
  });

  it("keeps source-only syntax byte-for-byte through the production source adapter", () => {
    const root = mountRoot();
    const adapter = new CodeMirrorSourceAdapter(root);

    adapter.load(
      editorAdapterTestDocument(sourceOnly, {
        kind: "source",
        anchor: 0,
        head: 0,
      }),
    );

    expect(adapter.getMarkdown()).toBe(sourceOnly);
    expect(adapter.getMarkdown()).toContain("[[内部链接]]");
    expect(adapter.getMarkdown()).toContain(":::plainroot");
    expect(adapter.getMarkdown()).toContain("<CustomPanel />");

    adapter.destroy();
  });
});

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mountedRoots.push(root);
  return root;
}

function visualDocument(markdown: string) {
  return editorAdapterTestDocument(markdown, {
    kind: "visual",
    from: 0,
    to: 0,
  });
}
