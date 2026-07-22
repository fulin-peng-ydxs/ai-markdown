export type VisualEditingCompatibility =
  | { mode: "visual"; reasons: [] }
  | { mode: "source-only"; reasons: string[] };

const unsupportedLineRules: ReadonlyArray<{
  reason: string;
  matches: (line: string) => boolean;
}> = [
  {
    reason: "custom-directive",
    matches: (line) => /^\s*:{2,}\s*\S/.test(line),
  },
  {
    reason: "wiki-link",
    matches: (line) => /\[\[[^\]]+\]\]/.test(line),
  },
  {
    reason: "mdx-module",
    matches: (line) => /^\s*(?:import|export)\s.+\sfrom\s+["'][^"']+["']/.test(line),
  },
  {
    reason: "mdx-component",
    matches: (line) => /<\/?[A-Z][A-Za-z0-9]*(?:\s|\/?>)/.test(line),
  },
];

function hasFrontmatter(markdown: string): boolean {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return false;

  return normalized
    .split(/\r?\n/)
    .slice(1)
    .some((line) => line.trim() === "---");
}

/**
 * This conservative PoC-only guard keeps syntax without a verified Milkdown mapping on
 * the source-safe path. Its line heuristics are not a production parser: T19 must replace
 * them with an AST-backed decision before wiring compatibility into DocumentSession. It
 * ignores ordinary fenced code contents so custom-syntax examples do not force fallback.
 */
export function classifyVisualEditingCompatibility(markdown: string): VisualEditingCompatibility {
  const reasons = new Set<string>();
  if (hasFrontmatter(markdown)) reasons.add("frontmatter");

  let fence: "```" | "~~~" | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.startsWith("`") ? "```" : "~~~";
      if (fence === marker) fence = null;
      else if (fence === null) fence = marker;
      continue;
    }
    if (fence !== null) continue;

    for (const rule of unsupportedLineRules) {
      if (rule.matches(line)) reasons.add(rule.reason);
    }
  }

  return reasons.size === 0
    ? { mode: "visual", reasons: [] }
    : { mode: "source-only", reasons: [...reasons].sort() };
}
