import { Editor } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Milkdown, MilkdownProvider } from "@milkdown/react";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup, EditorView } from "codemirror";

// A dedicated build entry measures the editor dependency increment without exposing a
// hidden production route or forcing T18's disposable PoC into the shipped application.
export const editorBundleProbe = {
  Editor,
  EditorView,
  Milkdown,
  MilkdownProvider,
  basicSetup,
  clipboard,
  commonmark,
  gfm,
  history,
  listener,
  markdown,
};

Object.defineProperty(globalThis, "__plainrootEditorBundleProbe", {
  configurable: true,
  value: editorBundleProbe,
});
