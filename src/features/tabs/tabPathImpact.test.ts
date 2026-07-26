import { describe, expect, it } from "vitest";

import type {
  FileRevision,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  resolveDocumentRead,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import { acceptWorkspaceTabPath } from "./tabPath";
import { analyzeWorkspaceTabPathImpact } from "./tabPathImpact";
import {
  createWorkspaceTabDescriptor,
  type WorkspaceTabDescriptor,
  type WorkspaceTabRuntime,
} from "./tabTypes";

const revision: FileRevision = {
  modifiedAt: 1,
  size: 20,
  contentHash: "disk",
  encoding: "utf8",
  lineEnding: "lf",
};

function readySession(
  relativePath: WorkspaceRelativePath,
  markdown: string,
): ReadyDocumentSession {
  const loading = beginDocumentLoad(createEmptyDocumentSession(), {
    workspaceId: "workspace-a",
    relativePath,
  });
  const session = resolveDocumentRead(
    loading,
    loading.generation,
    {
      relativePath,
      status: "ready",
      content: markdown,
      revision,
    },
    { mode: "visual", reasons: [] },
    true,
  );
  if (session.status !== "ready") throw new Error("expected ready session");
  return session;
}

function snapshot(
  inputs: readonly {
    path: WorkspaceRelativePath;
    markdown: string;
  }[],
): WorkspaceTabManagerSnapshot {
  const tabs: WorkspaceTabDescriptor[] = inputs.map((input, index) => ({
    ...createWorkspaceTabDescriptor(
      {
        tabId: `tab-${index}`,
        workspaceId: "workspace-a",
        path: acceptWorkspaceTabPath({
          relativePath: input.path,
          identity: `native:${input.path}`,
        }),
        lastActivatedAt: index + 1,
      },
      index + 1,
    ),
    loadState: { kind: "ready", generation: 1 },
  }));
  const runtimes = new Map<string, WorkspaceTabRuntime>(
    tabs.map((tab, index) => [
      tab.tabId,
      {
        incarnation: tab.incarnation,
        session: readySession(tab.relativePath, inputs[index]!.markdown),
        saveController: null,
      },
    ]),
  );
  return {
    collection: {
      workspaceId: "workspace-a",
      orderedTabIds: tabs.map((tab) => tab.tabId),
      activeTabId: tabs[0]?.tabId ?? null,
      tabsById: new Map(tabs.map((tab) => [tab.tabId, tab])),
      pathIndex: new Map(tabs.map((tab) => [tab.pathIdentity, tab.tabId])),
      recentlyClosed: [],
      nextIncarnation: tabs.length + 1,
      revision: tabs.length,
      persistedRevision: 0,
    },
    runtimes,
    activeTab: tabs[0] ?? null,
    activeRuntime: tabs[0] ? runtimes.get(tabs[0].tabId) ?? null : null,
  };
}

describe("analyzeWorkspaceTabPathImpact", () => {
  it("collects directory path remaps and rewrites references in other open documents", () => {
    const current = snapshot([
      {
        path: "guides/a.md",
        markdown: "![diagram](../assets/pic.png)",
      },
      {
        path: "assets/readme.md",
        markdown: "![local](pic.png)",
      },
      {
        path: "notes/plain.md",
        markdown: "No images",
      },
    ]);

    const impact = analyzeWorkspaceTabPathImpact(current, {
      kind: "move",
      sourcePath: "assets",
      targetPath: "media",
    });

    expect(impact.pathRemaps).toEqual([
      {
        tabId: "tab-1",
        incarnation: 2,
        previousPath: "assets/readme.md",
        nextPath: "media/readme.md",
      },
    ]);
    expect(impact.markdownRewrites).toHaveLength(1);
    expect(impact.markdownRewrites[0]).toMatchObject({
      tabId: "tab-0",
      relativePath: "guides/a.md",
      markdown: "![diagram](../media/pic.png)",
    });
    expect(impact.affectedTabIds).toEqual(["tab-1", "tab-0"]);
  });

  it("collects every open descendant for deletion without changing runtimes", () => {
    const current = snapshot([
      { path: "notes/a.md", markdown: "# A" },
      { path: "notes/deep/b.md", markdown: "# B" },
      { path: "outside.md", markdown: "# Outside" },
    ]);
    const runtime = current.runtimes.get("tab-0");

    const impact = analyzeWorkspaceTabPathImpact(current, {
      kind: "delete",
      sourcePath: "notes",
    });

    expect(impact.affectedTabIds).toEqual(["tab-0", "tab-1"]);
    expect(impact.pathRemaps.map((item) => item.nextPath)).toEqual([null, null]);
    expect(impact.markdownRewrites).toEqual([]);
    expect(current.runtimes.get("tab-0")).toBe(runtime);
  });
});
