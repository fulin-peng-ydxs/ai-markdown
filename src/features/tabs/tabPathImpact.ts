import type {
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  rewriteMarkdownImageLinksForMove,
} from "../editor/assets/workspaceAssetPath";
import type { ReadyDocumentSession } from "../editor/documentSession";
import {
  isSameOrInside,
  replacePrefix,
} from "../workbench/workspacePath";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import type {
  WorkspaceTabDescriptor,
  WorkspaceTabId,
} from "./tabTypes";

export type WorkspaceTabPathMutation =
  | {
      kind: "rename" | "move";
      sourcePath: WorkspaceRelativePath;
      targetPath: WorkspaceRelativePath;
    }
  | {
      kind: "delete";
      sourcePath: WorkspaceRelativePath;
    };

export interface WorkspaceTabPathRemap {
  tabId: WorkspaceTabId;
  incarnation: number;
  previousPath: WorkspaceRelativePath;
  nextPath: WorkspaceRelativePath | null;
}

export interface WorkspaceTabMarkdownRewrite {
  tabId: WorkspaceTabId;
  incarnation: number;
  relativePath: WorkspaceRelativePath;
  generation: number;
  expectedEditVersion: number;
  markdown: string;
}

export interface WorkspaceTabPathImpact {
  mutation: WorkspaceTabPathMutation;
  affectedTabIds: readonly WorkspaceTabId[];
  pathRemaps: readonly WorkspaceTabPathRemap[];
  markdownRewrites: readonly WorkspaceTabMarkdownRewrite[];
}

/**
 * Produces an immutable pre-commit plan only. T40 owns settlement, disk
 * mutation and the final atomic projection into tab runtimes.
 */
export function analyzeWorkspaceTabPathImpact(
  snapshot: WorkspaceTabManagerSnapshot,
  mutation: WorkspaceTabPathMutation,
): WorkspaceTabPathImpact {
  const tabs = orderedTabs(snapshot);
  const pathRemaps = tabs.flatMap((tab) => {
    if (!isSameOrInside(tab.relativePath, mutation.sourcePath)) return [];
    return [{
      tabId: tab.tabId,
      incarnation: tab.incarnation,
      previousPath: tab.relativePath,
      nextPath:
        mutation.kind === "delete"
          ? null
          : replacePrefix(
              tab.relativePath,
              mutation.sourcePath,
              mutation.targetPath,
            ),
    }];
  });
  const markdownRewrites =
    mutation.kind === "delete"
      ? []
      : tabs.flatMap((tab) => {
          const runtime = snapshot.runtimes.get(tab.tabId);
          if (
            runtime?.incarnation !== tab.incarnation ||
            runtime.session.status !== "ready"
          ) {
            return [];
          }
          return markdownRewriteForMove(
            tab,
            runtime.session,
            mutation.sourcePath,
            mutation.targetPath,
          );
        });
  return {
    mutation,
    affectedTabIds: uniqueTabIds(pathRemaps, markdownRewrites),
    pathRemaps,
    markdownRewrites,
  };
}

function orderedTabs(
  snapshot: WorkspaceTabManagerSnapshot,
): readonly WorkspaceTabDescriptor[] {
  return snapshot.collection.orderedTabIds.flatMap((tabId) => {
    const tab = snapshot.collection.tabsById.get(tabId);
    return tab ? [tab] : [];
  });
}

function markdownRewriteForMove(
  tab: WorkspaceTabDescriptor,
  session: ReadyDocumentSession,
  sourcePath: WorkspaceRelativePath,
  targetPath: WorkspaceRelativePath,
): readonly WorkspaceTabMarkdownRewrite[] {
  const nextDocumentPath = isSameOrInside(tab.relativePath, sourcePath)
    ? replacePrefix(tab.relativePath, sourcePath, targetPath)
    : tab.relativePath;
  const markdown = rewriteMarkdownImageLinksForMove(
    session.markdown,
    tab.relativePath,
    nextDocumentPath,
    sourcePath,
    targetPath,
  );
  return markdown === session.markdown
    ? []
    : [{
        tabId: tab.tabId,
        incarnation: tab.incarnation,
        relativePath: nextDocumentPath,
        generation: session.generation,
        expectedEditVersion: session.editVersion,
        markdown,
      }];
}

function uniqueTabIds(
  pathRemaps: readonly WorkspaceTabPathRemap[],
  markdownRewrites: readonly WorkspaceTabMarkdownRewrite[],
): readonly WorkspaceTabId[] {
  return [
    ...new Set([
      ...pathRemaps.map((item) => item.tabId),
      ...markdownRewrites.map((item) => item.tabId),
    ]),
  ];
}
