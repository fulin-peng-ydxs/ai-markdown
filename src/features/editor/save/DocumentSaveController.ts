import type { DesktopError } from "../../../services/desktop/contracts";
import { normalizeDesktopError } from "../../../services/desktop/errors";
import {
  beginDocumentRecoverySnapshot,
  beginDocumentSave,
  completeDocumentRecoverySnapshot,
  completeDocumentSave,
  failDocumentRecoverySnapshot,
  failDocumentSave,
  markDocumentConflict,
  type ReadyDocumentSession,
  type SessionMutationResult,
} from "../documentSession";
import type {
  EditorRecoveryGateway,
  EditorSaveGateway,
} from "../editorGateway";

const MIB = 1024 * 1024;

export const SAVE_DEBOUNCE_SMALL_MS = 800;
export const SAVE_DEBOUNCE_MEDIUM_MS = 2_000;
export const SAVE_DEBOUNCE_LARGE_MS = 5_000;
export const RECOVERY_DEBOUNCE_MS = 2_000;
export const RECOVERY_LARGE_DEBOUNCE_MS = 10_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface DocumentSaveClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface DocumentSaveControllerOptions {
  getSession(): ReadyDocumentSession | null;
  onSessionChange(session: ReadyDocumentSession): void;
  saveGateway: EditorSaveGateway;
  recoveryGateway: EditorRecoveryGateway;
  clock?: DocumentSaveClock;
  createRequestId?: () => string;
}

export type DocumentSaveOutcome =
  | { status: "saved" | "already_safe" }
  | { status: "blocked"; reason: "readonly" | "conflict" | "failed" | "stale" };

export class DocumentSaveController {
  private readonly options: DocumentSaveControllerOptions;
  private readonly clock: DocumentSaveClock;
  private readonly createRequestId: () => string;
  private saveTimer: TimerHandle | null = null;
  private recoveryTimer: TimerHandle | null = null;
  private activeSave: Promise<DocumentSaveOutcome> | null = null;
  private activeRecovery: Promise<void> | null = null;
  private recoveryStarting = false;
  private pendingSave = false;
  private pendingRecovery = false;
  private activeIdentity: string | null = null;
  private lastRecoveryEditVersion = -1;
  private lastRecoveryAttemptEditVersion = -1;
  private activeRegistered = false;
  private registrationIdentity: string | null = null;
  private activeRegistration: Promise<boolean> | null = null;
  private disposed = false;

  constructor(options: DocumentSaveControllerOptions) {
    this.options = options;
    this.clock = options.clock ?? browserClock;
    this.createRequestId =
      options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  }

  observe(session: ReadyDocumentSession | null): void {
    if (this.disposed) return;
    const identity = session ? documentIdentity(session) : null;
    if (identity !== this.activeIdentity) {
      const previous = this.activeIdentity;
      this.clearTimers();
      this.pendingSave = false;
      this.pendingRecovery = false;
      this.activeIdentity = identity;
      this.lastRecoveryEditVersion = -1;
      this.lastRecoveryAttemptEditVersion = -1;
      this.activeRegistered = false;
      if (previous) void this.releaseIdentity(previous);
    }
    if (!session) return;
    const byteLength = utf8ByteLength(session.markdown);

    if (requiresProtection(session)) {
      if (!this.activeRegistered) void this.ensureActive(session);
      this.scheduleRecovery(session, byteLength);
    }
    if (session.saveState.kind === "dirty") {
      this.scheduleAutomaticSave(session, byteLength);
    } else if (session.saveState.kind === "saving") {
      this.pendingSave ||= session.saveState.changedAfterStart;
    } else if (
      session.saveState.kind === "clean" ||
      session.saveState.kind === "saved" ||
      session.saveState.kind === "readonly"
    ) {
      this.clearSaveTimer();
      this.clearRecoveryTimer();
    }
  }

  manualSave(): Promise<DocumentSaveOutcome> {
    this.clearSaveTimer();
    return this.requestSave("manual");
  }

