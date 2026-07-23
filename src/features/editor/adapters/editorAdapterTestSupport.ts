import type {
  EditorAdapterDocument,
  EditorSelection,
} from "../editorAdapter";

export function editorAdapterTestDocument(
  markdown: string,
  selection: EditorSelection,
  overrides: Partial<EditorAdapterDocument> = {},
): EditorAdapterDocument {
  return {
    generation: 7,
    editVersion: 4,
    markdown,
    selection,
    anchor:
      selection.kind === "source"
        ? { kind: "source", offset: selection.head, scrollTop: 0 }
        : {
            kind: "semantic",
            blockId: null,
            fallbackOffset: selection.to,
            scrollTop: 0,
          },
    ...overrides,
  };
}
