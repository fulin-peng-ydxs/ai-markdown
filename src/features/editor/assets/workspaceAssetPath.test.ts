import { describe, expect, it } from "vitest";

import {
  countLocalMarkdownImages,
  markdownImageSourceToWorkspacePath,
  rewriteMarkdownImageLinksForMove,
  workspaceAssetPathToMarkdown,
} from "./workspaceAssetPath";

describe("workspace asset paths", () => {
  it("creates document-relative links for root and nested documents", () => {
    expect(workspaceAssetPathToMarkdown("README.md", "assets/image one.png")).toBe(
      "assets/image%20one.png",
    );
    expect(
      workspaceAssetPathToMarkdown(
        "notes/research/topic.md",
        "assets/image.png",
      ),
    ).toBe("../../assets/image.png");
    expect(
      workspaceAssetPathToMarkdown(
        "notes/research/topic.md",
        "notes/assets/image.png",
      ),
    ).toBe("../assets/image.png");
  });

  it("resolves only local sources that remain inside the workspace", () => {
    expect(
      markdownImageSourceToWorkspacePath(
        "notes/research/topic.md",
        "../../assets/image%20one.png",
      ),
    ).toBe("assets/image one.png");
    expect(
      markdownImageSourceToWorkspacePath("topic.md", "../private.png"),
    ).toBeNull();
    expect(
      markdownImageSourceToWorkspacePath("topic.md", "https://example.com/a.png"),
    ).toBeNull();
    expect(
      markdownImageSourceToWorkspacePath("topic.md", "data:image/png;base64,a"),
    ).toBeNull();
  });

  it("rewrites image links after moving a document or containing directory", () => {
    const markdown =
      "![封面](../../assets/cover.png \"标题\")\\n\\n![远程](https://example.com/a.png)";
    expect(countLocalMarkdownImages(markdown, "notes/a/topic.md")).toBe(1);
    expect(
      rewriteMarkdownImageLinksForMove(
        markdown,
        "notes/a/topic.md",
        "archive/topic.md",
        "notes/a/topic.md",
        "archive/topic.md",
      ),
    ).toContain("![封面](../assets/cover.png \"标题\")");
    expect(
      rewriteMarkdownImageLinksForMove(
        "![同移](images/a.png)",
        "notes/topic.md",
        "archive/topic.md",
        "notes",
        "archive",
      ),
    ).toBe("![同移](images/a.png)");
  });

  it("rewrites the destination instead of matching identical alt or title text", () => {
    expect(
      rewriteMarkdownImageLinksForMove(
        "![assets/cover.png](assets/cover.png \"assets/cover.png\")",
        "note.md",
        "archive/note.md",
        "note.md",
        "archive/note.md",
      ),
    ).toBe(
      "![assets/cover.png](../assets/cover.png \"assets/cover.png\")",
    );
  });
});
