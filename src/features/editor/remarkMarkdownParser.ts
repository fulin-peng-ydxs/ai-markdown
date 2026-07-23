import { remark } from "remark";
import remarkGfm from "remark-gfm";

import { visualEditorEligibility } from "./adapters/milkdown/visualEditorPolicy";
import type { MarkdownCompatibilityParser } from "./editorGateway";
import {
  assessVisualEditingCompatibility,
  type MarkdownAstNode,
  type MarkdownParseEvidence,
  type VisualEditingCompatibility,
} from "./markdownCompatibility";

interface RemarkNode extends MarkdownAstNode {
  value?: string;
}

const processor = remark().use(remarkGfm);

export const remarkMarkdownCompatibilityParser: MarkdownCompatibilityParser = {
  async parse(markdown) {
    return parseMarkdownEvidence(markdown);
  },
};

export function parseMarkdownEvidence(markdown: string): MarkdownParseEvidence {
  try {
    const root = processor.parse(markdown) as unknown as RemarkNode;
    const unmappedSyntax = new Set(collectUnmappedSyntax(markdown, root));
    const eligibility = visualEditorEligibility(markdown);
    if (!eligibility.eligible) {
      unmappedSyntax.add(
        eligibility.reason === "document_too_large"
          ? "visual-document-too-large"
          : "visual-document-too-complex",
      );
    }
    return {
      root,
      parseError: null,
      unmappedSyntax: [...unmappedSyntax].sort(),
    };
  } catch (reason) {
    return {
      root: null,
      parseError:
        reason instanceof Error ? reason.message : "Markdown parser failed",
      unmappedSyntax: [],
    };
  }
}

export function compatibilityForMarkdown(
  markdown: string,
): VisualEditingCompatibility {
  return assessVisualEditingCompatibility(parseMarkdownEvidence(markdown));
}

function collectUnmappedSyntax(markdown: string, root: RemarkNode): string[] {
  const reasons = new Set<string>();
  if (hasFrontmatterEnvelope(markdown)) reasons.add("frontmatter");

  visit(root, (node) => {
    if (node.type === "html" && typeof node.value === "string") {
      if (/<\/?[A-Z][A-Za-z0-9]*(?:\s|\/?>)/.test(node.value)) {
        reasons.add("mdx-component");
      }
      return;
    }
    if (node.type !== "text" || typeof node.value !== "string") return;
    if (/\[\[[^\]]+\]\]/.test(node.value)) reasons.add("wiki-link");
    if (/(?:^|\n)\s*:{2,}\s*\S/.test(node.value)) reasons.add("custom-directive");
    if (
      /(?:^|\n)\s*(?:import|export)\s.+\sfrom\s+["'][^"']+["']/.test(
        node.value,
      )
    ) {
      reasons.add("mdx-module");
    }
  });
  return [...reasons].sort();
}

function hasFrontmatterEnvelope(markdown: string): boolean {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const firstBreak = normalized.indexOf("\n");
  if (firstBreak < 0 || normalized.slice(0, firstBreak).trimEnd() !== "---") {
    return false;
  }
  let cursor = firstBreak + 1;
  while (cursor <= normalized.length) {
    const nextBreak = normalized.indexOf("\n", cursor);
    const line = normalized
      .slice(cursor, nextBreak < 0 ? normalized.length : nextBreak)
      .replace(/\r$/, "");
    if (line.trim() === "---") return true;
    if (nextBreak < 0) return false;
    cursor = nextBreak + 1;
  }
  return false;
}

function visit(node: RemarkNode, consumer: (node: RemarkNode) => void): void {
  consumer(node);
  for (const child of node.children ?? []) {
    visit(child as RemarkNode, consumer);
  }
}
