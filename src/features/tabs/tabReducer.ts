import type {
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  createWorkspaceTabDescriptor,
  type RecentlyClosedWorkspaceTab,
  type WorkspaceTabDescriptor,
  type WorkspaceTabId,
  type WorkspaceTabLoadState,
  type WorkspaceTabProjection,
  type WorkspaceTabRecoveryDescriptor,
  type WorkspaceTabRuntime,
  type WorkspaceTabViewState,
} from "./tabTypes";

export const RECENTLY_CLOSED_TAB_LIMIT = 50;

export interface WorkspaceTabCollection {
  workspaceId: WorkspaceId;
  orderedTabIds: readonly WorkspaceTabId[];
  activeTabId: WorkspaceTabId | null;
  tabsById: ReadonlyMap<WorkspaceTabId, WorkspaceTabDescriptor>;
  pathIndex: ReadonlyMap<WorkspaceRelativePath, WorkspaceTabId>;
  recentlyClosed: readonly RecentlyClosedWorkspaceTab[];
  revision: number;
  persistedRevision: number;
}

export type WorkspaceTabAction =
  | { type: "open"; tab: WorkspaceTabDescriptor }
  | { type: "activate"; tabId: WorkspaceTabId; activatedAt: number }
  | {
      type: "begin_load";
      tabId: WorkspaceTabId;
      generation: number;
    }
  | {
      type: "resolve_load";
      tabId: WorkspaceTabId;
      generation: number;
      outcome: Exclude<WorkspaceTabLoadState, { kind: "idle" | "loading" }>;
    }
  | { type: "move"; tabId: WorkspaceTabId; toIndex: number }
  | {
      type: "close";
      tabId: WorkspaceTabId;
      closedAt: number;
      view: WorkspaceTabViewState | null;
    }
  | {
      type: "restore_closed";
      relativePath: WorkspaceRelativePath;
      tabId: WorkspaceTabId;
      activatedAt: number;
    }
  | { type: "mark_persisted"; revision: number };

export function createWorkspaceTabCollection(
  workspaceId: WorkspaceId,
): WorkspaceTabCollection {
  return {
    workspaceId,
    orderedTabIds: [],
    activeTabId: null,
    tabsById: new Map(),
    pathIndex: new Map(),
    recentlyClosed: [],
    revision: 0,
    persistedRevision: 0,
  };
}

export function reduceWorkspaceTabs(
  state: WorkspaceTabCollection,
  action: WorkspaceTabAction,
): WorkspaceTabCollection {
  switch (action.type) {
    case "open":
      return openTab(state, action.tab);
    case "activate":
      return activateTab(state, action.tabId, action.activatedAt);
    case "begin_load":
      return updateLoadState(state, action.tabId, {
        kind: "loading",
        generation: action.generation,
      });
    case "resolve_load":
      return resolveLoadState(
        state,
        action.tabId,
        action.generation,
        action.outcome,
      );
    case "move":
      return moveTab(state, action.tabId, action.toIndex);
    case "close":
      return closeTab(state, action.tabId, action.closedAt, action.view);
    case "restore_closed":
      return restoreClosedTab(
        state,
        action.relativePath,
        action.tabId,
        action.activatedAt,
      );
    case "mark_persisted":
      return markPersisted(state, action.revision);
  }
}

export function selectActiveWorkspaceTabProjection(
  state: WorkspaceTabCollection,
  runtimes: ReadonlyMap<WorkspaceTabId, WorkspaceTabRuntime>,
): WorkspaceTabProjection | null {
  if (!state.activeTabId) return null;
  const tab = state.tabsById.get(state.activeTabId);
  if (!tab) return null;
  return {
    tab,
    runtime: runtimes.get(tab.tabId) ?? null,
  };
}

