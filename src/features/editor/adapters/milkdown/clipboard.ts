import type { Node as ProseNode, Schema, Slice } from "@milkdown/kit/prose/model";
import { DOMSerializer } from "@milkdown/kit/prose/model";

export type VisualCopyFormat = "plain_text" | "markdown" | "rich_text";

export interface VisualClipboardPayload {
  plainText: string;
  markdown: string;
  html: string;
}

const SAFE_RICH_TAGS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "STRIKE",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

export function clipboardPayloadFromSlice(
  slice: Slice,
  schema: Schema,
  serialize: (node: ProseNode) => string,
): VisualClipboardPayload {
  const plainText = slice.content.textBetween(0, slice.content.size, "\n\n");
  const selectionDocument = schema.topNodeType.createAndFill(undefined, slice.content);
  const markdown = selectionDocument ? serialize(selectionDocument) : plainText;
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(slice.content);
  const container = document.createElement("div");
  container.append(fragment);

  return { plainText, markdown, html: container.innerHTML };
}

export async function writeVisualClipboard(
  format: VisualCopyFormat,
  payload: VisualClipboardPayload,
): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return false;

    if (format === "plain_text") {
      await clipboard.writeText(payload.plainText);
      return true;
    }
    if (format === "markdown") {
      await clipboard.writeText(payload.markdown);
      return true;
    }

    if (typeof ClipboardItem === "undefined" || !clipboard.write) return false;
    await clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
        "text/html": new Blob([payload.html], { type: "text/html" }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rich paste is intentionally narrower than arbitrary HTML. Unsupported containers
 * are unwrapped to visible text/children; active content and event attributes are removed.
 */
export function sanitizeRichClipboardHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of [...template.content.querySelectorAll("*")]) {
    if (!SAFE_RICH_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const keepSafeLink =
        element.tagName === "A" &&
        attribute.name === "href" &&
        isSafeClipboardHref(attribute.value);
      if (!keepSafeLink) element.removeAttribute(attribute.name);
    }
  }
  return template.innerHTML;
}

function isSafeClipboardHref(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("https://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("#") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    (!normalized.includes(":") && !normalized.startsWith("//"))
  );
}
