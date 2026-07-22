import { basicSetup, EditorView } from "codemirror";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";

export function createCodeMirrorPoc(root: HTMLElement, markdown: string): EditorView {
  return new EditorView({
    doc: markdown,
    extensions: [basicSetup, markdownLanguage()],
    parent: root,
  });
}
