import type { WorkspaceId } from "../../services/desktop/contracts";
import {
  createWorkspaceTabDescriptor,
  deriveWorkspaceTabPathPresentation,
  type RecentlyClosedWorkspaceTab,
  type WorkspaceTabDescriptor,
  type WorkspaceTabId,
  type WorkspaceTabLoadState,
  type WorkspaceTabOpenRequest,
  type WorkspaceTabProjection,
  type WorkspaceTabRecoveryDescriptor,
  type WorkspaceTabRuntime,
  type WorkspaceTabViewState,
} from "./tabTypes";
import {
  isValidWorkspaceTabPath,
  type WorkspaceTabPathIdentity,
} from "./tabPath";

export const RECENTLY_CLOSED_TAB_LIMIT = 50;

export interface WorkspaceTabCollection {
  workspaceId: WorkspaceId;
  orderedTabIds: readonly WorkspaceTabId[];
  activeTabId: WorkspaceTabId | null;
  tabsById: ReadonlyMap<WorkspaceTabId, WorkspaceTabDescriptor>;
  pathIndex: ReadonlyMap<WorkspaceTabPathIdentity, WorkspaceTabId>;
  recentlyClosed: readonly RecentlyClosedWorkspaceTab[];
  nextIncarnation: number;
  revision: number;
  persistedRevision: number;
}

