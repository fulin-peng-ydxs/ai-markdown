import type {
  DesktopError,
  DesktopErrorCode,
  WindowTabSession,
  WindowTabSessionSaveResult,
  WindowTabSessionSnapshot,
  WorkspaceId,
} from "../../services/desktop/contracts";
import { normalizeDesktopError } from "../../services/desktop/errors";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import {
  workspaceTabsNeedPersistence,
} from "./tabReducer";
import { projectWindowTabSessionSnapshot } from "./tabSessionProjection";

const PERSISTENCE_DEBOUNCE_MS = 180;

export interface WorkspaceTabPersistenceGateway {
  get(
    workspaceId: WorkspaceId,
    windowStateRef?: string | null,
  ): Promise<WindowTabSession>;
  save(
    workspaceId: WorkspaceId,
    windowStateRef: string | null,
    expectedRevision: number,
    snapshot: WindowTabSessionSnapshot,
  ): Promise<WindowTabSessionSaveResult>;
}

interface WorkspaceTabSessionPersistenceOptions {
  workspaceId: WorkspaceId;
  gateway: WorkspaceTabPersistenceGateway;
  markPersisted(revision: number): void;
  onError(error: DesktopError): void;
  now?: () => number;
}

export type WorkspaceTabPersistenceStatus =
  | "initializing"
  | "ready"
  | "deferred_existing_session"
  | "failed"
  | "disposed";

/**
 * Persists only content-free tab metadata. An existing repository remains
 * frozen until its resolved session has been consumed by the tab manager; this
 * prevents an empty startup collection from erasing recoverable metadata.
 */
export class WorkspaceTabSessionPersistence {
  private readonly options: WorkspaceTabSessionPersistenceOptions;
  private readonly now: () => number;
  private latest: WorkspaceTabManagerSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private windowStateRef: string | null = null;
  private repositoryRevision = 0;
  private deferredSession: WindowTabSession | null = null;
  private status: WorkspaceTabPersistenceStatus = "initializing";

  constructor(options: WorkspaceTabSessionPersistenceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  currentStatus(): WorkspaceTabPersistenceStatus {
    return this.status;
  }

  pendingRestore(): WindowTabSession | null {
    return this.status === "deferred_existing_session"
      ? this.deferredSession
      : null;
  }

  observe(snapshot: WorkspaceTabManagerSnapshot): void {
    this.latest = snapshot;
    if (this.status === "ready") this.schedule();
  }

  async initialize(): Promise<WorkspaceTabPersistenceStatus> {
    if (this.status !== "initializing") return this.status;
    try {
      const stored = await this.options.gateway.get(this.options.workspaceId);
      if (this.isDisposed()) return this.status;
      this.windowStateRef = stored.windowStateRef;
      this.repositoryRevision = stored.revision;
      if (
        stored.revision > 0 ||
        stored.tabs.length > 0 ||
        stored.recentlyClosed.length > 0 ||
        stored.issues.length > 0
      ) {
        this.deferredSession = stored;
        this.status = "deferred_existing_session";
        return this.status;
      }
      this.deferredSession = null;
      this.status = "ready";
      this.schedule();
      return this.status;
    } catch (reason) {
      if (this.isDisposed()) return this.status;
      this.fail(reason, "window_session_read_failed");
      return this.status;
    }
  }

  resumeAfterRestore(snapshot: WorkspaceTabManagerSnapshot): boolean {
    if (
      this.status !== "deferred_existing_session" ||
      !this.deferredSession ||
      snapshot.collection.workspaceId !== this.options.workspaceId
    ) {
      return false;
    }
    this.deferredSession = null;
    this.latest = snapshot;
    this.status = "ready";
    this.schedule();
    return true;
  }

  async flush(): Promise<boolean> {
    if (
      this.status !== "ready" ||
      this.inFlight ||
      !this.latest ||
      !workspaceTabsNeedPersistence(this.latest.collection)
    ) {
      return false;
    }
    this.clearTimer();
    const sent = this.latest;
    const sentRevision = sent.collection.revision;
    this.inFlight = true;
    try {
      const saved = await this.options.gateway.save(
        this.options.workspaceId,
        this.windowStateRef,
        this.repositoryRevision,
        projectWindowTabSessionSnapshot(sent, this.now()),
      );
      if (this.isDisposed()) return false;
      this.windowStateRef = saved.windowStateRef;
      this.repositoryRevision = saved.revision;
      this.options.markPersisted(sentRevision);
      return true;
    } catch (reason) {
      if (!this.isDisposed()) this.fail(reason, "window_session_write_failed");
      return false;
    } finally {
      this.inFlight = false;
      if (
        this.status === "ready" &&
        this.latest &&
        this.latest.collection.revision > sentRevision
      ) {
        this.schedule();
      }
    }
  }

  dispose(): void {
    this.clearTimer();
    this.status = "disposed";
    this.latest = null;
    this.deferredSession = null;
  }

  private schedule(): void {
    if (
      this.timer ||
      this.inFlight ||
      !this.latest ||
      !workspaceTabsNeedPersistence(this.latest.collection)
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PERSISTENCE_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(reason: unknown, fallbackCode: DesktopErrorCode): void {
    this.status = "failed";
    this.clearTimer();
    this.options.onError(
      normalizeDesktopError(reason, fallbackCode),
    );
  }

  private isDisposed(): boolean {
    return this.status === "disposed";
  }
}