  async settle(): Promise<DocumentSaveOutcome> {
    this.clearSaveTimer();
    let savedAny = false;
    while (true) {
      if (this.activeSave) {
        const activeResult = await this.activeSave;
        if (activeResult.status === "blocked") {
          await this.persistRecovery();
          return activeResult;
        }
        savedAny ||= activeResult.status === "saved";
        continue;
      }
      const current = this.options.getSession();
      if (!current || isSafeToClose(current)) {
        await this.releaseCurrentIfSafe();
        return { status: savedAny ? "saved" : "already_safe" };
      }
      if (current.saveState.kind === "conflict") {
        await this.persistRecovery();
        return { status: "blocked", reason: "conflict" };
      }
      if (current.saveState.kind === "saving") {
        await this.persistRecovery();
        return { status: "blocked", reason: "stale" };
      }
      const result = await this.requestSave("settlement");
      if (result.status === "blocked") {
        await this.persistRecovery();
        return result;
      }
      savedAny ||= result.status === "saved";
    }
  }

  async abandon(): Promise<void> {
    const session = this.options.getSession();
    this.clearTimers();
    if (session) {
      const identity = documentIdentity(session);
      if (identity) await this.releaseIdentity(identity);
    }
    this.activeIdentity = null;
    this.activeRegistered = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private scheduleAutomaticSave(
    session: ReadyDocumentSession,
    byteLength: number,
  ): void {
    this.clearSaveTimer();
    const identity = documentIdentity(session);
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null;
      if (documentIdentity(this.options.getSession()) !== identity) return;
      void this.requestSave("automatic");
    }, saveDebounceForBytes(byteLength));
  }

  private scheduleRecovery(
    session: ReadyDocumentSession,
    byteLength = utf8ByteLength(session.markdown),
  ): void {
    if (
      session.recoveryState.kind === "available" &&
      this.lastRecoveryEditVersion === session.editVersion
    ) {
      return;
    }
    if (
      session.recoveryState.kind === "failed" &&
      this.lastRecoveryAttemptEditVersion === session.editVersion
    ) {
      return;
    }
    if (
      this.recoveryTimer ||
      this.activeRecovery ||
      this.recoveryStarting ||
      session.recoveryState.kind === "persisting"
    ) {
      this.pendingRecovery = true;
      return;
    }
    const identity = documentIdentity(session);
    this.recoveryTimer = this.clock.setTimeout(() => {
      this.recoveryTimer = null;
      if (documentIdentity(this.options.getSession()) !== identity) return;
      void this.persistRecovery();
    }, recoveryDebounceForBytes(byteLength));
  }

  private requestSave(
    trigger: "automatic" | "manual" | "settlement",
  ): Promise<DocumentSaveOutcome> {
    if (this.activeSave) {
      this.pendingSave = true;
      return this.activeSave;
    }
    const session = this.options.getSession();
    if (!session || isSafeToClose(session)) {
      return Promise.resolve({ status: "already_safe" });
    }
    if (session.saveState.kind === "readonly") {
      return Promise.resolve({ status: "blocked", reason: "readonly" });
    }
    if (session.saveState.kind === "conflict") {
      return Promise.resolve({ status: "blocked", reason: "conflict" });
    }
    const requestId = this.createRequestId();
    const started = beginDocumentSave(session, requestId);
    if (started.status !== "applied") {
      return Promise.resolve({
        status: "blocked",
        reason: started.status === "save_in_flight" ? "stale" : "failed",
      });
    }
    this.commit(started);
    const captured = started.session;
    this.activeSave = this.performSave(
      captured,
      requestId,
    ).finally(() => {
      this.activeSave = null;
      const current = this.options.getSession();
      const shouldChase =
        this.pendingSave || current?.saveState.kind === "dirty";
      this.pendingSave = false;
      if (shouldChase && current?.saveState.kind === "dirty" && !this.disposed) {
        void this.requestSave(trigger);
      }
    });
    return this.activeSave;
  }

  private async performSave(
    captured: ReadyDocumentSession,
    requestId: string,
  ): Promise<DocumentSaveOutcome> {
    try {
      const result = await this.options.saveGateway.write(
        captured.workspaceId,
        captured.relativePath,
        captured.markdown,
        captured.diskRevision,
      );
      const current = this.options.getSession();
      if (!sameGeneration(current, captured)) {
        return { status: "blocked", reason: "stale" };
      }
      const completed = completeDocumentSave(
        current,
        requestId,
        result.revision,
        this.clock.now(),
      );
      this.commit(completed);
      const latest = completed.session;
      if (
        latest.saveState.kind === "saved" ||
        latest.saveState.kind === "clean"
      ) {
        await this.removeMatchingRecovery(captured);
      }
      return { status: "saved" };
    } catch (reason) {
      const error = normalizeDesktopError(reason, "safe_write_failed");
      const current = this.options.getSession();
      if (!sameGeneration(current, captured)) {
        return { status: "blocked", reason: "stale" };
      }
      if (error.code === "file_revision_conflict") {
        try {
          const proposal = await this.options.saveGateway.prepareOverwrite(
            captured.workspaceId,
            captured.relativePath,
            current.markdown,
          );
          const conflict = markDocumentConflict(current, requestId, {
            evidenceId: proposal.confirmationId,
            diskRevision: proposal.latestRevision,
          });
          this.commit(conflict);
          return { status: "blocked", reason: "conflict" };
        } catch (proposalReason) {
          const proposalError = normalizeDesktopError(
            proposalReason,
            "editor_save_unavailable",
          );
          this.commit(failDocumentSave(current, requestId, proposalError));
          return { status: "blocked", reason: "failed" };
        }
      }
      this.commit(failDocumentSave(current, requestId, error));
      return { status: "blocked", reason: "failed" };
    }
  }

  private persistRecovery(): Promise<void> {
    if (this.activeRecovery) {
      this.pendingRecovery = true;
      return this.activeRecovery;
    }
    const session = this.options.getSession();
    if (!session || !requiresProtection(session)) return Promise.resolve();
    this.recoveryStarting = true;
    this.activeRecovery = this.performRecovery(session)
      .finally(() => {
        this.activeRecovery = null;
        const current = this.options.getSession();
        const shouldChase =
          this.pendingRecovery && !!current && requiresProtection(current);
        this.pendingRecovery = false;
        if (shouldChase && !this.disposed) this.scheduleRecovery(current);
      });
    this.recoveryStarting = false;
    return this.activeRecovery;
  }

  private async performRecovery(
    requested: ReadyDocumentSession,
  ): Promise<void> {
    const registered = await this.ensureActive(requested);
    const current = this.options.getSession();
    if (!sameGeneration(current, requested) || !requiresProtection(current)) {
      return;
    }
    if (!registered) {
      this.lastRecoveryAttemptEditVersion = current.editVersion;
      this.commit(
        failDocumentRecoverySnapshot(
          current,
          fallbackRecoveryError("recovery_unavailable"),
        ),
      );
      return;
    }

    const started = beginDocumentRecoverySnapshot(current);
    this.lastRecoveryAttemptEditVersion = current.editVersion;
    this.commit(started);
    const captured = started.session;
    try {
      const result = await this.options.recoveryGateway.upsert(
        captured.workspaceId,
        captured.relativePath,
        captured.markdown,
        captured.diskRevision,
      );
      const latest = this.options.getSession();
      if (!sameGeneration(latest, captured)) return;
      if (result.status === "persisted" && result.snapshot) {
        if (!requiresProtection(latest)) {
          void this.options.recoveryGateway
            .delete(result.snapshot.snapshotId, latest.workspaceId)
            .catch(() => false);
          return;
        }
        this.lastRecoveryEditVersion = captured.editVersion;
        this.commit(
          completeDocumentRecoverySnapshot(
            latest,
            result.snapshot.snapshotId,
            latest.editVersion === captured.editVersion,
          ),
        );
      } else {
        this.commit(
          failDocumentRecoverySnapshot(
            latest,
            result.issue ?? fallbackRecoveryError("recovery_unavailable"),
          ),
        );
      }
    } catch (reason) {
      const latest = this.options.getSession();
      if (!sameGeneration(latest, captured)) return;
      this.commit(
        failDocumentRecoverySnapshot(
          latest,
          normalizeDesktopError(reason, "recovery_write_failed"),
        ),
      );
    }
  }

  private async ensureActive(
    session: ReadyDocumentSession,
  ): Promise<boolean> {
    const identity = documentIdentity(session);
    if (this.activeIdentity !== identity) this.activeIdentity = identity;
    if (this.activeRegistered && this.activeIdentity === identity) {
      return true;
    }
    if (this.activeRegistration && this.registrationIdentity === identity) {
      return this.activeRegistration;
    }
    this.registrationIdentity = identity;
    this.activeRegistration = this.options.recoveryGateway
      .registerActive(session.workspaceId, session.relativePath)
      .then(() => {
        if (this.activeIdentity === identity) {
          this.activeRegistered = true;
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        if (this.registrationIdentity === identity) {
          this.activeRegistration = null;
          this.registrationIdentity = null;
        }
      });
    return this.activeRegistration;
  }

  private async removeMatchingRecovery(
    saved: ReadyDocumentSession,
  ): Promise<void> {
    const current = this.options.getSession();
    const snapshotId =
      current?.recoveryState.kind === "available"
        ? current.recoveryState.snapshotId
        : saved.recoveryState.kind === "available"
          ? saved.recoveryState.snapshotId
          : null;
    const identity = documentIdentity(saved);
    if (identity) await this.releaseIdentity(identity);
    if (this.activeIdentity === identity) {
      this.activeRegistered = false;
    }
    if (snapshotId) {
      await this.options.recoveryGateway
        .delete(snapshotId, saved.workspaceId)
        .catch(() => false);
    }
  }

  private async releaseCurrentIfSafe(): Promise<void> {
    const current = this.options.getSession();
    if (!current) return;
    const identity = documentIdentity(current);
    if (identity) await this.releaseIdentity(identity);
    if (this.activeIdentity === identity) {
      this.activeRegistered = false;
    }
  }

  private async releaseIdentity(identity: string): Promise<void> {
    if (this.registrationIdentity === identity && this.activeRegistration) {
      await this.activeRegistration;
    }
    const [workspaceId, ...path] = identity.split("\u0000");
    await this.options.recoveryGateway
      .releaseActive(workspaceId, path.join("\u0000"))
      .catch(() => false);
  }

  private commit(result: SessionMutationResult): void {
    if (result.status === "applied") this.options.onSessionChange(result.session);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) this.clock.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) this.clock.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private clearTimers(): void {
    this.clearSaveTimer();
    this.clearRecoveryTimer();
  }
}