export function toWorkspaceTabRecoveryDescriptors(
  state: WorkspaceTabCollection,
  runtimes: ReadonlyMap<WorkspaceTabId, WorkspaceTabRuntime>,
): readonly WorkspaceTabRecoveryDescriptor[] {
  return state.orderedTabIds.flatMap((tabId) => {
    const tab = state.tabsById.get(tabId);
    if (!tab) return [];
    const session = runtimes.get(tabId)?.session;
    const view =
      session?.status === "ready"
        ? {
            mode: session.mode,
            selection: session.selection,
            anchor: session.anchor,
          }
        : tab.restoredView;
    return [
      {
        relativePath: tab.relativePath,
        view,
        lastActivatedAt: tab.lastActivatedAt,
      },
    ];
  });
}

export function workspaceTabsNeedPersistence(
  state: WorkspaceTabCollection,
): boolean {
  return state.persistedRevision < state.revision;
}

export function validateWorkspaceTabCollection(
  state: WorkspaceTabCollection,
): readonly string[] {
  const issues: string[] = [];
  const ordered = new Set(state.orderedTabIds);
  if (ordered.size !== state.orderedTabIds.length) {
    issues.push("ordered tab ids must be unique");
  }
  if (ordered.size !== state.tabsById.size) {
    issues.push("ordered tab ids must match the tab map");
  }
  for (const tabId of state.orderedTabIds) {
    const tab = state.tabsById.get(tabId);
    if (!tab) {
      issues.push(`missing tab descriptor: ${tabId}`);
      continue;
    }
    if (tab.workspaceId !== state.workspaceId) {
      issues.push(`tab belongs to another workspace: ${tabId}`);
    }
    if (state.pathIndex.get(tab.relativePath) !== tabId) {
      issues.push(`path index mismatch: ${tab.relativePath}`);
    }
  }
  for (const [path, tabId] of state.pathIndex) {
    if (state.tabsById.get(tabId)?.relativePath !== path) {
      issues.push(`tab map mismatch: ${path}`);
    }
  }
  if (state.orderedTabIds.length === 0 && state.activeTabId !== null) {
    issues.push("empty collection must not have an active tab");
  }
  if (
    state.orderedTabIds.length > 0 &&
    (!state.activeTabId || !state.tabsById.has(state.activeTabId))
  ) {
    issues.push("non-empty collection must have a valid active tab");
  }
  if (state.recentlyClosed.length > RECENTLY_CLOSED_TAB_LIMIT) {
    issues.push("recently closed tabs exceed the retention limit");
  }
  if (
    state.persistedRevision < 0 ||
    state.persistedRevision > state.revision
  ) {
    issues.push("persisted revision must be within the current revision");
  }
  return issues;
}

function openTab(
  state: WorkspaceTabCollection,
  tab: WorkspaceTabDescriptor,
): WorkspaceTabCollection {
  if (tab.workspaceId !== state.workspaceId) {
    throw new Error("Cannot open a tab from another workspace");
  }
  const existingId = state.pathIndex.get(tab.relativePath);
  if (existingId) {
    const activated = activateTab(state, existingId, tab.lastActivatedAt);
    const recentlyClosed = activated.recentlyClosed.filter(
      (candidate) => candidate.relativePath !== tab.relativePath,
    );
    return recentlyClosed.length === activated.recentlyClosed.length
      ? activated
      : activated === state
        ? changed(state, { recentlyClosed })
        : { ...activated, recentlyClosed };
  }
  if (state.tabsById.has(tab.tabId)) {
    throw new Error(`Workspace tab id already exists: ${tab.tabId}`);
  }
  const tabsById = new Map(state.tabsById);
  const pathIndex = new Map(state.pathIndex);
  tabsById.set(tab.tabId, tab);
  pathIndex.set(tab.relativePath, tab.tabId);
  return changed(state, {
    orderedTabIds: [...state.orderedTabIds, tab.tabId],
    activeTabId: tab.tabId,
    tabsById,
    pathIndex,
    recentlyClosed: state.recentlyClosed.filter(
      (candidate) => candidate.relativePath !== tab.relativePath,
    ),
  });
}

