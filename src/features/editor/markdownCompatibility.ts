export interface MarkdownAstNode {
  type: string;
  children?: MarkdownAstNode[];
}

export interface MarkdownParseEvidence {
  root: MarkdownAstNode | null;
  parseError: string | null;
  unmappedSyntax: string[];
}

export type VisualEditingCompatibility =
  | { mode: "visual"; reasons: readonly [] }
  | { mode: "source-only"; reasons: readonly string[] };

const supportedNodeTypes = new Set([
  "root",
  "paragraph",
  "text",
  "heading",
  "thematicBreak",
  "blockquote",
  "list",
  "listItem",
  "break",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "code",
  "link",
  "image",
  "linkReference",
  "imageReference",
  "definition",
  "table",
  "tableRow",
  "tableCell",
  "html",
]);

const sourceOnlyNodeReasons: Readonly<Record<string, string>> = {
  yaml: "frontmatter",
  toml: "frontmatter",
  mdxjsEsm: "mdx-module",
  mdxJsxFlowElement: "mdx-component",
  mdxJsxTextElement: "mdx-component",
  containerDirective: "custom-directive",
  leafDirective: "custom-directive",
  textDirective: "custom-directive",
};

/**
 * Production compatibility is decided from parser evidence. The parser adapter must
 * report syntax it cannot map; this function intentionally does not inspect source lines.
 */
export function assessVisualEditingCompatibility(
  evidence: MarkdownParseEvidence,
): VisualEditingCompatibility {
  const reasons = new Set(evidence.unmappedSyntax.filter(Boolean));
  if (evidence.parseError) reasons.add("parse-error");
  if (!evidence.root) reasons.add("missing-ast");

  if (evidence.root) {
    visit(evidence.root, (node) => {
      const sourceOnlyReason = sourceOnlyNodeReasons[node.type];
      if (sourceOnlyReason) reasons.add(sourceOnlyReason);
      else if (!supportedNodeTypes.has(node.type)) reasons.add(`unsupported-node:${node.type}`);
    });
  }

  return reasons.size === 0
    ? { mode: "visual", reasons: [] }
    : { mode: "source-only", reasons: [...reasons].sort() };
}

function visit(node: MarkdownAstNode, consumer: (node: MarkdownAstNode) => void): void {
  consumer(node);
  for (const child of node.children ?? []) visit(child, consumer);
}
