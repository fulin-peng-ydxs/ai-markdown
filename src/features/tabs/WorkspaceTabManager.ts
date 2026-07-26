import type {
  DesktopError,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import { normalizeDesktopError } from "../../services/desktop/errors";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  type DocumentSessionState,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import {
  applyDocumentLoadOutcome,
  requestDocumentLoad,
} from "../editor/editorGateway";
import {
  DocumentSaveController,
  type DocumentSaveOutcome,
} from "../editor/save/DocumentSaveController";
import {
  createWorkspaceTabCollection,
  reduceWorkspaceTabs,
  selectActiveWorkspaceTabProjection,
  type WorkspaceTabCollection,
} from "./tabReducer";
import { acceptWorkspaceTabPath } from "./tabPath";
import type { WorkspaceTabPathIdentity } from "./tabPath";
import type { WorkspaceTabSessionGateway } from "./tabSessionGateway";
import type {
  WorkspaceTabDescriptor,
  WorkspaceTabId,
  WorkspaceTabRuntime,
  WorkspaceTabViewState,
} from "./tabTypes";

export interface WorkspaceTabManagerSnapshot {
  collection: WorkspaceTabCollection;
  runtimes: ReadonlyMap<WorkspaceTabId, WorkspaceTabRuntime>;
  activeTab: WorkspaceTabDescriptor | null;
  activeRuntime: WorkspaceTabRuntime | null;
}

export interface WorkspaceTabOpenOptions {
  writable: boolean;
  restoredView?: WorkspaceTabViewState | null;
  activatedAt?: number;
}

export interface WorkspaceTabManagerOptions {
  workspaceId: WorkspaceId;
  gateway: WorkspaceTabSessionGateway;
  now?: () => number;
  createTabId?: () => WorkspaceTabId;
  captureActiveProjection?: () => ReadyDocumentSession | null;
  createSaveController?: (
    options: ConstructorParameters<typeof DocumentSaveController>[0],
  ) => DocumentSaveController;
}

export type WorkspaceTabOpenResult =
  | { status: "opened" | "focused"; tabId: WorkspaceTabId }
  | { status: "failed"; error: DesktopError };

export interface WorkspaceTabSettlementResult {
  status: "settled" | "blocked";
  blockedTabId?: WorkspaceTabId;
  outcome?: DocumentSaveOutcome;
}

export interface WorkspaceTabAdapterLifecycle {
  activeCount: number;
  peakActiveCount: number;
  mounts: number;
  unmounts: number;
  violations: number;
}

type Listener = (snapshot: WorkspaceTabManagerSnapshot) => void;

interface ManagedRuntime extends WorkspaceTabRuntime {
  saveController: DocumentSaveController;
}

/**
 * Owns per-tab document runtimes while the serializable reducer remains content
 * free. UI code renders only `activeRuntime`; inactive runtimes retain their
 * session/history and keep their own save/recovery controller alive.
 */
export class WorkspaceTabManager {
  private readonly options: WorkspaceTabManagerOptions;
  private readonly now: () => number;
  private readonly createTabId: () => WorkspaceTabId;
  private readonly createSaveController: NonNullable<
    WorkspaceTabManagerOptions["createSaveController"]
  >;
  private collection: WorkspaceTabCollection;
  private readonly runtimes = new Map<WorkspaceTabId, ManagedRuntime>();
  private readonly listeners = new Set<Listener>();
  private destroyed = false;
  private activeAdapterToken: string | null = null;
  private adapterLifecycle: WorkspaceTabAdapterLifecycle = {
    activeCount: 0,
    peakActiveCount: 0,
    mounts: 0,
    unmounts: 0,
    violations: 0,
  };

  constructor(options: WorkspaceTabManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.createTabId =
      options.createTabId ?? (() => globalThis.crypto.randomUUID());
    this.createSaveController =
      options.createSaveController ??
      ((controllerOptions) => new DocumentSaveController(controllerOptions));
    this.collection = createWorkspaceTabCollection(options.workspaceId);
  }

  snapshot(): WorkspaceTabManagerSnapshot {
    const active = selectActiveWorkspaceTabProjection(
      this.collection,
      this.runtimes,
    );
    return {
      collection: this.collection,
      runtimes: new Map(this.runtimes),
      activeTab: active?.tab ?? null,
      activeRuntime: active?.runtime ?? null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async open(
    relativePath: WorkspaceRelativePath,
    options: WorkspaceTabOpenOptions,
  ): Promise<WorkspaceTabOpenResult> {
    if (this.destroyed) {
      return {
        status: "failed",
        error: managerError("tab_manager_destroyed", relativePath),
      };
    }
    try {
      const contract = acceptWorkspaceTabPath(
        await this.options.gateway.resolvePath(
          this.collection.workspaceId,
          relativePath,
        ),
      );
      const existingTabId = this.collection.pathIndex.get(contract.identity);
      this.captureCurrentProjection();
      if (existingTabId) {
        this.dispatch({
          type: "activate",
          tabId: existingTabId,
          activatedAt: options.activatedAt ?? this.now(),
        });
        const existing = this.collection.tabsById.get(existingTabId);
        if (existing?.loadState.kind === "idle") {
          await this.load(existingTabId, options.writable);
        }
        return { status: "focused", tabId: existingTabId };
      }

      const requestedTabId = this.createTabId();
      this.dispatch({
        type: "open",
        tab: {
          tabId: requestedTabId,
          workspaceId: this.collection.workspaceId,
          path: contract,
          lastActivatedAt: options.activatedAt ?? this.now(),
          restoredView: options.restoredView ?? null,
        },
      });
      const tabId =
        this.collection.pathIndex.get(contract.identity) ?? requestedTabId;
      await this.load(tabId, options.writable);
      return {
        status: tabId === requestedTabId ? "opened" : "focused",
        tabId,
      };
    } catch (reason) {
      return {
        status: "failed",
        error: normalizeDesktopError(reason, "invalid_relative_path"),
      };
    }
  }

  activate(tabId: WorkspaceTabId, activatedAt = this.now()): boolean {
    if (this.destroyed || !this.collection.tabsById.has(tabId)) return false;
    if (this.collection.activeTabId !== tabId) this.captureCurrentProjection();
    this.dispatch({ type: "activate", tabId, activatedAt });
    return true;
  }

  move(tabId: WorkspaceTabId, toIndex: number): boolean {
    if (this.destroyed || !this.collection.tabsById.has(tabId)) return false;
    const previous = this.collection;
    this.dispatch({ type: "move", tabId, toIndex });
    return this.collection !== previous;
  }

  async reopenRecentlyClosed(
    pathIdentity: WorkspaceTabPathIdentity,
    options: Omit<WorkspaceTabOpenOptions, "restoredView">,
  ): Promise<WorkspaceTabOpenResult> {
    const recent = this.collection.recentlyClosed.find(
      (candidate) => candidate.pathIdentity === pathIdentity,
    );
    if (!recent) {
      return {
        status: "failed",
        error: managerError("recent_tab_not_found", null),
      };
    }
    return this.open(recent.relativePath, {
      ...options,
      restoredView: recent.view,
    });
  }

  discardRecentlyClosed(pathIdentity: WorkspaceTabPathIdentity): boolean {
    if (this.destroyed) return false;
    const previous = this.collection;
    this.dispatch({ type: "discard_closed", pathIdentity });
    return this.collection !== previous;
  }

  markPersisted(revision: number): boolean {
    if (this.destroyed) return false;
    const previous = this.collection;
    this.dispatch({ type: "mark_persisted", revision });
    return this.collection !== previous;
  }

  updateSession(
    tabId: WorkspaceTabId,
    incarnation: number,
    session: DocumentSessionState,
  ): boolean {
    const tab = this.collection.tabsById.get(tabId);
    const runtime = this.runtimes.get(tabId);
    if (
      this.destroyed ||
      !tab ||
      !runtime ||
      tab.incarnation !== incarnation ||
      runtime.incarnation !== incarnation
    ) {
      return false;
    }
    runtime.session = session;
    runtime.saveController.observe(session.status === "ready" ? session : null);
    this.emit();
    return true;
  }

  updateActiveSession(session: DocumentSessionState): boolean {
    const tabId = this.collection.activeTabId;
    const tab = tabId ? this.collection.tabsById.get(tabId) : null;
    return tab ? this.updateSession(tab.tabId, tab.incarnation, session) : false;
  }

  activeSaveController(): DocumentSaveController | null {
    const tabId = this.collection.activeTabId;
    return tabId ? this.runtimes.get(tabId)?.saveController ?? null : null;
  }

  async reload(
    tabId: WorkspaceTabId,
    writable: boolean,
  ): Promise<boolean> {
    const tab = this.collection.tabsById.get(tabId);
    if (!tab || this.destroyed) return false;
    await this.load(tabId, writable);
    return true;
  }

  async close(
    tabId: WorkspaceTabId,
    view?: WorkspaceTabViewState | null,
    closedAt = this.now(),
    settlementAlreadySatisfied = false,
  ): Promise<WorkspaceTabSettlementResult> {
    const tab = this.collection.tabsById.get(tabId);
    if (!tab || this.destroyed) return { status: "settled" };
    if (this.collection.activeTabId === tabId) this.captureCurrentProjection();
    const runtime = this.runtimes.get(tabId);
    const closingView =
      view === undefined ? viewFromSession(runtime?.session ?? null) : view;
    if (runtime) {
      if (!settlementAlreadySatisfied) {
        const outcome = await runtime.saveController.settle();
        if (outcome.status === "blocked") {
          return { status: "blocked", blockedTabId: tabId, outcome };
        }
      }
      await runtime.saveController.abandon();
      runtime.saveController.dispose();
      this.runtimes.delete(tabId);
    }
    this.dispatch({
      type: "close",
      tabId,
      closedAt,
      view: closingView,
    });
    return { status: "settled" };
  }

  async settleAll(): Promise<WorkspaceTabSettlementResult> {
    this.captureCurrentProjection();
    for (const tabId of this.collection.orderedTabIds) {
      const runtime = this.runtimes.get(tabId);
      if (!runtime) continue;
      const outcome = await runtime.saveController.settle();
      if (outcome.status === "blocked") {
        return { status: "blocked", blockedTabId: tabId, outcome };
      }
    }
    return { status: "settled" };
  }

  async destroy(): Promise<WorkspaceTabSettlementResult> {
    if (this.destroyed) return { status: "settled" };
    const settlement = await this.settleAll();
    if (settlement.status === "blocked") return settlement;
    this.destroyed = true;
    for (const runtime of this.runtimes.values()) {
      await runtime.saveController.abandon();
      runtime.saveController.dispose();
    }
    this.runtimes.clear();
    this.listeners.clear();
    this.activeAdapterToken = null;
    this.adapterLifecycle = {
      ...this.adapterLifecycle,
      activeCount: 0,
    };
    return { status: "settled" };
  }

  noteAdapterMounted(
    tabId: WorkspaceTabId,
    incarnation: number,
    mode: "visual" | "source",
  ): void {
    const active = this.collection.activeTabId;
    const tab = this.collection.tabsById.get(tabId);
    const token = `${tabId}\u0000${incarnation}\u0000${mode}`;
    if (
      active !== tabId ||
      tab?.incarnation !== incarnation ||
      (this.activeAdapterToken && this.activeAdapterToken !== token)
    ) {
      this.adapterLifecycle = {
        ...this.adapterLifecycle,
        violations: this.adapterLifecycle.violations + 1,
      };
      return;
    }
    if (this.activeAdapterToken === token) return;
    this.activeAdapterToken = token;
    const activeCount = this.adapterLifecycle.activeCount + 1;
    this.adapterLifecycle = {
      ...this.adapterLifecycle,
      activeCount,
      peakActiveCount: Math.max(
        this.adapterLifecycle.peakActiveCount,
        activeCount,
      ),
      mounts: this.adapterLifecycle.mounts + 1,
    };
  }

  noteAdapterUnmounted(
    tabId: WorkspaceTabId,
    incarnation: number,
    mode: "visual" | "source",
  ): void {
    const token = `${tabId}\u0000${incarnation}\u0000${mode}`;
    if (this.activeAdapterToken !== token) return;
    this.activeAdapterToken = null;
    this.adapterLifecycle = {
      ...this.adapterLifecycle,
      activeCount: Math.max(0, this.adapterLifecycle.activeCount - 1),
      unmounts: this.adapterLifecycle.unmounts + 1,
    };
  }

  adapterLifecycleSnapshot(): WorkspaceTabAdapterLifecycle {
    return { ...this.adapterLifecycle };
  }

  private async load(tabId: WorkspaceTabId, writable: boolean): Promise<void> {
    const tab = this.collection.tabsById.get(tabId);
    if (!tab || this.destroyed) return;
    const incarnation = tab.incarnation;
    const previous = this.runtimes.get(tabId)?.session ??
      createEmptyDocumentSession();
    const loading = beginDocumentLoad(previous, {
      workspaceId: tab.workspaceId,
      relativePath: tab.relativePath,
    });
    let runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.incarnation !== incarnation) {
      runtime?.saveController.dispose();
      runtime = this.createRuntime(tabId, incarnation, loading);
      this.runtimes.set(tabId, runtime);
    } else {
      runtime.session = loading;
    }
    this.dispatch({
      type: "begin_load",
      tabId,
      incarnation,
      generation: loading.generation,
    });
    this.emit();

    const outcome = await requestDocumentLoad(
      {
        generation: loading.generation,
        workspaceId: tab.workspaceId,
        relativePath: tab.relativePath,
        writable,
      },
      this.options.gateway,
      this.options.gateway.parser,
    );
    const currentTab = this.collection.tabsById.get(tabId);
    const currentRuntime = this.runtimes.get(tabId);
    if (
      this.destroyed ||
      currentTab?.incarnation !== incarnation ||
      currentRuntime?.incarnation !== incarnation ||
      currentRuntime.session.status !== "loading" ||
      currentRuntime.session.generation !== loading.generation
    ) {
      return;
    }
    let resolved = applyDocumentLoadOutcome(currentRuntime.session, outcome);
    if (resolved.status === "ready" && currentTab.restoredView) {
      resolved = applyRestoredView(resolved, currentTab.restoredView);
    }
    currentRuntime.session = resolved;
    currentRuntime.saveController.observe(
      resolved.status === "ready" ? resolved : null,
    );
    this.dispatch({
      type: "resolve_load",
      tabId,
      incarnation,
      generation: loading.generation,
      outcome: loadOutcome(resolved, loading.generation),
    });
    this.emit();
  }

  private createRuntime(
    tabId: WorkspaceTabId,
    incarnation: number,
    session: DocumentSessionState,
  ): ManagedRuntime {
    const runtime = {
      incarnation,
      session,
      saveController: null as unknown as DocumentSaveController,
    };
    runtime.saveController = this.createSaveController({
      getSession: () => {
        const current = this.runtimes.get(tabId);
        return current?.incarnation === incarnation &&
          current.session.status === "ready"
          ? current.session
          : null;
      },
      onSessionChange: (next) => {
        this.updateSession(tabId, incarnation, next);
      },
      saveGateway: this.options.gateway.saveGateway,
      recoveryGateway: this.options.gateway.recoveryGateway,
    });
    return runtime;
  }

  private captureCurrentProjection(): void {
    const projected = this.options.captureActiveProjection?.();
    if (projected) this.updateActiveSession(projected);
  }

  private dispatch(
    action: Parameters<typeof reduceWorkspaceTabs>[1],
  ): void {
    const next = reduceWorkspaceTabs(this.collection, action);
    if (next === this.collection) return;
    this.collection = next;
    this.emit();
  }

  private emit(): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function loadOutcome(
  session: DocumentSessionState,
  generation: number,
): Exclude<
  WorkspaceTabDescriptor["loadState"],
  { kind: "idle" | "loading" }
> {
  if (session.status === "ready" || session.status === "empty") {
    return { kind: "ready", generation };
  }
  const error =
    session.status === "unavailable" && session.error
      ? session.error
      : managerError(
          session.status === "unavailable"
            ? session.reason
            : "document_load_failed",
          session.status === "loading" ? session.relativePath : null,
        );
  if (error.code === "path_not_found") {
    return { kind: "missing", generation, error };
  }
  if (error.code === "permission_denied") {
    return { kind: "permission_denied", generation, error };
  }
  return { kind: "error", generation, error };
}

function viewFromSession(
  session: DocumentSessionState | null,
): WorkspaceTabViewState | null {
  return session?.status === "ready"
    ? {
        mode: session.mode,
        selection: session.selection,
        anchor: session.anchor,
      }
    : null;
}

function applyRestoredView(
  session: ReadyDocumentSession,
  view: WorkspaceTabViewState,
): ReadyDocumentSession {
  if (
    view.mode === "visual" &&
    session.compatibility.mode === "source-only"
  ) {
    return session;
  }
  return {
    ...session,
    mode: view.mode,
    selection: view.selection,
    anchor: view.anchor,
  };
}

function managerError(
  messageKey: string,
  pathHint: WorkspaceRelativePath | null,
): DesktopError {
  return {
    code: "io_failure",
    messageKey,
    pathHint,
    contentSafe: true,
    retryable: true,
  };
}
