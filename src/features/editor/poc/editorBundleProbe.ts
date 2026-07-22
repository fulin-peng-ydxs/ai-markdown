import { Editor } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Milkdown, MilkdownProvider } from "@milkdown/react";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup, EditorView } from "codemirror";

// This module is a build-only entry. The report script preserves its exports so Rollup
// cannot erase the measured dependency graph; production code never imports this file.
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
