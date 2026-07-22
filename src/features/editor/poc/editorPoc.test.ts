import { listenerCtx } from "@milkdown/kit/plugin/listener";
import { TextSelection } from "@milkdown/kit/prose/state";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import commonmarkGfm from "../../../../tests/fixtures/markdown/commonmark-gfm.md?raw";
import rawHtml from "../../../../tests/fixtures/markdown/raw-html.md?raw";
import sourceOnly from "../../../../tests/fixtures/markdown/source-only.md?raw";
import { createCodeMirrorPoc } from "./codeMirrorPoc";
import { MilkdownReactPoc } from "./MilkdownReactPoc";
import { classifyVisualEditingCompatibility } from "./markdownCompatibility";
import { createMilkdownPoc } from "./milkdownPoc";

const mountedRoots: HTMLElement[] = [];

function mountRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mountedRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove();
});

describe("Milkdown 7.21.3 PoC", () => {
  it("mounts and destroys through the React adapter", async () => {
    const onReady = vi.fn();
    const rendered = render(
      createElement(MilkdownReactPoc, { markdown: "# React adapter", onReady }),
    );

    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
    expect(onReady).toHaveBeenCalledTimes(1);

    rendered.unmount();
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).toBeNull());
  });

  it("round-trips the required CommonMark and GFM corpus to a stable semantic form", async () => {
    const instance = await createMilkdownPoc(mountRoot(), commonmarkGfm);
    const before = instance.view.state.doc;
    const serialized = instance.getMarkdown();
    const reparsed = instance.parser(serialized);
    const canonical = await createMilkdownPoc(mountRoot(), serialized);

    expect(typeof reparsed).not.toBe("string");
    if (typeof reparsed !== "string") expect(reparsed.textContent).toBe(before.textContent);
    expect(canonical.getMarkdown()).toBe(serialized);
    expect(serialized).toMatch(/\| 能力 \| 状态\s+\|/);
    expect(serialized).toMatch(/[*-] \[x\] 已完成/);
    expect(serialized).toContain("```ts");

    await canonical.destroy();
    await instance.destroy();
  });

  it("preserves supported raw HTML without executing it", async () => {
    const instance = await createMilkdownPoc(mountRoot(), rawHtml);
    const serialized = instance.getMarkdown();

    expect(serialized).toContain("<details>");
    expect(serialized).toContain("<summary>保留原始 HTML</summary>");
    expect(instance.view.dom.querySelector("script")).toBeNull();

    await instance.destroy();
  });

  it("survives focus, composition and Markdown clipboard input, then destroys listeners", async () => {
    const root = mountRoot();
    const instance = await createMilkdownPoc(root, "# 输入测试\n\n开始");
    const onFocus = vi.fn();
    const onDestroy = vi.fn();
    instance.editor.ctx.get(listenerCtx).focus(onFocus).destroy(onDestroy);

    instance.view.focus();
    instance.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "中" }));
    instance.view.dispatch(
      instance.view.state.tr.insertText("中文输入", instance.view.state.doc.content.size),
    );
    instance.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "中文输入" }));

    instance.view.dispatch(
      instance.view.state.tr.setSelection(TextSelection.atEnd(instance.view.state.doc)),
    );
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) =>
          type === "text/plain" ? "\n\n**剪贴板 Markdown**" : "",
      },
    });
    instance.view.dom.dispatchEvent(paste);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(instance.getMarkdown()).toContain("中文输入");
    expect(instance.getMarkdown()).toContain("**剪贴板 Markdown**");

    await instance.destroy();
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".ProseMirror")).toBeNull();
  });
});

describe("CodeMirror 6 PoC", () => {
  it("creates, focuses, accepts composition text and releases its view", () => {
    const root = mountRoot();
    const view = createCodeMirrorPoc(root, commonmarkGfm);

    view.focus();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { data: "中" }));
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n中文源码输入" },
    });
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { data: "中文源码输入" }),
    );

    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toContain("中文源码输入");
    expect(root.querySelector(".cm-gutters")).not.toBeNull();

    view.destroy();
    expect(root.querySelector(".cm-editor")).toBeNull();
  });
});

describe("source-safe fallback", () => {
  it("keeps unsupported syntax byte-for-byte on the source-only path", () => {
    const result = classifyVisualEditingCompatibility(sourceOnly);

    expect(result).toEqual({
      mode: "source-only",
      reasons: ["custom-directive", "frontmatter", "mdx-component", "wiki-link"],
    });
    expect(sourceOnly).toContain(":::plainroot");
    expect(sourceOnly).toContain("[[内部链接]]");
    expect(sourceOnly).toContain("<CustomPanel />");
  });

  it("does not flag custom syntax shown inside fenced code", () => {
    expect(classifyVisualEditingCompatibility("```md\n:::example\n[[link]]\n```\n")).toEqual({
      mode: "visual",
      reasons: [],
    });
  });
});
