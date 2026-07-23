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
  | {
      kind: "block";
      block: "paragraph" | "quote" | "bullet_list" | "ordered_list" | "task_list";
    }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "insert_link"; href: string; title?: string }
  | { kind: "insert_image"; src: string; alt?: string; title?: string }
  | { kind: "insert_table"; rows?: number; columns?: number }
  | { kind: "insert_divider" }
  | { kind: "history"; direction: "undo" | "redo" }
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