export type WorkspaceTabAction =
  | { type: "open"; tab: WorkspaceTabOpenRequest }
  | { type: "activate"; tabId: WorkspaceTabId; activatedAt: number }
  | {
      type: "begin_load";
      tabId: WorkspaceTabId;
      incarnation: number;
      generation: number;
    }
  | {
      type: "resolve_load";
      tabId: WorkspaceTabId;
      incarnation: number;
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
      pathIdentity: WorkspaceTabPathIdentity;
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
    nextIncarnation: 1,
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
      return updateLoadState(state, action.tabId, action.incarnation, {
        kind: "loading",
        generation: action.generation,
      });
    case "resolve_load":
      return resolveLoadState(
        state,
        action.tabId,
        action.incarnation,
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
        action.pathIdentity,
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
  if (!tab || tab.tabId !== state.activeTabId) return null;
  const runtime = runtimes.get(state.activeTabId) ?? null;
  return {
    tab,
    runtime:
      runtime?.incarnation === tab.incarnation
        ? runtime
        : null,
  };
}

export function toWorkspaceTabRecoveryDescriptors(
  state: WorkspaceTabCollection,
  runtimes: ReadonlyMap<WorkspaceTabId, WorkspaceTabRuntime>,
): readonly WorkspaceTabRecoveryDescriptor[] {
  return state.orderedTabIds.flatMap((tabId) => {
    const tab = state.tabsById.get(tabId);
    if (!tab) return [];
    const runtime = runtimes.get(tabId);
    const session =
      runtime?.incarnation === tab.incarnation ? runtime.session : null;
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
  const incarnations = new Set<number>();
  if (ordered.size !== state.orderedTabIds.length) {
    issues.push("ordered tab ids must be unique");
  }
  if (ordered.size !== state.tabsById.size) {
    issues.push("ordered tab ids must match the tab map");
  }
  for (const [mapTabId, tab] of state.tabsById) {
    if (mapTabId !== tab.tabId) {
      issues.push(`tab map key mismatch: ${mapTabId}`);
    }
    if (!ordered.has(mapTabId)) {
      issues.push(`tab is missing from order: ${mapTabId}`);
    }
    if (tab.workspaceId !== state.workspaceId) {
      issues.push(`tab belongs to another workspace: ${mapTabId}`);
    }
    if (state.pathIndex.get(tab.pathIdentity) !== mapTabId) {
      issues.push(`path index mismatch: ${tab.relativePath}`);
    }
    if (
      !isValidWorkspaceTabPath({
        relativePath: tab.relativePath,
        identity: tab.pathIdentity,
      })
    ) {
      issues.push(`tab path is invalid: ${mapTabId}`);
    }
    if (!hasExpectedPathPresentation(tab)) {
      issues.push(`tab path presentation is invalid: ${mapTabId}`);
    }
    if (incarnations.has(tab.incarnation)) {
      issues.push(`tab incarnation is duplicated: ${tab.incarnation}`);
    }
    incarnations.add(tab.incarnation);
    if (
      tab.incarnation < 1 ||
      tab.incarnation >= state.nextIncarnation
    ) {
      issues.push(`tab incarnation is outside the collection: ${mapTabId}`);
    }
  }
  for (const tabId of state.orderedTabIds) {
    if (!state.tabsById.has(tabId)) {
      issues.push(`missing tab descriptor: ${tabId}`);
    }
  }
  if (state.pathIndex.size !== state.tabsById.size) {
    issues.push("path index must match the tab map size");
  }
  for (const [identity, tabId] of state.pathIndex) {
    const tab = state.tabsById.get(tabId);
    if (!tab || tab.pathIdentity !== identity) {
      issues.push(`tab map mismatch: ${identity}`);
    }
  }
  if (state.orderedTabIds.length === 0 && state.activeTabId !== null) {
    issues.push("empty collection must not have an active tab");
  }
  if (
    state.orderedTabIds.length > 0 &&
    (!state.activeTabId || !ordered.has(state.activeTabId))
  ) {
    issues.push("non-empty collection must have a valid active tab");
  }
  if (state.recentlyClosed.length > RECENTLY_CLOSED_TAB_LIMIT) {
    issues.push("recently closed tabs exceed the retention limit");
  }
  const recentIdentities = new Set<WorkspaceTabPathIdentity>();
  for (const recent of state.recentlyClosed) {
    if (recent.workspaceId !== state.workspaceId) {
      issues.push(
        `recent tab belongs to another workspace: ${recent.relativePath}`,
      );
    }
    if (
      !isValidWorkspaceTabPath({
        relativePath: recent.relativePath,
        identity: recent.pathIdentity,
      })
    ) {
      issues.push(`recent tab path is invalid: ${recent.relativePath}`);
    }
    if (!hasExpectedPathPresentation(recent)) {
      issues.push(
        `recent tab path presentation is invalid: ${recent.relativePath}`,
      );
    }
    if (recentIdentities.has(recent.pathIdentity)) {
      issues.push(`recent tab path is duplicated: ${recent.relativePath}`);
    }
    recentIdentities.add(recent.pathIdentity);
    if (state.pathIndex.has(recent.pathIdentity)) {
      issues.push(`open tab remains in recently closed: ${recent.relativePath}`);
    }
  }
  if (
    !Number.isSafeInteger(state.nextIncarnation) ||
    state.nextIncarnation < 1
  ) {
    issues.push("next tab incarnation must be a positive integer");
  }
  if (
    state.persistedRevision < 0 ||
    state.persistedRevision > state.revision
  ) {
    issues.push("persisted revision must be within the current revision");
  }
  return issues;
}

function hasExpectedPathPresentation(input: {
  relativePath: RecentlyClosedWorkspaceTab["relativePath"];
  displayName: string;
  parentHint: RecentlyClosedWorkspaceTab["parentHint"];
}): boolean {
  const expected = deriveWorkspaceTabPathPresentation(input.relativePath);
  return (
    input.displayName === expected.displayName &&
    input.parentHint === expected.parentHint
  );
}

function openTab(
  state: WorkspaceTabCollection,
  request: WorkspaceTabOpenRequest,
): WorkspaceTabCollection {
  if (request.workspaceId !== state.workspaceId) {
    throw new Error("Cannot open a tab from another workspace");
  }
  const existingId = state.pathIndex.get(request.path.identity);
  if (existingId) {
    const activated = activateTab(state, existingId, request.lastActivatedAt);
    const recentlyClosed = activated.recentlyClosed.filter(
      (candidate) => candidate.pathIdentity !== request.path.identity,
    );
    return recentlyClosed.length === activated.recentlyClosed.length
      ? activated
      : activated === state
        ? changed(state, { recentlyClosed })
        : { ...activated, recentlyClosed };
  }
  if (state.tabsById.has(request.tabId)) {
    throw new Error(`Workspace tab id already exists: ${request.tabId}`);
  }
  if (
    !Number.isSafeInteger(state.nextIncarnation) ||
    state.nextIncarnation < 1 ||
    state.nextIncarnation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Workspace tab incarnation sequence is exhausted");
  }
  const tab = createWorkspaceTabDescriptor(request, state.nextIncarnation);
  const tabsById = new Map(state.tabsById);
  const pathIndex = new Map(state.pathIndex);
  tabsById.set(tab.tabId, tab);
  pathIndex.set(tab.pathIdentity, tab.tabId);
  return changed(state, {
    orderedTabIds: [...state.orderedTabIds, tab.tabId],
    activeTabId: tab.tabId,
    tabsById,
    pathIndex,
    nextIncarnation: state.nextIncarnation + 1,
    recentlyClosed: state.recentlyClosed.filter(
      (candidate) => candidate.pathIdentity !== tab.pathIdentity,
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
  incarnation: number,
  loadState: WorkspaceTabLoadState,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (
    !tab ||
    tab.incarnation !== incarnation ||
    loadState.generation <= tab.loadState.generation
  ) {
    return state;
  }
  const tabsById = new Map(state.tabsById);
  tabsById.set(tabId, { ...tab, loadState });
  return changed(state, { tabsById });
}

function resolveLoadState(
  state: WorkspaceTabCollection,
  tabId: WorkspaceTabId,
  incarnation: number,
  generation: number,
  outcome: Exclude<
    WorkspaceTabLoadState,
    { kind: "idle" | "loading" }
  >,
): WorkspaceTabCollection {
  const tab = state.tabsById.get(tabId);
  if (
    !tab ||
    tab.incarnation !== incarnation ||
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
  pathIndex.delete(tab.pathIdentity);
  const nextActive =
    state.activeTabId === tabId
      ? orderedTabIds[
          Math.min(Math.max(closingIndex, 0), orderedTabIds.length - 1)
        ] ?? null
      : state.activeTabId;
  const closed: RecentlyClosedWorkspaceTab = {
    workspaceId: tab.workspaceId,
    relativePath: tab.relativePath,
    pathIdentity: tab.pathIdentity,
    displayName: tab.displayName,
    parentHint: tab.parentHint,
    view,
    closedAt,
  };
  const recentlyClosed = [
    closed,
    ...state.recentlyClosed.filter(
      (candidate) => candidate.pathIdentity !== tab.pathIdentity,
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
  pathIdentity: WorkspaceTabPathIdentity,
  tabId: WorkspaceTabId,
  activatedAt: number,
): WorkspaceTabCollection {
  const closed = state.recentlyClosed.find(
    (candidate) => candidate.pathIdentity === pathIdentity,
  );
  if (!closed) return state;
  return openTab(state, {
    tabId,
    workspaceId: state.workspaceId,
    path: {
      relativePath: closed.relativePath,
      identity: closed.pathIdentity,
    },
    restoredView: closed.view,
    lastActivatedAt: activatedAt,
  });
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
