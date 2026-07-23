import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";

export interface ResolvedWorkspaceImage {
  url: string;
  release(): void;
}

export interface PreparedImageRelocation {
  source: string;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
}

export interface WorkspaceImageNodeViewOptions {
  readOnly: boolean;
  resolve?(
    source: string,
  ): Promise<ResolvedWorkspaceImage | null>;
  relocate?(
    source: string,
  ): Promise<PreparedImageRelocation | null>;
}

export function createWorkspaceImageNodeView(
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  options: WorkspaceImageNodeViewOptions,
): NodeView {
  let node = initialNode;
  let sequence = 0;
  let relocationInFlight = false;
  let resolved: ResolvedWorkspaceImage | null = null;
  const document = view.dom.ownerDocument;
  const dom = document.createElement("span");
  dom.className = "workspace-image";
  dom.contentEditable = "false";
  const image = document.createElement("img");
  image.alt = String(node.attrs.alt ?? "");
  image.title = String(node.attrs.title ?? "");
  const fallback = document.createElement("span");
  fallback.className = "workspace-image__fallback";
  const label = document.createElement("strong");
  label.textContent = "图片无法显示";
  const path = document.createElement("code");
  const relocate = document.createElement("button");
  relocate.type = "button";
  relocate.textContent = "重新定位";
  relocate.hidden = options.readOnly || !options.relocate;
  fallback.append(label, path, relocate);
  dom.append(image, fallback);
  image.addEventListener("error", () => {
    resolved?.release();
    resolved = null;
    showFallback(String(node.attrs.src ?? ""));
  });

  function showFallback(source: string, message = "图片无法显示") {
    image.hidden = true;
    fallback.hidden = false;
    label.textContent = message;
    path.textContent = source;
  }

  async function renderSource(source: string) {
    const current = ++sequence;
    resolved?.release();
    resolved = null;
    image.hidden = true;
    fallback.hidden = false;
    label.textContent = "正在读取图片…";
    path.textContent = source;
    if (!options.resolve) {
      showFallback(source);
      return;
    }
    try {
      const next = await options.resolve(source);
      if (current !== sequence) {
        next?.release();
        return;
      }
      if (!next) {
        showFallback(source);
        return;
      }
      resolved = next;
      image.alt = String(node.attrs.alt ?? "");
      image.title = String(node.attrs.title ?? "");
      image.src = next.url;
      image.hidden = false;
      fallback.hidden = true;
    } catch {
      if (current === sequence) showFallback(source);
    }
  }

  relocate.addEventListener("click", () => {
    if (relocationInFlight) return;
    relocationInFlight = true;
    relocate.disabled = true;
    const previousSource = String(node.attrs.src ?? "");
    void options
      .relocate?.(previousSource)
      .then(async (prepared) => {
        if (!prepared) return;
        const position = getPos();
        if (position === undefined) {
          await prepared.cancel();
          return;
        }
        try {
          view.dispatch(
            view.state.tr.setNodeMarkup(position, undefined, {
              ...node.attrs,
              src: prepared.source,
            }),
          );
          await prepared.confirm();
        } catch {
          const currentPosition = getPos();
          if (currentPosition !== undefined) {
            view.dispatch(
              view.state.tr.setNodeMarkup(currentPosition, undefined, {
                ...node.attrs,
                src: previousSource,
              }),
            );
          }
          await prepared.cancel().catch(() => undefined);
          showFallback(previousSource, "重新定位没有完成");
        }
      })
      .catch(() => showFallback(previousSource, "重新定位没有完成"))
      .finally(() => {
        relocationInFlight = false;
        relocate.disabled = false;
      });
  });

  void renderSource(String(node.attrs.src ?? ""));
  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== node.type) return false;
      const previousSource = String(node.attrs.src ?? "");
      node = nextNode;
      const source = String(node.attrs.src ?? "");
      image.alt = String(node.attrs.alt ?? "");
      image.title = String(node.attrs.title ?? "");
      if (source !== previousSource) void renderSource(source);
      return true;
    },
    destroy() {
      sequence += 1;
      resolved?.release();
      resolved = null;
    },
    ignoreMutation: () => true,
    stopEvent: (event) => event.target === relocate,
  };
}
