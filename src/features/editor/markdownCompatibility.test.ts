import { describe, expect, it } from "vitest";

import { assessVisualEditingCompatibility } from "./markdownCompatibility";

describe("Markdown AST compatibility", () => {
  it("accepts supported CommonMark/GFM nodes including HTML and thematic breaks", () => {
    expect(
      assessVisualEditingCompatibility({
        root: {
          type: "root",
          children: [
            { type: "thematicBreak" },
            { type: "html" },
            { type: "table", children: [{ type: "tableRow" }] },
          ],
        },
        parseError: null,
        unmappedSyntax: [],
      }),
    ).toEqual({ mode: "visual", reasons: [] });
  });

  it("uses AST node types and parser diagnostics for source-only decisions", () => {
    expect(
      assessVisualEditingCompatibility({
        root: {
          type: "root",
          children: [
            { type: "yaml" },
            { type: "containerDirective" },
            { type: "unknownPluginNode" },
          ],
        },
        parseError: null,
        unmappedSyntax: ["wiki-link"],
      }),
    ).toEqual({
      mode: "source-only",
      reasons: [
        "custom-directive",
        "frontmatter",
        "unsupported-node:unknownPluginNode",
        "wiki-link",
      ],
    });
  });

  it("fails closed when parsing has no trustworthy AST", () => {
    expect(
      assessVisualEditingCompatibility({
        root: null,
        parseError: "invalid tree",
        unmappedSyntax: [],
      }),
    ).toEqual({
      mode: "source-only",
      reasons: ["missing-ast", "parse-error"],
    });
  });
});
