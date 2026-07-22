export type EditorMode = "visual" | "source";

export type EditorSelection =
  | { kind: "visual"; from: number; to: number }
  | { kind: "source"; anchor: number; head: number };

export type DocumentAnchor =
  | {
      kind: "semantic";
      blockId: string | null;
      fallbackOffset: number;
      scrollTop: number;
    }
  | { kind: "source"; offset: number; scrollTop: number };

export interface EditorAdapterDocument {
  generation: number;
  editVersion: number;
  markdown: string;
  selection: EditorSelection;
  anchor: DocumentAnchor;
}

export interface EditorAdapterChange {
  generation: number;
  expectedEditVersion: number;
  markdown: string;
  selection: EditorSelection;
  anchor: DocumentAnchor;
  transactionGroup: string | null;
}

export type EditorCommand =
  | { kind: "format"; format: "bold" | "italic" | "strike" | "code" }
  | { kind: "insert_link" }
  | { kind: "insert_image" }
  | { kind: "find" }
  | { kind: "replace" };

/**
 * A mode adapter is only a projection of DocumentSession. It must not keep the
 * authoritative cross-mode history or synchronize directly with another adapter.
 */
export interface EditorAdapter {
  readonly mode: EditorMode;
  load(document: EditorAdapterDocument): void | Promise<void>;
  apply(document: EditorAdapterDocument): void | Promise<void>;
  focus(): void;
  getSelection(): EditorSelection;
  setSelection(selection: EditorSelection): void;
  getAnchor(): DocumentAnchor;
  onChange(listener: (change: EditorAdapterChange) => void): () => void;
  execute(command: EditorCommand): boolean;
  destroy(): void;
}
