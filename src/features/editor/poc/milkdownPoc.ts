import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  parserCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { getMarkdown } from "@milkdown/kit/utils";

export function createMilkdownPocEditor(root: HTMLElement, markdown: string): Editor {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(clipboard)
    .use(history)
    .use(listener);
}

export async function createMilkdownPoc(root: HTMLElement, markdown: string) {
  const editor = createMilkdownPocEditor(root, markdown);

  await editor.create();

  return {
    editor,
    view: editor.ctx.get(editorViewCtx),
    parser: editor.ctx.get(parserCtx),
    getMarkdown: () => editor.action(getMarkdown()),
    destroy: () => editor.destroy(),
  };
}
