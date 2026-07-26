import type {
  WindowTabSessionSnapshot,
  WindowTabViewState,
} from "../../services/desktop/contracts";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import type { WorkspaceTabViewState } from "./tabTypes";

const defaultView: WindowTabViewState = {
  mode: "visual",
  selection: { kind: "visual", from: 0, to: 0 },
  anchor: {
    kind: "semantic",
    blockId: null,
    fallbackOffset: 0,
    scrollTop: 0,
  },
};

/**
 * Builds the content-free persistence input. T42 connects this projection only
 * after reading/restoring the existing repository revision, preventing an
 * empty startup collection from overwriting a recoverable prior session.
 */
export function projectWindowTabSessionSnapshot(
  snapshot: WorkspaceTabManagerSnapshot,
  updatedAt: number,
): WindowTabSessionSnapshot {
  const tabs = snapshot.collection.orderedTabIds.flatMap((tabId) => {
    const tab = snapshot.collection.tabsById.get(tabId);
    if (!tab) return [];
    const runtime = snapshot.runtimes.get(tabId);
    const view =
      runtime?.incarnation === tab.incarnation &&
      runtime.session.status === "ready"
        ? {
            mode: runtime.session.mode,
            selection: runtime.session.selection,
            anchor: runtime.session.anchor,
          }
        : tab.restoredView;
    return [{
      relativePath: tab.relativePath,
      view: toPersistedView(view),
      lastActivatedAt: tab.lastActivatedAt,
    }];
  });
  return {
    tabs,
    activeRelativePath: snapshot.activeTab?.relativePath ?? null,
    recentlyClosed: snapshot.collection.recentlyClosed.map((recent) => ({
      relativePath: recent.relativePath,
      view: toPersistedView(recent.view),
      closedAt: recent.closedAt,
    })),
    updatedAt,
  };
}

function toPersistedView(
  view: WorkspaceTabViewState | null,
): WindowTabViewState {
  return view ?? defaultView;
}