export function saveDebounceFor(markdown: string): number {
  return saveDebounceForBytes(utf8ByteLength(markdown));
}

export function saveDebounceForBytes(bytes: number): number {
  if (bytes <= 5 * MIB) return SAVE_DEBOUNCE_SMALL_MS;
  if (bytes <= 20 * MIB) return SAVE_DEBOUNCE_MEDIUM_MS;
  return SAVE_DEBOUNCE_LARGE_MS;
}

export function recoveryDebounceFor(markdown: string): number {
  return recoveryDebounceForBytes(utf8ByteLength(markdown));
}

export function recoveryDebounceForBytes(bytes: number): number {
  return bytes > 5 * MIB
    ? RECOVERY_LARGE_DEBOUNCE_MS
    : RECOVERY_DEBOUNCE_MS;
}

export function utf8ByteLength(markdown: string): number {
  let bytes = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = markdown.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function requiresProtection(session: ReadyDocumentSession): boolean {
  return (
    session.saveState.kind === "dirty" ||
    session.saveState.kind === "saving" ||
    session.saveState.kind === "save_failed" ||
    session.saveState.kind === "conflict"
  );
}

function isSafeToClose(session: ReadyDocumentSession): boolean {
  return (
    session.saveState.kind === "clean" ||
    session.saveState.kind === "saved" ||
    session.saveState.kind === "readonly"
  );
}

function documentIdentity(
  session: ReadyDocumentSession | null,
): string | null {
  return session
    ? `${session.workspaceId}\u0000${session.relativePath}`
    : null;
}

function sameGeneration(
  current: ReadyDocumentSession | null,
  captured: ReadyDocumentSession,
): current is ReadyDocumentSession {
  return (
    current !== null &&
    current.generation === captured.generation &&
    current.workspaceId === captured.workspaceId &&
    current.relativePath === captured.relativePath
  );
}

function fallbackRecoveryError(code: DesktopError["code"]): DesktopError {
  return {
    code,
    messageKey: `error.desktop.${code}`,
    pathHint: null,
    contentSafe: true,
    retryable: true,
  };
}

const browserClock: DocumentSaveClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};
