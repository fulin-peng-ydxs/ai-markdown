import { describe, expect, it } from "vitest";

import {
  compatibilityForMarkdown,
  parseMarkdownEvidence,
} from "./remarkMarkdownParser";

describe("remarkMarkdownParser", () => {
  it("parses CommonMark and GFM into supported AST evidence", () => {
    const evidence = parseMarkdownEvidence(
      "# 标题\n\n- [x] 任务\n\n| A |\n| - |\n| B |\n",
    );

    expect(evidence.parseError).toBeNull();
    expect(evidence.root?.type).toBe("root");
    expect(compatibilityForMarkdown("# 标题\n\n普通段落")).toEqual({
      mode: "visual",
      reasons: [],
    });
  });

  it.each([
    ["---\ntitle: Note\n---\n\nBody", "frontmatter"],
    ["Read [[Other Note]]", "wiki-link"],
    ["::callout\nBody", "custom-directive"],
    ['import Card from "./Card"\n', "mdx-module"],
    ["<Card />", "mdx-component"],
  ])("keeps %s on the source-safe path", (markdown, reason) => {
    expect(compatibilityForMarkdown(markdown)).toMatchObject({
      mode: "source-only",
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("does not classify custom-looking text inside a code fence", () => {
    expect(
      compatibilityForMarkdown("```md\n[[example]]\n::callout\n```\n"),
    ).toEqual({ mode: "visual", reasons: [] });
  });

  it("includes visual performance limits in the same compatibility result", () => {
    const denseList = Array.from(
      { length: 2_001 },
      (_, index) => `- item ${index}`,
    ).join("\n");

    expect(compatibilityForMarkdown(denseList)).toMatchObject({
      mode: "source-only",
      reasons: ["visual-document-too-complex"],
    });
  });
});
