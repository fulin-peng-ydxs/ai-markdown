import { remark } from "remark";
import remarkGfm from "remark-gfm";

import type { WorkspaceRelativePath } from "../../../services/desktop/contracts";

interface PositionedNode {
  type: string;
  url?: string;
  children?: PositionedNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

const markdownParser = remark().use(remarkGfm);

export function workspaceAssetPathToMarkdown(
  documentPath: WorkspaceRelativePath,
  assetPath: WorkspaceRelativePath,
): string {
  const documentDirectory = pathSegments(documentPath).slice(0, -1);
  const assetSegments = pathSegments(assetPath);
  let shared = 0;
  while (
    shared < documentDirectory.length &&
    shared < assetSegments.length &&
    documentDirectory[shared] === assetSegments[shared]
  ) {
    shared += 1;
  }
  const relative = [
    ...documentDirectory.slice(shared).map(() => ".."),
    ...assetSegments.slice(shared),
  ];
  return relative.map(encodeURIComponent).join("/");
}

export function markdownImageSourceToWorkspacePath(
  documentPath: WorkspaceRelativePath,
  source: string,
): WorkspaceRelativePath | null {
  const trimmed = source.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("#") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)
  ) {
    return null;
  }
  const output = pathSegments(documentPath).slice(0, -1);
  for (const encoded of trimmed.replaceAll("\\", "/").split("/")) {
    if (!encoded || encoded === ".") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      !segment ||
      segment === "." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes(":")
    ) {
      return null;
    }
    if (segment === "..") {
      if (output.length === 0) return null;
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return output.length > 0 ? output.join("/") : null;
}

export function countLocalMarkdownImages(
  markdown: string,
  documentPath: WorkspaceRelativePath,
): number {
  return collectImages(markdown).filter(
    (image) =>
      typeof image.url === "string" &&
      markdownImageSourceToWorkspacePath(documentPath, image.url) !== null,
  ).length;
}

export function rewriteMarkdownImageLinksForMove(
  markdown: string,
  previousDocumentPath: WorkspaceRelativePath,
  nextDocumentPath: WorkspaceRelativePath,
  movedSource: WorkspaceRelativePath,
  movedTarget: WorkspaceRelativePath,
): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const image of collectImages(markdown)) {
    const source = image.url;
    const start = image.position?.start?.offset;
    const end = image.position?.end?.offset;
    if (typeof source !== "string" || start === undefined || end === undefined) {
      continue;
    }
    const workspacePath = markdownImageSourceToWorkspacePath(
      previousDocumentPath,
      source,
    );
    if (!workspacePath) continue;
    const remappedAsset =
      workspacePath === movedSource ||
      workspacePath.startsWith(`${movedSource}/`)
        ? `${movedTarget}${workspacePath.slice(movedSource.length)}`
        : workspacePath;
    const nextSource = workspaceAssetPathToMarkdown(
      nextDocumentPath,
      remappedAsset,
    );
    if (nextSource === source) continue;
    const raw = markdown.slice(start, end);
    const destination = markdownImageDestinationSpan(raw);
    if (!destination) continue;
    replacements.push({
      start: start + destination.start,
      end: start + destination.end,
      value: nextSource,
    });
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (content, replacement) =>
        `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`,
      markdown,
    );
}

function collectImages(markdown: string): PositionedNode[] {
  const root = markdownParser.parse(markdown) as unknown as PositionedNode;
  const images: PositionedNode[] = [];
  visit(root, (node) => {
    if (node.type === "image") images.push(node);
  });
  return images;
}

function visit(node: PositionedNode, consumer: (node: PositionedNode) => void) {
  consumer(node);
  for (const child of node.children ?? []) visit(child, consumer);
}

function pathSegments(path: WorkspaceRelativePath): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

function markdownImageDestinationSpan(
  rawImage: string,
): { start: number; end: number } | null {
  const opening = rawImage.lastIndexOf("](");
  if (opening < 0) return null;
  let start = opening + 2;
  while (/\s/.test(rawImage[start] ?? "")) start += 1;
  if (rawImage[start] === "<") {
    start += 1;
    for (let index = start; index < rawImage.length; index += 1) {
      if (rawImage[index] === "\\" && index + 1 < rawImage.length) {
        index += 1;
      } else if (rawImage[index] === ">") {
        return { start, end: index };
      }
    }
    return null;
  }

  let nestedParentheses = 0;
  for (let index = start; index < rawImage.length; index += 1) {
    const character = rawImage[index];
    if (character === "\\" && index + 1 < rawImage.length) {
      index += 1;
    } else if (character === "(") {
      nestedParentheses += 1;
    } else if (character === ")") {
      if (nestedParentheses === 0) return { start, end: index };
      nestedParentheses -= 1;
    } else if (/\s/.test(character) && nestedParentheses === 0) {
      return { start, end: index };
    }
  }
  return null;
}