function activateTab(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  activatedAt: number,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (!tab) return state;
  if (
    state.activeTabId === tabId &&
    tab.lastActivatedAt === activatedAt
  ) {
    return state;
  }
  const tabsById = new Map(state.tabsById);
  tabsById.set(tabId, { ...tab, lastActivatedAt: activatedAt });
  return changed(state, { activeTabId: tabId, tabsById });
}

function updateLoadState(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  loadState: WorkspaceTabLoadState,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (!tab || loadState.generation <= tab.loadState.generation) return state;
  const tabsById = new Map(state.tabsById);
  tabsById.set(tabId, { ...tab, loadState });
  return changed(state, { tabsById });
}

function resolveLoadState(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  generation: number,
  outcome: Exclude<
    WorkspaceTabLoadState,
    { kind: "idle" | "loading" }
  >,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (
    !tab ||
    tab.loadState.kind !== "loading" ||
    tab.loadState.generation !== generation ||
    outcome.generation !== generation
  ) {
    return state;
  }
  const tabsById = new Map(state.tabsById);
  tabsById.set(tabId, { ...tab, loadState: outcome });
  return changed(state, { tabsById });
}

function moveTab(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  toIndex: number,
): WorkspaceTabCollection {
  const fromIndex = state.orderedTabIds.indexOf(tabId);
  if (fromIndex < 0 || state.orderedTabIds.length < 2) return state;
  const target = Math.max(
    0,
    Math.min(Math.trunc(toIndex), state.orderedTabIds.length - 1),
  );
  if (target === fromIndex) return state;
  const orderedTabIds = [...state.orderedTabIds];
  orderedTabIds.splice(fromIndex, 1);
  orderedTabIds.splice(target, 0, tabId);
  return changed(state, { orderedTabIds });
}

function closeTab(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  closedAt: number,
  view: WorkspaceTabViewState | null,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (!tab) return state;
  const closingIndex = state.orderedTabIds.indexOf(tabId);
  const orderedTabIds = state.orderedTabIds.filter(
    (candidate) => candidate !== tabId,
  );
  const tabsById = new Map(state.tabsById);
  const pathIndex = new Map(state.pathIndex);
  tabsById.delete(tabId);
  pathIndex.delete(tab.relativePath);
  const nextActive =
    state.activeTabId === tabId
      ? orderedTabIds[
          Math.min(Math.max(closingIndex, 0), orderedTabIds.length - 1)
        ] ?? null
      : state.activeTabId;
  const closed: RecentlyClosedWorkspaceTab = {
    workspaceId: tab.workspaceId,
    relativePath: tab.relativePath,
    displayName: tab.displayName,
    parentHint: tab.parentHint,
    view,
    closedAt,
  };
  const recentlyClosed = [
    closed,
    ...state.recentlyClosed.filter(
      (candidate) => candidate.relativePath !== tab.relativePath,
    ),
  ].slice(0, RECENTLY_CLOSED_TAB_LIMIT);
  return changed(state, {
    orderedTabIds,
    activeTabId: nextActive,
    tabsById,
    pathIndex,
    recentlyClosed,
  });
}

function restoreClosedTab(
  state: WorkspaceTabCollection,
  relativePath: WorkspaceRelativePath,
  tabId: WorkspaceTabId,
  activatedAt: number,
): WorkspaceTabCollection {
  const closed = state.recentlyClosed.find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (!closed) return state;
  return openTab(
    state,
    createWorkspaceTabDescriptor({
      tabId,
      workspaceId: state.workspaceId,
      relativePath,
      restoredView: closed.view,
      lastActivatedAt: activatedAt,
    }),
  );
}

function markPersisted(
  state: WorkspaceTabCollection,
  revision: number,
): WorkspaceTabCollection {
  if (
    revision < state.persistedRevision ||
    revision > state.revision ||
    revision === state.persistedRevision
  ) {
    return state;
  }
  return { ...state, persistedRevision: revision };
}

function changed(
  state: WorkspaceTabCollection,
  patch: Partial<Omit<WorkspaceTabCollection, "workspaceId" | "revision">>,
): WorkspaceTabCollection {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1,
  };
}
