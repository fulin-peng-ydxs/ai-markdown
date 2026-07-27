import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { AppDialog } from "../../components/AppDialog";
import { AsyncStatePanel } from "../../components/AsyncStatePanel";
import {
  containTabFocus,
  focusContainmentEntry,
} from "../../components/focusContainment";
import type {
  DeleteResult,
  DesktopError,
  FsEntry,
  EditorMenuState,
  RecoverySnapshot,
  RecoverySnapshotMetadata,
  SafeWriteResult,
  WorkspaceDescriptor,
  WorkspaceMoveRisk,
  WorkspaceMutationResult,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceRelativePath,
  WorkspaceSelectionOutcome,
  WorkspaceSelectionProposal,
  WindowSettlementIntent,
  WindowTabSessionPathIssue,
  WorkbenchMenuAction,
} from "../../services/desktop/contracts";
import { desktopErrorMessage, normalizeDesktopError } from "../../services/desktop/errors";
import {
  applyDocumentEdit,
  completeDocumentConflictOverwrite,
  createEmptyDocumentSession,
  markDocumentExternalMissing,
  restoreDocumentRecovery,
  type DocumentSessionState,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import { ConflictDialog } from "../editor/recovery/ConflictDialog";
import { RecoveryDialog } from "../editor/recovery/RecoveryDialog";
import { SaveCopyDialog } from "../editor/recovery/SaveCopyDialog";
import {
  type DocumentSaveController,
  type DocumentSaveOutcome,
} from "../editor/save/DocumentSaveController";
import {
  DocumentEditorShell,
  type DocumentEditorRuntimeState,
  type DocumentEditorShellHandle,
  type DocumentEditorMetrics,
} from "../editor/DocumentEditorShell";
import { DocumentStatusBar } from "../editor/DocumentStatusBar";
import { remarkMarkdownCompatibilityParser } from "../editor/remarkMarkdownParser";
import { assessVisualEditingCompatibility } from "../editor/markdownCompatibility";
import {
  countLocalMarkdownImages,
  rewriteMarkdownImageLinksForMove,
} from "../editor/assets/workspaceAssetPath";
import { PermanentDeleteDialog } from "./PermanentDeleteDialog";
import {
  WorkspaceTabManager,
  type WorkspaceTabOpenResult,
  type WorkspaceTabManagerSnapshot,
} from "../tabs/WorkspaceTabManager";
import { WorkspaceTabBar } from "../tabs/WorkspaceTabBar";
import { TabSettlementDialog } from "../tabs/TabSettlementDialog";
import {
  createWorkspaceTabSettlementBatch,
  projectWorkspaceTabSettlement,
  settlementBatchIsSafe,
  settlementResolutionFor,
  type WorkspaceTabExplicitResolution,
  type WorkspaceTabSettlementBatch,
  type WorkspaceTabSettlementTarget,
} from "../tabs/tabSettlement";
import {
  analyzeWorkspaceTabPathImpact,
  type WorkspaceTabPathImpact,
  type WorkspaceTabPathMutation,
} from "../tabs/tabPathImpact";
import type { WorkspaceTabPathIdentity } from "../tabs/tabPath";
import { WorkspaceTabSessionPersistence } from "../tabs/tabSessionPersistence";
import { workspaceTabsNeedPersistence } from "../tabs/tabReducer";
import type {
  WorkspaceTabId,
  WorkspaceTabSettlementReason,
} from "../tabs/tabTypes";
import type { WorkspaceTabSessionGateway } from "../tabs/tabSessionGateway";
import { WorkspaceOpenDecisionDialog } from "../workspace-open/WorkspaceOpenDecisionDialog";
import { WorkspaceOpenPreferenceDialog } from "../workspace-open/WorkspaceOpenPreferenceDialog";
import { WorkspaceTree } from "./WorkspaceTree";
import { isSameOrInside, parentPath, replacePrefix } from "./workspacePath";
import {
  applyDirectoryScanBatch,
  applyWorkspaceTreeDeleteSuccess,
  applyWorkspaceTreeMutationFailure,
  applyWorkspaceTreeMutationSuccess,
  applyWorkspaceWatchBatch,
  beginDirectoryScan,
  beginWorkspaceTreeMutation,
  beginWorkspaceWatch,
  beginWorkspaceWatchRescan,
  createWorkspaceTreeState,
  type WorkspaceTreeState,
} from "./workspaceTreeState";
import {
  desktopWorkspaceWorkbenchGateway,
  type WorkspaceWorkbenchGateway,
} from "./workbenchGateway";

import "./WorkspaceWorkbench.css";

type OperationKind = "create_file" | "create_directory" | "rename" | "move";

interface PendingOperation {
  kind: OperationKind;
  title: string;
  label: string;
  value: string;
  adjustImageLinks?: boolean;
  localImageCount?: number;
  moveRisk?: WorkspaceMoveRisk;
}

interface PendingConfirmation {
  proposal: WorkspaceSelectionProposal;
}

interface PendingDecision {
  outcome: Extract<WorkspaceOpenOutcome, { status: "decision_required" }>;
}

interface WorkspaceWorkbenchProps {
  initialWorkspace: WorkspaceDescriptor;
  gateway?: WorkspaceWorkbenchGateway;
  onWorkspaceChanged(workspace: WorkspaceDescriptor): void;
}

export function WorkspaceWorkbench({
  initialWorkspace,
  gateway = desktopWorkspaceWorkbenchGateway,
  onWorkspaceChanged,
}: WorkspaceWorkbenchProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [tree, setTree] = useState<WorkspaceTreeState>(createWorkspaceTreeState);
  const treeRef = useRef(tree);
  const [expanded, setExpanded] = useState<Set<WorkspaceRelativePath>>(new Set());
  const [selectedPath, setSelectedPath] = useState<WorkspaceRelativePath | null>(null);
  const [documentState, setDocumentState] = useState<DocumentSessionState>(
    createEmptyDocumentSession,
  );
  const [documentMetrics, setDocumentMetrics] =
    useState<DocumentEditorMetrics | null>(null);
  const [editorRuntime, setEditorRuntime] =
    useState<DocumentEditorRuntimeState>({ busy: false });
  const editorHandleRef = useRef<DocumentEditorShellHandle | null>(null);
  const documentStateRef = useRef(documentState);
  const saveControllerRef = useRef<DocumentSaveController | null>(null);
  const tabManagerRef = useRef<WorkspaceTabManager | null>(null);
  const tabManagerSubscriptionRef = useRef<(() => void) | null>(null);
  const tabPersistenceRef = useRef<WorkspaceTabSessionPersistence | null>(null);
  const tabManagerSnapshotRef = useRef<WorkspaceTabManagerSnapshot | null>(null);
  const [tabSnapshot, setTabSnapshot] =
    useState<WorkspaceTabManagerSnapshot | null>(null);
  const [closingTabIds, setClosingTabIds] = useState<Set<WorkspaceTabId>>(
    new Set(),
  );
  const closingTabIdsRef = useRef(new Set<WorkspaceTabId>());
  const [settlementBatch, setSettlementBatch] =
    useState<WorkspaceTabSettlementBatch | null>(null);
  const [settlementResolutions, setSettlementResolutions] = useState<
    Map<WorkspaceTabId, WorkspaceTabExplicitResolution>
  >(new Map());
  const [settlementBusyTabIds, setSettlementBusyTabIds] = useState<
    Set<WorkspaceTabId>
  >(new Set());
  const [settlementFinalLabel, setSettlementFinalLabel] =
    useState("关闭页签");
  const [settlementChild, setSettlementChild] = useState<{
    tabId: WorkspaceTabId;
    kind: "conflict" | "save_copy";
  } | null>(null);
  const settlementCommitRef = useRef<
    ((
      targets: readonly WorkspaceTabSettlementTarget[],
      resolutions: ReadonlyMap<
        WorkspaceTabId,
        WorkspaceTabExplicitResolution
      >,
    ) => Promise<void>) | null
  >(null);
  const settlementCancelRef = useRef<(() => Promise<void>) | null>(null);
  const windowSettlementIntentRef = useRef<string | null>(null);
  const [pageError, setPageError] = useState<DesktopError | null>(null);
  const [tabRestoreIssues, setTabRestoreIssues] = useState<
    WindowTabSessionPathIssue[]
  >([]);
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const [operationError, setOperationError] = useState<DesktopError | null>(null);
  const [operationInspecting, setOperationInspecting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<FsEntry | null>(null);
  const [permanentDeleteTabTargets, setPermanentDeleteTabTargets] = useState<
    readonly WorkspaceTabSettlementTarget[]
  >([]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [decisionError, setDecisionError] = useState<DesktopError | null>(null);
  const [decisionProcessing, setDecisionProcessing] = useState(false);
  const [openPreferenceOpen, setOpenPreferenceOpen] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [saveCopyOpen, setSaveCopyOpen] = useState(false);
  const [recoverySnapshots, setRecoverySnapshots] = useState<
    RecoverySnapshotMetadata[]
  >([]);
  const [savedCopyEvidence, setSavedCopyEvidence] = useState<{
    generation: number;
    editVersion: number;
    displayPath: string;
  } | null>(null);
  const promptedRecoveryIdsRef = useRef(new Set<string>());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeScansRef = useRef(new Set<string>());
  const activeDirectoryScansRef = useRef(new Set<string>());
  const queuedDirectoryRescansRef = useRef(new Set<string>());
  const activeWatchRef = useRef<string | null>(null);
  const openInFlightRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const selectOtherWorkspaceRef = useRef<(kind: "folder" | "markdown") => Promise<void>>(
    async () => undefined,
  );
  const settlementHandlerRef = useRef<
    (intent: WindowSettlementIntent) => Promise<void>
  >(async () => undefined);
  const workbenchMenuHandlerRef = useRef<
    (action: WorkbenchMenuAction) => void
  >(() => undefined);

  const selectedEntry = selectedPath ? tree.entries[selectedPath] ?? null : null;
  const rootScan = tree.scans[""];
  const rootLoading = rootScan?.status === "loading";
  const mutationProcessing = tree.mutation?.status === "processing";
  const activeDocumentPath =
    documentState.status === "empty" ? null : documentState.relativePath;
  const activeTab = tabSnapshot?.activeTab ?? null;
  const editorMenuState = useMemo<EditorMenuState>(() => {
    if (documentState.status !== "ready") {
      return {
        hasDocument: false,
        readOnly: true,
        busy:
          editorRuntime.busy ||
          mutationProcessing ||
          busyLabel !== null,
        canUndo: false,
        canRedo: false,
        mode: null,
      };
    }
    const saveBusy = documentState.saveState.kind === "saving";
    return {
      hasDocument: true,
      readOnly: documentState.saveState.kind === "readonly",
      busy:
        editorRuntime.busy ||
        saveBusy ||
        mutationProcessing ||
        busyLabel !== null,
      canUndo: documentState.history.past.length > 0,
      canRedo: documentState.history.future.length > 0,
      mode: documentState.mode,
    };
  }, [
    busyLabel,
    documentState,
    editorRuntime.busy,
    mutationProcessing,
  ]);

  const commitDocument = useCallback((next: DocumentSessionState) => {
    if (tabManagerRef.current?.updateActiveSession(next)) return;
    documentStateRef.current = next;
    setDocumentState(next);
    saveControllerRef.current?.observe(next.status === "ready" ? next : null);
  }, []);

  const commitTree = useCallback((update: (current: WorkspaceTreeState) => WorkspaceTreeState) => {
    setTree((current) => {
      const next = update(current);
      treeRef.current = next;
      return next;
    });
  }, []);

  const scanDirectory = useCallback(async (
    targetWorkspace: WorkspaceDescriptor,
    directory: WorkspaceRelativePath | null,
    reconcile = false,
    generation = generationRef.current,
  ) => {
    const directoryKey = `${generation}:${directory ?? ""}`;
    if (activeDirectoryScansRef.current.has(directoryKey)) {
      if (reconcile) queuedDirectoryRescansRef.current.add(directoryKey);
      return;
    }
    activeDirectoryScansRef.current.add(directoryKey);
    let nextScanReconciles = reconcile;
    try {
      do {
        queuedDirectoryRescansRef.current.delete(directoryKey);
        let scanId: string | null = null;
        try {
          const start = await gateway.scan(targetWorkspace.id, directory);
          scanId = start.scanId;
          if (!mountedRef.current || generation !== generationRef.current) {
            await gateway.cancelScan(start.scanId).catch(() => false);
            return;
          }
          activeScansRef.current.add(start.scanId);
          commitTree((current) =>
            nextScanReconciles
              ? beginWorkspaceWatchRescan(current, start)
              : beginDirectoryScan(current, start),
          );
          while (mountedRef.current && generation === generationRef.current) {
            const batch = await gateway.pollScan(start.scanId);
            if (!mountedRef.current || generation !== generationRef.current) break;
            commitTree((current) => applyDirectoryScanBatch(current, directory, batch));
            if (batch.complete && batch.issues.length > 0) {
              setPageError(batch.issues[0]);
            }
            if (batch.complete) break;
            await pause(45);
          }
        } catch (reason) {
          if (mountedRef.current && generation === generationRef.current) {
            setPageError(normalizeDesktopError(reason, "scan_unavailable"));
          }
        } finally {
          if (scanId) activeScansRef.current.delete(scanId);
        }
        nextScanReconciles = queuedDirectoryRescansRef.current.delete(directoryKey);
      } while (
        nextScanReconciles &&
        mountedRef.current &&
        generation === generationRef.current
      );
    } finally {
      activeDirectoryScansRef.current.delete(directoryKey);
      queuedDirectoryRescansRef.current.delete(directoryKey);
    }
  }, [commitTree, gateway]);

  const startWatchLoop = useCallback(async (
    targetWorkspace: WorkspaceDescriptor,
    generation = generationRef.current,
    restart = false,
  ) => {
    let watchId: string | null = null;
    try {
      const start = restart
        ? await gateway.restartWatch(targetWorkspace.id)
        : await gateway.watch(targetWorkspace.id);
      if (!mountedRef.current || generation !== generationRef.current) {
        await gateway.stopWatch(start.watchId).catch(() => false);
        return;
      }
      activeWatchRef.current = start.watchId;
      watchId = start.watchId;
      commitTree((current) => beginWorkspaceWatch(current, start));
      while (mountedRef.current && generation === generationRef.current) {
        const batch = await gateway.pollWatch(start.watchId);
        if (!mountedRef.current || generation !== generationRef.current) break;
        commitTree((current) => applyWorkspaceWatchBatch(current, batch));
        if (batch.issue) setPageError(batch.issue);
        const currentDocument = documentStateRef.current;
        if (
          currentDocument.status === "ready" &&
          batch.events.some(
            (event) =>
              event.kind === "remove" &&
              event.source !== "application" &&
              event.paths.includes(currentDocument.relativePath),
          )
        ) {
          const missing = markDocumentExternalMissing(currentDocument, {
            code: "path_not_found",
            messageKey: "error.desktop.path_not_found",
            pathHint: currentDocument.relativePath,
            contentSafe: true,
            retryable: false,
          });
          if (missing.status === "applied") {
            commitDocument(missing.session);
            setLifecycleNotice(
              "原文件已被外部删除；当前内容仍保留，可另存副本或在安全副本就绪后关闭。",
            );
          }
        }
        for (const directory of batch.rescanDirectories) {
          void scanDirectory(targetWorkspace, directory, true, generation);
        }
        if (batch.complete) break;
        await pause(180);
      }
    } catch (reason) {
      if (mountedRef.current && generation === generationRef.current) {
        setPageError(normalizeDesktopError(reason, "watch_unavailable"));
      }
    } finally {
      if (activeWatchRef.current === watchId) activeWatchRef.current = null;
    }
  }, [commitDocument, commitTree, gateway, scanDirectory]);

  const loadWorkspace = useCallback((nextWorkspace: WorkspaceDescriptor) => {
    const generation = ++generationRef.current;
    for (const scanId of activeScansRef.current) {
      void gateway.cancelScan(scanId).catch(() => false);
    }
    activeScansRef.current.clear();
    queuedDirectoryRescansRef.current.clear();
    if (activeWatchRef.current) {
      void gateway.stopWatch(activeWatchRef.current).catch(() => false);
      activeWatchRef.current = null;
    }
    setWorkspace(nextWorkspace);
    setTree(createWorkspaceTreeState());
    treeRef.current = createWorkspaceTreeState();
    setExpanded(new Set());
    setSelectedPath(null);
    setDocumentMetrics(null);
    setSavedCopyEvidence(null);
    setTabRestoreIssues([]);
    closingTabIdsRef.current.clear();
    setClosingTabIds(new Set());
    tabManagerSubscriptionRef.current?.();
    tabManagerSubscriptionRef.current = null;
    tabPersistenceRef.current?.dispose();
    tabPersistenceRef.current = null;
    const previousManager = tabManagerRef.current;
    if (previousManager) void previousManager.destroy();
    const manager = new WorkspaceTabManager({
      workspaceId: nextWorkspace.id,
      gateway: tabSessionGateway(gateway),
      captureActiveProjection: () =>
        editorHandleRef.current?.commitProjection() ?? null,
    });
    tabManagerRef.current = manager;
    const persistence = new WorkspaceTabSessionPersistence({
      workspaceId: nextWorkspace.id,
      gateway: {
        get: gateway.getTabSession,
        save: gateway.saveTabSession,
      },
      markPersisted: (revision) => {
        manager.markPersisted(revision);
      },
      onError: (error) => {
        if (mountedRef.current && generation === generationRef.current) {
          setPageError(error);
        }
      },
    });
    tabPersistenceRef.current = persistence;
    tabManagerSubscriptionRef.current = manager.subscribe((snapshot) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      persistence.observe(snapshot);
      tabManagerSnapshotRef.current = snapshot;
      setTabSnapshot(snapshot);
      const nextDocument =
        snapshot.activeRuntime?.session ??
        createEmptyDocumentSession(documentStateRef.current.generation + 1);
      documentStateRef.current = nextDocument;
      setDocumentState(nextDocument);
      saveControllerRef.current = manager.activeSaveController();
    });
    setPageError(null);
    void gateway.setTitle(null).catch((reason) => {
      if (mountedRef.current && generation === generationRef.current) {
        setPageError(normalizeDesktopError(reason, "window_title_failed"));
      }
    });
    void scanDirectory(nextWorkspace, null, false, generation);
    void startWatchLoop(nextWorkspace, generation);
    void (async () => {
      const status = await persistence.initialize();
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (status === "deferred_existing_session") {
        const stored = persistence.pendingRestore();
        if (stored) {
          try {
            await manager.restoreSession(
              stored,
              (relativePath) =>
                nextWorkspace.writable &&
                (treeRef.current.entries[relativePath]?.writable ?? true),
            );
            if (
              !mountedRef.current ||
              generation !== generationRef.current
            ) {
              return;
            }
            setTabRestoreIssues([...stored.issues]);
            persistence.resumeAfterRestore(manager.snapshot());
            syncActiveTabChrome(
              manager.snapshot().activeTab?.relativePath ?? null,
              generation,
            );
          } catch (reason) {
            setPageError(
              normalizeDesktopError(reason, "window_session_read_failed"),
            );
          }
        }
      }
      if (nextWorkspace.initialFile) {
        await openMarkdown(
          nextWorkspace.initialFile,
          nextWorkspace,
          generation,
        );
      }
    })();
  // openMarkdown deliberately uses only stable gateway/state setters; workspace loading owns reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitDocument, gateway, scanDirectory, startWatchLoop]);

  useEffect(() => {
    mountedRef.current = true;
    loadWorkspace(initialWorkspace);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      for (const scanId of activeScansRef.current) {
        void gateway.cancelScan(scanId).catch(() => false);
      }
      queuedDirectoryRescansRef.current.clear();
      if (activeWatchRef.current) {
        void gateway.stopWatch(activeWatchRef.current).catch(() => false);
      }
      tabManagerSubscriptionRef.current?.();
      tabManagerSubscriptionRef.current = null;
      tabPersistenceRef.current?.dispose();
      tabPersistenceRef.current = null;
      const manager = tabManagerRef.current;
      tabManagerRef.current = null;
      if (manager) void manager.destroy();
    };
  }, [gateway, initialWorkspace, loadWorkspace]);

  const loadRecoverySnapshots = useCallback(async () => {
    try {
      const snapshots = await gateway.recoveryGateway.list();
      if (!mountedRef.current) return;
      setRecoverySnapshots(
        snapshots.filter((snapshot) => snapshot.workspaceId === workspace.id),
      );
    } catch (reason) {
      if (mountedRef.current) {
        setPageError(normalizeDesktopError(reason, "recovery_read_failed"));
      }
    }
  }, [gateway.recoveryGateway, workspace.id]);

  useEffect(() => {
    void loadRecoverySnapshots();
  }, [loadRecoverySnapshots]);

  const syncEditorMenu = useCallback(async () => {
    try {
      await gateway.updateEditorMenu(editorMenuState);
    } catch (reason) {
      if (mountedRef.current) {
        setPageError(normalizeDesktopError(reason, "menu_update_failed"));
      }
    }
  }, [editorMenuState, gateway]);

  useEffect(() => {
    void syncEditorMenu();
  }, [syncEditorMenu]);

  useEffect(
    () => () => {
      void gateway.resetEditorMenu().catch(() => undefined);
    },
    [gateway],
  );

  workbenchMenuHandlerRef.current = (action) => {
    const current = documentStateRef.current;
    if (!workbenchMenuActionAvailable(editorMenuState, action)) return;
    switch (action) {
      case "file.save":
        if (current.status !== "ready") return;
        if (current.saveState.kind === "conflict") {
          setConflictOpen(true);
          return;
        }
        void saveControllerRef.current?.manualSave();
        return;
      case "file.save_copy":
        if (current.status === "ready") setSaveCopyOpen(true);
        return;
      case "edit.undo":
        editorHandleRef.current?.execute({
          kind: "history",
          direction: "undo",
        });
        return;
      case "edit.redo":
        editorHandleRef.current?.execute({
          kind: "history",
          direction: "redo",
        });
        return;
      case "edit.find":
        editorHandleRef.current?.execute({ kind: "find" });
        return;
      case "view.visual":
        editorHandleRef.current?.switchMode("visual");
        return;
      case "view.source":
        editorHandleRef.current?.switchMode("source");
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void gateway.listenMenu((action) => {
      if (action === "file.open_folder") void selectOtherWorkspaceRef.current("folder");
      if (action === "file.open_markdown") void selectOtherWorkspaceRef.current("markdown");
      if (action === "app.workspace_open_preferences") {
        setOpenPreferenceOpen(true);
      }
    }).then((stop) => {
      unlisten = stop;
    }).catch(() => undefined);
    return () => unlisten?.();
  }, [gateway]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void gateway
      .listenWorkbenchMenu((action) => {
        workbenchMenuHandlerRef.current(action);
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch((reason) => {
        if (mountedRef.current) {
          setPageError(normalizeDesktopError(reason, "menu_update_failed"));
        }
      });
    return () => unlisten?.();
  }, [gateway]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void gateway
      .listenSettlement((intent) => {
        void settlementHandlerRef.current(intent);
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [gateway]);

  useEffect(() => {
    const ready = documentState.status === "ready" ? documentState : null;
    if (
      ready &&
      (ready.saveState.kind === "clean" || ready.saveState.kind === "saved")
    ) {
      setLifecycleNotice(null);
    }
  }, [documentState]);

  useEffect(() => {
    if (documentState.status !== "ready") return;
    if (documentState.saveState.kind === "conflict") {
      setConflictOpen(true);
      return;
    }
    const matching = recoverySnapshots.find(
      (snapshot) =>
        snapshot.relativePath === documentState.relativePath &&
        snapshot.contentHash !== documentState.diskRevision.contentHash &&
        !promptedRecoveryIdsRef.current.has(snapshot.snapshotId),
    );
    if (matching) {
      promptedRecoveryIdsRef.current.add(matching.snapshotId);
      setRecoveryOpen(true);
    }
  }, [documentState, recoverySnapshots]);

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    queueMicrotask(() => focusContainmentEntry(drawer));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      containTabFocus(event, drawer);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  function syncActiveTabChrome(
    path: WorkspaceRelativePath | null,
    generation = generationRef.current,
  ) {
    setSelectedPath(path);
    void gateway.setTitle(path).catch((reason) => {
      if (
        mountedRef.current &&
        generation === generationRef.current &&
        (tabManagerRef.current?.snapshot().activeTab?.relativePath ?? null) ===
          path
      ) {
        setPageError(normalizeDesktopError(reason, "window_title_failed"));
      }
    });
  }

  async function openMarkdown(
    path: WorkspaceRelativePath,
    targetWorkspace = workspace,
    generation = generationRef.current,
    overrideMarkdown?: string,
  ) {
    const manager = tabManagerRef.current;
    if (!manager || manager.snapshot().collection.workspaceId !== targetWorkspace.id) {
      setPageError(
        normalizeDesktopError(null, "workspace_not_registered"),
      );
      return;
    }
    setLifecycleNotice(null);
    setDocumentMetrics(null);
    const opened = await manager.open(path, {
      writable:
        targetWorkspace.writable &&
        (treeRef.current.entries[path]?.writable ?? true),
    });
    if (!mountedRef.current || generation !== generationRef.current) return;
    if (opened.status === "failed") {
      setPageError(opened.error);
      return;
    }
    syncActiveTabChrome(path, generation);
    let resolved = manager.snapshot().runtimes.get(opened.tabId)?.session;
    if (
      overrideMarkdown !== undefined &&
      resolved?.status === "ready" &&
      overrideMarkdown !== resolved.markdown
    ) {
      const adjusted = applyDocumentEdit(resolved, {
        generation: resolved.generation,
        expectedEditVersion: resolved.editVersion,
        markdown: overrideMarkdown,
        mode: resolved.mode,
        selection: resolved.selection,
        anchor: resolved.anchor,
        transactionGroup: "workspace-move-image-links",
      });
      if (adjusted.status === "applied") resolved = adjusted.session;
    }
    if (resolved) manager.updateActiveSession(resolved);
  }

  function activateWorkspaceTab(tabId: WorkspaceTabId) {
    const manager = tabManagerRef.current;
    const tab = manager?.snapshot().collection.tabsById.get(tabId);
    if (
      !manager ||
      !tab ||
      !manager.activate(
        tabId,
        workspace.writable &&
          (treeRef.current.entries[tab.relativePath]?.writable ?? true),
      )
    ) {
      return;
    }
    syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
  }

  async function retryTabRestoreIssues() {
    const manager = tabManagerRef.current;
    if (!manager || tabRestoreIssues.length === 0) return;
    const remaining: WindowTabSessionPathIssue[] = [];
    for (const issue of tabRestoreIssues) {
      const result = await manager.open(issue.relativePath, {
        writable:
          workspace.writable &&
          (treeRef.current.entries[issue.relativePath]?.writable ?? true),
      });
      if (result.status === "failed") {
        remaining.push({ ...issue, error: result.error });
        continue;
      }
      const tab = manager.snapshot().collection.tabsById.get(result.tabId);
      if (
        tab?.loadState.kind === "error" ||
        tab?.loadState.kind === "missing" ||
        tab?.loadState.kind === "permission_denied"
      ) {
        remaining.push({ ...issue, error: tab.loadState.error });
      }
    }
    setTabRestoreIssues(remaining);
    syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
    setLifecycleNotice(
      remaining.length === 0
        ? "此前未恢复的页签现已重新打开。"
        : `仍有 ${remaining.length} 个页签无法恢复；其他页签继续可用。`,
    );
  }

  async function closeWorkspaceTab(tabId: WorkspaceTabId) {
    await requestTabSettlement(
      [tabId],
      "close_current",
      "关闭这个页签",
      closeSettledTabs,
    );
  }

  async function closeWorkspaceTabs(
    tabIds: readonly WorkspaceTabId[],
    reason: WorkspaceTabSettlementReason,
  ) {
    if (tabIds.length === 0) return;
    await requestTabSettlement(
      tabIds,
      reason,
      reason === "close_all"
        ? `关闭 ${tabIds.length} 个页签`
        : reason === "close_right"
          ? "关闭右侧页签"
          : "关闭其他页签",
      closeSettledTabs,
    );
  }

  async function closeSettledTabs(
    targets: readonly WorkspaceTabSettlementTarget[],
  ) {
    const manager = tabManagerRef.current;
    if (!manager) return;
    const snapshot = manager.snapshot();
    const recoveryToDelete = targets.flatMap((target) => {
      const session = snapshot.runtimes.get(target.tabId)?.session;
      return session?.status === "ready" &&
        session.recoveryState.kind === "available"
        ? [session.recoveryState.snapshotId]
        : [];
    });
    await manager.closeTabsAtomically(targets);
    await Promise.all(
      recoveryToDelete.map((snapshotId) =>
        gateway.recoveryGateway
          .delete(snapshotId, workspace.id)
          .catch(() => false),
      ),
    );
    setRecoverySnapshots((items) =>
      items.filter((item) => !recoveryToDelete.includes(item.snapshotId)),
    );
    syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
    setLifecycleNotice(
      targets.length === 1
        ? "页签已安全关闭。"
        : `${targets.length} 个页签已一次性安全关闭。`,
    );
  }

  async function requestTabSettlement(
    tabIds: readonly WorkspaceTabId[],
    reason: WorkspaceTabSettlementReason,
    finalLabel: string,
    commit: (
      targets: readonly WorkspaceTabSettlementTarget[],
      resolutions: ReadonlyMap<
        WorkspaceTabId,
        WorkspaceTabExplicitResolution
      >,
    ) => Promise<void>,
    cancel?: () => Promise<void>,
  ): Promise<boolean> {
    const manager = tabManagerRef.current;
    if (!manager || settlementBatch) return false;
    const batch = createWorkspaceTabSettlementBatch(
      manager.snapshot(),
      tabIds,
      reason,
    );
    if (batch.targets.length === 0) return true;
    closingTabIdsRef.current = new Set(batch.targets.map((item) => item.tabId));
    setClosingTabIds(new Set(closingTabIdsRef.current));
    const attempts = await manager.settleTabs(batch.targets);
    const blocked = attempts.some((item) => item.outcome.status === "blocked");
    if (!blocked) {
      try {
        await commit(manager.pinSettlementTargets(batch.targets), new Map());
        closingTabIdsRef.current.clear();
        setClosingTabIds(new Set());
        return true;
      } catch {
        settlementCommitRef.current = commit;
        settlementCancelRef.current = cancel ?? null;
        setSettlementResolutions(new Map());
        setSettlementFinalLabel(finalLabel);
        setSettlementBatch(batch);
        setLifecycleNotice(
          "最终动作没有完成；全部页签与当前内容仍保留，可重试或取消。",
        );
        return false;
      }
    }
    settlementCommitRef.current = commit;
    settlementCancelRef.current = cancel ?? null;
    setSettlementResolutions(new Map());
    setSettlementFinalLabel(finalLabel);
    setSettlementBatch(batch);
    return false;
  }

  async function cancelTabSettlement() {
    const cancel = settlementCancelRef.current;
    settlementCommitRef.current = null;
    settlementCancelRef.current = null;
    setSettlementBatch(null);
    setSettlementResolutions(new Map());
    setSettlementChild(null);
    closingTabIdsRef.current.clear();
    setClosingTabIds(new Set());
    setLifecycleNotice("操作已取消；全部页签仍保持打开。");
    if (!cancel) return;
    try {
      await cancel();
    } catch (reason) {
      setPageError(normalizeDesktopError(reason, "window_close_failed"));
    }
  }

  async function retryTabSettlement(tabId: WorkspaceTabId) {
    const batch = settlementBatch;
    const manager = tabManagerRef.current;
    const target = batch?.targets.find((item) => item.tabId === tabId);
    if (!manager || !target || settlementBusyTabIds.has(tabId)) return;
    setSettlementBusyTabIds((current) => new Set(current).add(tabId));
    try {
      await manager.settleTabs([target]);
      setSettlementResolutions((current) => {
        const next = new Map(current);
        next.delete(tabId);
        return next;
      });
    } finally {
      setSettlementBusyTabIds((current) => {
        const next = new Set(current);
        next.delete(tabId);
        return next;
      });
    }
  }

  function resolveTabSettlementByDiscard(tabId: WorkspaceTabId) {
    const session = tabManagerRef.current?.snapshot().runtimes.get(tabId)?.session;
    if (session?.status !== "ready") return;
    setSettlementResolutions((current) => {
      const next = new Map(current);
      next.set(tabId, settlementResolutionFor(session, { kind: "discard" }));
      return next;
    });
  }

  function openSettlementChild(
    tabId: WorkspaceTabId,
    kind: "conflict" | "save_copy",
  ) {
    const manager = tabManagerRef.current;
    if (!manager?.activate(tabId)) return;
    syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
    setSettlementChild({ tabId, kind });
    if (kind === "conflict") setConflictOpen(true);
    else setSaveCopyOpen(true);
  }

  async function commitTabSettlement() {
    const batch = settlementBatch;
    const manager = tabManagerRef.current;
    const commit = settlementCommitRef.current;
    if (!batch || !manager || !commit) return;
    const projections = projectWorkspaceTabSettlement(
      batch,
      manager.snapshot(),
      settlementResolutions,
    );
    if (!settlementBatchIsSafe(projections)) {
      setLifecycleNotice(
        "页签内容在处理期间发生变化，请重新处理仍未安全的条目。",
      );
      return;
    }
    setSettlementBusyTabIds(new Set(batch.targets.map((item) => item.tabId)));
    try {
      await commit(
        manager.pinSettlementTargets(batch.targets),
        settlementResolutions,
      );
      settlementCommitRef.current = null;
      settlementCancelRef.current = null;
      setSettlementBatch(null);
      setSettlementResolutions(new Map());
      closingTabIdsRef.current.clear();
      setClosingTabIds(new Set());
    } catch {
      setLifecycleNotice(
        "页签内容在操作提交前发生变化；没有关闭该页签，请重新处理。",
      );
    } finally {
      setSettlementBusyTabIds(new Set());
    }
  }

  function moveWorkspaceTab(tabId: WorkspaceTabId, toIndex: number) {
    tabManagerRef.current?.move(tabId, toIndex);
  }

  async function reopenWorkspaceTab(
    pathIdentity: WorkspaceTabPathIdentity,
  ): Promise<WorkspaceTabOpenResult> {
    const manager = tabManagerRef.current;
    const recent = manager?.snapshot().collection.recentlyClosed.find(
      (candidate) => candidate.pathIdentity === pathIdentity,
    );
    if (!manager || !recent) {
      return {
        status: "failed",
        error: normalizeDesktopError(null, "path_not_found"),
      };
    }
    const result = await manager.reopenRecentlyClosed(pathIdentity, {
      writable:
        workspace.writable &&
        (treeRef.current.entries[recent.relativePath]?.writable ?? true),
    });
    if (result.status !== "failed") {
      syncActiveTabChrome(
        manager.snapshot().activeTab?.relativePath ?? null,
      );
      setLifecycleNotice("最近关闭的文档已重新打开。");
    }
    return result;
  }

  function discardRecentlyClosed(pathIdentity: WorkspaceTabPathIdentity) {
    if (tabManagerRef.current?.discardRecentlyClosed(pathIdentity)) {
      setLifecycleNotice("已移除最近关闭记录；本地文件没有删除。");
    }
  }

  async function settleCurrentDocument(): Promise<DocumentSaveOutcome> {
    const result =
      (await saveControllerRef.current?.settle()) ?? {
        status: "already_safe" as const,
      };
    if (result.status === "blocked") {
      setLifecycleNotice(settlementMessage(result));
    }
    return result;
  }

  async function reloadConflictFromDisk() {
    const current = documentStateRef.current;
    if (current.status !== "ready") return;
    if (current.conflictEvidence) {
      await gateway.saveGateway
        .cancelOverwrite(current.conflictEvidence.evidenceId)
        .catch(() => false);
    }
    await saveControllerRef.current?.abandon();
    await discardRecoveryFor(current);
    setConflictOpen(false);
    await loadDocumentWithoutSettlement(current.relativePath);
    setSettlementChild(null);
  }

  async function loadDocumentWithoutSettlement(path: WorkspaceRelativePath) {
    const manager = tabManagerRef.current;
    const tabId = manager?.snapshot().activeTab?.tabId;
    if (!manager || !tabId) return;
    await manager.reload(
      tabId,
      workspace.writable && (treeRef.current.entries[path]?.writable ?? true),
    );
  }

  async function restoreSnapshot(snapshot: RecoverySnapshot) {
    const current = documentStateRef.current;
    if (
      current.status === "ready" &&
      (current.workspaceId !== snapshot.metadata.workspaceId ||
        current.relativePath !== snapshot.metadata.relativePath ||
        shouldProtectBeforeRecovery(current, snapshot.content))
    ) {
      await requireRecoverySettlement(current);
    }
    setBusyLabel("正在核对恢复副本与原文件");
    try {
      const manager = tabManagerRef.current;
      if (!manager) return;
      const opened = await manager.open(snapshot.metadata.relativePath, {
        writable:
          workspace.writable &&
          (treeRef.current.entries[snapshot.metadata.relativePath]?.writable ??
            true),
      });
      if (opened.status === "failed") throw opened.error;
      const openedState = manager.snapshot().activeRuntime?.session;
      if (
        openedState?.status === "ready" &&
        openedState !== current &&
        shouldProtectBeforeRecovery(openedState, snapshot.content)
      ) {
        await requireRecoverySettlement(openedState);
      }
      await manager.reload(
        opened.tabId,
        workspace.writable &&
          (treeRef.current.entries[snapshot.metadata.relativePath]?.writable ??
            true),
      );
      const diskState = manager.snapshot().activeRuntime?.session;
      if (!diskState) return;
      let compatibility;
      try {
        compatibility = assessVisualEditingCompatibility(
          await remarkMarkdownCompatibilityParser.parse(snapshot.content),
        );
      } catch {
        compatibility = { mode: "source-only" as const, reasons: ["parse-error"] };
      }
      const recovered = restoreDocumentRecovery(
        diskState,
        snapshot,
        compatibility,
        recoveryUnavailableError(diskState),
      );
      manager.updateActiveSession(recovered);
      setSelectedPath(snapshot.metadata.relativePath);
      setRecoveryOpen(false);
      setLifecycleNotice(
        "恢复副本已载入为未保存内容；原 Markdown 文件尚未被覆盖。",
      );
    } finally {
      setBusyLabel(null);
    }
  }

  async function requireRecoverySettlement(
    session: ReadyDocumentSession,
  ): Promise<void> {
    const settlement = await settleCurrentDocument();
    if (settlement.status !== "blocked") return;
    throw {
      code: "recovery_snapshot_protected",
      messageKey: "error.desktop.recovery_snapshot_protected",
      pathHint: session.relativePath,
      contentSafe: true,
      retryable: false,
    } satisfies DesktopError;
  }

  async function applyConflictOverwrite(result: SafeWriteResult) {
    const current = documentStateRef.current;
    if (current.status !== "ready") return;
    const completed = completeDocumentConflictOverwrite(
      current,
      result,
      Date.now(),
    );
    if (completed.status !== "applied") return;
    const snapshotId =
      current.recoveryState.kind === "available"
        ? current.recoveryState.snapshotId
        : null;
    commitDocument(completed.session);
    await saveControllerRef.current?.abandon();
    if (snapshotId) {
      await gateway.recoveryGateway
        .delete(snapshotId, current.workspaceId)
        .catch(() => false);
      setRecoverySnapshots((items) =>
        items.filter((item) => item.snapshotId !== snapshotId),
      );
    }
    setConflictOpen(false);
    setSettlementChild(null);
    setLifecycleNotice("当前内容已覆盖磁盘版本。");
  }

  async function closeExternallyDeletedDocument() {
    const controller = saveControllerRef.current;
    if (controller) await controller.settle();
    const current = documentStateRef.current;
    if (current.status !== "ready") return;
    const copyCoversCurrent =
      savedCopyEvidence?.generation === current.generation &&
      savedCopyEvidence.editVersion === current.editVersion;
    if (
      current.contentSafety.kind !== "recovery" &&
      !copyCoversCurrent
    ) {
      setLifecycleNotice(
        "关闭已取消：恢复副本尚未覆盖当前内容，请先另存副本或等待恢复保护完成。",
      );
      return;
    }
    await controller?.abandon();
    const manager = tabManagerRef.current;
    const active = manager?.snapshot().activeTab;
    if (manager && active) {
      await manager.close(active.tabId, undefined, Date.now(), true);
    }
    setSelectedPath(null);
    setSavedCopyEvidence(null);
    setLifecycleNotice(
      copyCoversCurrent
        ? `文档已关闭；当前内容已另存到 ${savedCopyEvidence?.displayPath}。`
        : "文档已关闭；未保存内容仍保留在本机恢复副本中。",
    );
    void gateway.setTitle(null).catch(() => undefined);
  }

  async function discardRecoveryFor(session: ReadyDocumentSession) {
    if (session.recoveryState.kind !== "available") return;
    const snapshotId = session.recoveryState.snapshotId;
    await gateway.recoveryGateway
      .delete(snapshotId, session.workspaceId)
      .catch(() => false);
    setRecoverySnapshots((items) =>
      items.filter((item) => item.snapshotId !== snapshotId),
    );
  }

  async function resolveSettlementIntent(intent: WindowSettlementIntent) {
    if (windowSettlementIntentRef.current === intent.intentId) return;
    if (windowSettlementIntentRef.current || settlementBatch) {
      await gateway.resolveSettlement(intent.intentId, false).catch((reason) => {
        setPageError(normalizeDesktopError(reason, "window_close_failed"));
      });
      setLifecycleNotice(
        "另一个页签安全操作仍在进行；本次窗口动作已取消。",
      );
      return;
    }
    windowSettlementIntentRef.current = intent.intentId;
    const manager = tabManagerRef.current;
    const tabIds = manager?.snapshot().collection.orderedTabIds ?? [];
    const reason: WorkspaceTabSettlementReason =
      intent.kind === "replace_workspace"
        ? "replace_workspace"
        : intent.kind === "quit_app"
          ? "quit_app"
          : "close_window";
    const finalLabel =
      intent.kind === "replace_workspace"
        ? "安全替换当前窗口"
        : intent.kind === "quit_app"
          ? "安全退出 Plainroot"
          : "安全关闭窗口";

    const cancel = async () => {
      try {
        await gateway.resolveSettlement(intent.intentId, false);
      } finally {
        windowSettlementIntentRef.current = null;
      }
    };
    const commit = async () => {
      await persistTabSessionBeforeWindowAction();
      try {
        const outcome = await gateway.resolveSettlement(intent.intentId, true);
        windowSettlementIntentRef.current = null;
        if (outcome.status === "opened_current") {
          onWorkspaceChanged(outcome.workspace);
        }
      } catch (reason) {
        setPageError(
          normalizeDesktopError(
            reason,
            intent.kind === "replace_workspace"
              ? "window_create_failed"
              : "window_close_failed",
          ),
        );
        throw reason;
      }
    };

    if (tabIds.length === 0) {
      try {
        await commit();
      } catch {
        windowSettlementIntentRef.current = null;
      }
      return;
    }
    await requestTabSettlement(
      tabIds,
      reason,
      finalLabel,
      async () => commit(),
      cancel,
    );
  }

  async function persistTabSessionBeforeWindowAction() {
    const manager = tabManagerRef.current;
    const persistence = tabPersistenceRef.current;
    if (!manager || !persistence) return;
    const snapshot = manager.snapshot();
    persistence.observe(snapshot);
    if (!workspaceTabsNeedPersistence(snapshot.collection)) return;
    const status = persistence.currentStatus();
    if (status === "deferred_existing_session") {
      // T42 owns restoring and unfreezing an older content-free session. Keeping that
      // recoverable snapshot is safer than overwriting it from the pre-restore UI.
      return;
    }
    if (status !== "ready" || !(await persistence.flush())) {
      // Markdown content has already passed the settlement gate. Tab-session metadata
      // is content-free and best-effort, so a failed snapshot must not trap the user
      // in a window that can no longer close safely.
      setLifecycleNotice(
        "文档内容已安全；页签恢复信息未能更新，下次打开可能恢复到较早的页签状态。",
      );
    }
  }

  settlementHandlerRef.current = resolveSettlementIntent;

  function selectEntry(entry: FsEntry) {
    if (entry.kind === "markdown_file") {
      void openMarkdown(entry.relativePath);
    } else {
      setSelectedPath(entry.relativePath);
    }
  }

  function toggleDirectory(entry: FsEntry) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.relativePath)) {
        next.delete(entry.relativePath);
      } else {
        next.add(entry.relativePath);
        if (!treeRef.current.children[entry.relativePath]) {
          void scanDirectory(workspace, entry.relativePath);
        }
      }
      return next;
    });
  }

  function parentForCreate(): WorkspaceRelativePath | null {
    if (!selectedEntry) return null;
    if (selectedEntry.kind === "directory") return selectedEntry.relativePath;
    return parentPath(selectedEntry.relativePath);
  }

  function openOperation(kind: OperationKind) {
    if ((kind === "rename" || kind === "move") && !selectedEntry) return;
    const snapshot = tabManagerRef.current?.snapshot() ?? null;
    const localImageCount =
      kind === "move" && selectedEntry && snapshot
        ? [...snapshot.runtimes.values()].reduce((count, runtime) => {
            const session = runtime.session;
            return session.status === "ready" &&
              isSameOrInside(
                session.relativePath,
                selectedEntry.relativePath,
              )
              ? count +
                  countLocalMarkdownImages(
                    session.markdown,
                    session.relativePath,
                  )
              : count;
          }, 0)
        : 0;
    const details: Record<OperationKind, PendingOperation> = {
      create_file: { kind, title: "新建 Markdown 文档", label: "文件名", value: "未命名文档.md" },
      create_directory: { kind, title: "新建文件夹", label: "文件夹名称", value: "新文件夹" },
      rename: { kind, title: `重命名“${selectedEntry?.name ?? ""}”`, label: "新名称", value: selectedEntry?.name ?? "" },
      move: {
        kind,
        title: `移动“${selectedEntry?.name ?? ""}”`,
        label: "目标文件夹（留空表示根目录）",
        value: parentPath(selectedEntry?.relativePath ?? "") ?? "",
        adjustImageLinks: localImageCount > 0,
        localImageCount,
      },
    };
    setOperationError(null);
    setOperation(details[kind]);
  }

  async function submitOperation() {
    if (!operation || mutationInFlightRef.current) return;
    const value = operation.value;
    if (!value.trim() && operation.kind !== "move") return;
    if (
      operation.kind === "move" &&
      selectedEntry?.kind === "directory" &&
      !operation.moveRisk
    ) {
      mutationInFlightRef.current = true;
      setOperationInspecting(true);
      setBusyLabel("正在检查图片链接风险");
      setOperationError(null);
      try {
        const risk = await gateway.inspectMoveRisk(
          workspace.id,
          selectedEntry.relativePath,
        );
        if (risk.mayBreakImageLinks) {
          setOperation((current) =>
            current?.kind === "move" ? { ...current, moveRisk: risk } : current,
          );
          return;
        }
      } catch (reason) {
        setOperationError(
          normalizeDesktopError(reason, "mutation_unavailable"),
        );
        return;
      } finally {
        mutationInFlightRef.current = false;
        setOperationInspecting(false);
        setBusyLabel(null);
      }
    }
    const pathImpact = pathImpactForOperation(
      tabManagerRef.current?.snapshot() ?? null,
      operation,
      selectedEntry,
    );
    if (pathImpact && pathImpact.affectedTabIds.length > 0) {
      const pending = operation;
      setOperation(null);
      await requestTabSettlement(
        pathImpact.affectedTabIds,
        pending.kind === "rename" ? "rename_entry" : "move_entry",
        pending.kind === "rename"
          ? "重命名并更新受影响页签"
          : "移动并更新受影响页签",
        async (targets, resolutions) =>
          performWorkspaceOperation(
            pending,
            pathImpact,
            targets,
            resolutions,
          ),
      );
      return;
    }
    await performWorkspaceOperation(operation, pathImpact, []);
  }

  async function performWorkspaceOperation(
    pendingOperation: PendingOperation,
    pathImpact: WorkspaceTabPathImpact | null,
    settledTargets: readonly WorkspaceTabSettlementTarget[],
    resolutions: ReadonlyMap<
      WorkspaceTabId,
      WorkspaceTabExplicitResolution
    > = new Map(),
  ) {
    const targetEntry = selectedEntry;
    const mutationId = crypto.randomUUID();
    mutationInFlightRef.current = true;
    const sourcePath =
      pendingOperation.kind === "rename" || pendingOperation.kind === "move"
      ? targetEntry?.relativePath ?? null
      : null;
    commitTree((current) =>
      beginWorkspaceTreeMutation(
        current,
        mutationId,
        pendingOperation.kind,
        sourcePath,
      ),
    );
    setBusyLabel("正在提交磁盘变更");
    setOperationError(null);
    try {
      let result: WorkspaceMutationResult;
      try {
        if (pendingOperation.kind === "create_file") {
          result = await gateway.createFile(
            workspace.id,
            pendingOperation.value,
            parentForCreate(),
          );
        } else if (pendingOperation.kind === "create_directory") {
          result = await gateway.createDirectory(
            workspace.id,
            pendingOperation.value,
            parentForCreate(),
          );
        } else if (pendingOperation.kind === "rename" && targetEntry) {
          result = await gateway.rename(
            workspace.id,
            targetEntry.relativePath,
            pendingOperation.value,
          );
        } else if (pendingOperation.kind === "move" && targetEntry) {
          result = await gateway.move(
            workspace.id,
            targetEntry.relativePath,
            pendingOperation.value.trim() || null,
          );
        } else {
          return;
        }
      } catch (reason) {
        const error = normalizeDesktopError(reason, "mutation_unavailable");
        commitTree((current) =>
          applyWorkspaceTreeMutationFailure(current, mutationId, error),
        );
        setOperation(pendingOperation);
        setOperationError(error);
        return;
      }
      commitTree((current) =>
        applyWorkspaceTreeMutationSuccess(current, mutationId, result),
      );
      setOperation(null);
      try {
        await commitTabPathMutation(
          result,
          pathImpact,
          settledTargets,
          resolutions,
          pendingOperation.adjustImageLinks !== false,
        );
      } catch (reason) {
        const error = normalizeDesktopError(reason, "mutation_unavailable");
        setPageError(error);
        setLifecycleNotice(
          "磁盘变更已完成，但部分页签状态尚未同步；请刷新文件树并重新打开受影响文档。",
        );
        return;
      }
      if (
        result.entry.kind === "markdown_file" &&
        pendingOperation.kind === "create_file"
      ) {
        void openMarkdown(result.entry.relativePath);
      }
    } finally {
      mutationInFlightRef.current = false;
      setBusyLabel(null);
    }
  }

  async function commitTabPathMutation(
    result: WorkspaceMutationResult,
    impact: WorkspaceTabPathImpact | null,
    settledTargets: readonly WorkspaceTabSettlementTarget[],
    resolutions: ReadonlyMap<
      WorkspaceTabId,
      WorkspaceTabExplicitResolution
    >,
    adjustImageLinks: boolean,
  ) {
    if (!result.previousPath) return;
    const previousPath = result.previousPath;
    const nextPath = result.entry.relativePath;
    setSelectedPath((current) =>
      current ? replacePrefix(current, previousPath, nextPath) : null,
    );
    setExpanded(
      (current) =>
        new Set(
          [...current].map((path) =>
            replacePrefix(path, previousPath, nextPath),
          ),
        ),
    );
    const manager = tabManagerRef.current;
    if (!manager || !impact) return;
    const remaps = await Promise.all(
      impact.pathRemaps.flatMap((item) =>
        item.nextPath
          ? [
              gateway
                .resolveTabPath(workspace.id, item.nextPath)
                .then((path) => ({ ...item, path })),
            ]
          : [],
      ),
    );
    if (remaps.length > 0) {
      manager.remapTabsAtomically(
        remaps.map((item) => ({
          tabId: item.tabId,
          incarnation: item.incarnation,
          path: item.path,
        })),
      );
    }
    const detachedIds = new Set(
      settledTargets.flatMap((target) => {
        const resolution = resolutions.get(target.tabId);
        return resolution?.kind === "discard" ||
          resolution?.kind === "save_copy"
          ? [target.tabId]
          : [];
      }),
    );
    for (const tabId of detachedIds) {
      const tab = manager.snapshot().collection.tabsById.get(tabId);
      if (!tab) continue;
      await manager.reload(
        tabId,
        workspace.writable &&
          (treeRef.current.entries[tab.relativePath]?.writable ?? true),
      );
    }
    if (adjustImageLinks) {
      const snapshot = manager.snapshot();
      const rewriteCandidates = new Set([
        ...impact.pathRemaps.map((item) => item.tabId),
        ...impact.markdownRewrites.map((item) => item.tabId),
      ]);
      const rewriteRemaps = [...rewriteCandidates].flatMap((tabId) => {
        const tab = snapshot.collection.tabsById.get(tabId);
        const runtime = snapshot.runtimes.get(tabId);
        const pathRemap = impact.pathRemaps.find(
          (item) => item.tabId === tabId,
        );
        if (
          !tab ||
          runtime?.incarnation !== tab.incarnation ||
          runtime.session.status !== "ready"
        ) {
          return [];
        }
        const previousDocumentPath =
          pathRemap?.previousPath ?? tab.relativePath;
        const markdown = rewriteMarkdownImageLinksForMove(
          runtime.session.markdown,
          previousDocumentPath,
          tab.relativePath,
          previousPath,
          nextPath,
        );
        if (markdown === runtime.session.markdown) return [];
        return [{
          tabId,
          incarnation: tab.incarnation,
          path: {
            relativePath: tab.relativePath,
            identity: tab.pathIdentity,
          },
          markdown,
          expectedGeneration: runtime.session.generation,
          expectedEditVersion: runtime.session.editVersion,
        }];
      });
      if (rewriteRemaps.length > 0) {
        manager.remapTabsAtomically(rewriteRemaps);
        const results = await manager.settleTabs(
          rewriteRemaps.map(({ tabId, incarnation }) => ({
            tabId,
            incarnation,
          })),
          {
            // The manager just committed rewritten Markdown. The mounted active
            // adapter still projects the pre-move text until React reconciles.
            captureActiveProjection: false,
          },
        );
        if (results.some((item) => item.outcome.status === "blocked")) {
          setLifecycleNotice(
            "目录已移动，但部分图片链接尚未安全写回；相关页签保持打开并显示真实保存状态。",
          );
        }
      }
    }
    syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
  }

  async function moveToTrash() {
    if (!deleteTarget || mutationInFlightRef.current) return;
    const target = deleteTarget;
    const snapshot = tabManagerRef.current?.snapshot() ?? null;
    const impact = snapshot
      ? analyzeWorkspaceTabPathImpact(snapshot, {
          kind: "delete",
          sourcePath: target.relativePath,
        })
      : null;
    if (impact && impact.affectedTabIds.length > 0) {
      setDeleteTarget(null);
      await requestTabSettlement(
        impact.affectedTabIds,
        "delete_entry",
        `移到废纸篓并关闭 ${impact.affectedTabIds.length} 个页签`,
        async (targets) => performTrash(target, targets),
      );
      return;
    }
    await performTrash(target, []);
  }

  async function performTrash(
    target: FsEntry,
    settledTargets: readonly WorkspaceTabSettlementTarget[],
  ) {
    mutationInFlightRef.current = true;
    const mutationId = crypto.randomUUID();
    commitTree((current) => beginWorkspaceTreeMutation(current, mutationId, "trash", target.relativePath));
    setBusyLabel("正在移到系统废纸篓");
    try {
      const result = await gateway.trash(workspace.id, target.relativePath);
      await finishDelete(mutationId, result, settledTargets);
      setDeleteTarget(null);
    } catch (reason) {
      const error = normalizeDesktopError(reason, "trash_unavailable");
      commitTree((current) => applyWorkspaceTreeMutationFailure(current, mutationId, error));
      setDeleteTarget(null);
      if (error.code === "trash_unavailable") {
        setPermanentDeleteTarget(target);
        setPermanentDeleteTabTargets(settledTargets);
      } else {
        setPageError(error);
      }
    } finally {
      mutationInFlightRef.current = false;
      setBusyLabel(null);
    }
  }

  async function finishDelete(
    mutationId: string,
    result: DeleteResult,
    settledTargets: readonly WorkspaceTabSettlementTarget[] = [],
  ) {
    commitTree((current) => applyWorkspaceTreeDeleteSuccess(current, mutationId, result));
    if (selectedPath && isSameOrInside(selectedPath, result.relativePath)) {
      setSelectedPath(null);
    }
    const manager = tabManagerRef.current;
    if (manager && settledTargets.length > 0) {
      const snapshot = manager.snapshot();
      const recoveryToDelete = settledTargets.flatMap((target) => {
        const session = snapshot.runtimes.get(target.tabId)?.session;
        return session?.status === "ready" &&
          session.recoveryState.kind === "available"
          ? [session.recoveryState.snapshotId]
          : [];
      });
      try {
        await manager.closeTabsAtomically(settledTargets, {
          recordRecent: false,
        });
      } catch {
        setLifecycleNotice(
          "磁盘删除已完成，但页签内容随后发生变化；页签保持打开，请另存仍需保留的内容。",
        );
        syncActiveTabChrome(
          manager.snapshot().activeTab?.relativePath ?? null,
        );
        return;
      }
      await Promise.all(
        recoveryToDelete.map((snapshotId) =>
          gateway.recoveryGateway
            .delete(snapshotId, workspace.id)
            .catch(() => false),
        ),
      );
      setRecoverySnapshots((items) =>
        items.filter((item) => !recoveryToDelete.includes(item.snapshotId)),
      );
      syncActiveTabChrome(manager.snapshot().activeTab?.relativePath ?? null);
    }
  }

  async function revealSelected() {
    if (!selectedEntry) return;
    setBusyLabel("正在系统文件管理器中定位");
    try {
      await gateway.reveal(workspace.id, selectedEntry.relativePath);
    } catch (reason) {
      setPageError(normalizeDesktopError(reason, "reveal_unavailable"));
    } finally {
      setBusyLabel(null);
    }
  }

  async function selectOtherWorkspace(kind: "folder" | "markdown") {
    if (openInFlightRef.current) return;
    openInFlightRef.current = true;
    setBusyLabel(kind === "folder" ? "正在选择其他文件夹" : "正在选择 Markdown 文件");
    setPageError(null);
    try {
      const outcome = kind === "folder" ? await gateway.selectFolder() : await gateway.selectMarkdown();
      await consumeSelection(outcome);
    } catch (reason) {
      setPageError(normalizeDesktopError(reason, "selection_unavailable"));
    } finally {
      openInFlightRef.current = false;
      setBusyLabel(null);
    }
  }

  selectOtherWorkspaceRef.current = selectOtherWorkspace;

  async function consumeSelection(outcome: WorkspaceSelectionOutcome) {
    if (outcome.status === "cancelled") return;
    if (outcome.status === "already_open") {
      await coordinate(outcome.workspaceId);
      return;
    }
    if (outcome.status === "confirmation_required") {
      setConfirmation({ proposal: outcome.proposal });
      return;
    }
    const descriptor = await gateway.authorize(outcome.proposal.selectionId, false);
    await coordinate(descriptor.id);
  }

  async function authorizePending() {
    if (!confirmation) return;
    const pending = confirmation;
    setConfirmation(null);
    setBusyLabel("正在授权本地范围");
    try {
      const descriptor = await gateway.authorize(pending.proposal.selectionId, true);
      await coordinate(descriptor.id);
    } catch (reason) {
      setPageError(normalizeDesktopError(reason, "selection_unavailable"));
    } finally {
      setBusyLabel(null);
    }
  }

  async function cancelPending() {
    if (!confirmation) return;
    const selectionId = confirmation.proposal.selectionId;
    setConfirmation(null);
    await gateway.cancelSelection(selectionId).catch(() => false);
  }

  async function coordinate(
    workspaceId: string,
    disposition?: WorkspaceOpenDisposition,
  ) {
    const outcome = await gateway.open(workspaceId, disposition);
    if (outcome.status === "decision_required") {
      setDecisionError(null);
      setDecision({ outcome });
      return;
    }
    if (outcome.status === "opened_current") {
      onWorkspaceChanged(outcome.workspace);
    }
  }

  async function chooseDisposition(
    disposition: WorkspaceOpenDisposition,
    remember: boolean,
  ) {
    if (!decision) return;
    if (disposition === "cancel") {
      setDecision(null);
      setDecisionError(null);
      return;
    }
    const pending = decision;
    setDecisionProcessing(true);
    setDecisionError(null);
    if (remember) {
      try {
        await gateway.setOpenPreference(disposition);
      } catch (reason) {
        setDecisionError(
          normalizeDesktopError(reason, "preferences_write_failed"),
        );
        setDecisionProcessing(false);
        return;
      }
    }
    try {
      await coordinate(pending.outcome.workspace.id, disposition);
      setDecision(null);
    } catch (reason) {
      setDecisionError(
        normalizeDesktopError(reason, "window_create_failed"),
      );
    } finally {
      setDecisionProcessing(false);
    }
  }

  function closeDrawer() {
    setDrawerOpen(false);
    queueMicrotask(() => drawerTriggerRef.current?.focus());
  }

  function retryPageOperation() {
    const error = pageError;
    setPageError(null);
    if (!error) return;
    if (error.code === "scan_not_found" || error.code === "scan_unavailable") {
      void scanDirectory(workspace, null);
      return;
    }
    if (
      error.code === "watch_not_found" ||
      error.code === "watch_unavailable" ||
      error.code === "path_not_found" ||
      error.code === "permission_denied"
    ) {
      void startWatchLoop(workspace, generationRef.current, true);
      return;
    }
    if (error.code === "window_title_failed") {
      void gateway.setTitle(activeDocumentPath).catch((reason) => {
        setPageError(normalizeDesktopError(reason, "window_title_failed"));
      });
      return;
    }
    if (error.code === "menu_update_failed") {
      void syncEditorMenu();
      return;
    }
    if (error.code === "reveal_unavailable" && selectedEntry) void revealSelected();
  }

  const pageRetryAvailable = pageError
    ? supportsPageRetry(pageError, selectedEntry !== null)
    : false;
  const operationProcessing = mutationProcessing || operationInspecting;
  const operationDescription = operation?.moveRisk
    ? `${
        operation.moveRisk.inspectionLimited
          ? "未能完整检查所选目录；"
          : operation.moveRisk.configuredAssetDirectoryAffected
            ? "所选目录包含当前工作区配置的资源目录；"
            : "所选目录中包含受支持的图片文件；"
      }移动后，未打开 Markdown 文档中的相对图片链接可能失效。Plainroot 不会自动批量改写其他文档。`
    : "只有磁盘操作成功后，文件树才会更新。";
  const operationSubmitLabel = operationInspecting
    ? "正在检查…"
    : mutationProcessing
      ? "正在提交…"
      : operation?.moveRisk
        ? "继续移动（链接可能失效）"
        : "提交到磁盘";

  const statusText = useMemo(() => {
    if (busyLabel) return busyLabel;
    if (lifecycleNotice) return lifecycleNotice;
    if (tree.watch.status === "root_missing") return "工作区目录已失效";
    if (tree.watch.status === "permission_denied") return "工作区权限已撤销";
    if (tree.watch.status === "failed") return "文件监听已停止，可手动刷新";
    if (rootLoading) return `正在读取文件树${rootScan?.processed ? ` · ${rootScan.processed} 项` : ""}`;
    return "文件树已同步";
  }, [busyLabel, lifecycleNotice, rootLoading, rootScan?.processed, tree.watch.status]);

  return (
    <main className="workbench" aria-label="Plainroot Markdown 工作台">
      <header className="workbench__titlebar">
        <button
          aria-expanded={drawerOpen}
          aria-label="显示文件目录"
          className="workbench__drawer-trigger"
          onClick={() => setDrawerOpen(true)}
          ref={drawerTriggerRef}
          type="button"
        >
          ☰
        </button>
        <div className="workbench__workspace-title">
          <strong>{workspace.displayName}</strong>
          <span>{activeDocumentPath ?? selectedPath ?? workspace.canonicalRoot}</span>
        </div>
        <button className="plainroot-button" onClick={() => void selectOtherWorkspace("folder")} type="button">
          打开其他目录
        </button>
        {recoverySnapshots.length > 0 ? (
          <button
            className="plainroot-button"
            onClick={() => setRecoveryOpen(true)}
            type="button"
          >
            恢复内容 {recoverySnapshots.length}
          </button>
        ) : null}
      </header>

      <WorkspaceTabBar
        closingTabIds={closingTabIds}
        onActivate={activateWorkspaceTab}
        onClose={closeWorkspaceTab}
        onCloseMany={closeWorkspaceTabs}
        onDiscardRecent={discardRecentlyClosed}
        onMove={moveWorkspaceTab}
        onReopen={reopenWorkspaceTab}
        snapshot={tabSnapshot}
      />

      <TabSettlementDialog
        batch={settlementChild ? null : settlementBatch}
        busyTabIds={settlementBusyTabIds}
        finalActionLabel={settlementFinalLabel}
        onCancel={() => void cancelTabSettlement()}
        onCommit={() => void commitTabSettlement()}
        onDiscard={resolveTabSettlementByDiscard}
        onResolveConflict={(tabId) =>
          openSettlementChild(tabId, "conflict")
        }
        onRetry={(tabId) => void retryTabSettlement(tabId)}
        onSaveCopy={(tabId) => openSettlementChild(tabId, "save_copy")}
        resolutions={settlementResolutions}
        snapshot={tabSnapshot}
      />

      {pageError ? (
        <div className="workbench__page-error">
          <AsyncStatePanel
            actions={<><button className="plainroot-button" onClick={() => setPageError(null)} type="button">关闭</button>{pageRetryAvailable ? <button className="plainroot-button" onClick={retryPageOperation} type="button">重试</button> : null}</>}
            description={`${desktopErrorMessage(pageError)}${pageError.contentSafe ? " 当前磁盘内容未被这次失败覆盖。" : " 请先刷新并核对磁盘内容。"}`}
            state={pageError.code === "permission_denied" ? "permission_denied" : pageError.code === "path_not_found" ? "missing" : "error"}
            title="操作没有完成"
          />
        </div>
      ) : null}

      <div className="workbench__body">
        {drawerOpen ? <button aria-label="关闭文件目录遮罩" className="workbench__drawer-backdrop" onClick={closeDrawer} type="button" /> : null}
        <aside
          aria-label="文件目录"
          className="workbench__files"
          data-drawer-open={drawerOpen || undefined}
          ref={drawerRef}
          tabIndex={-1}
        >
          <div className="workbench__files-heading">
            <div><span>工作区</span><strong>{workspace.displayName}</strong></div>
            <button aria-label="关闭文件目录" className="workbench__drawer-close" onClick={closeDrawer} type="button">×</button>
          </div>
          <div className="workbench__tree-actions" aria-label="文件操作">
            <button disabled={!workspace.writable || operationProcessing} onClick={() => openOperation("create_file")} title={workspace.writable ? "新建 Markdown 文档" : "工作区只读，无法新建文档"} type="button">＋文档</button>
            <button disabled={!workspace.writable || operationProcessing} onClick={() => openOperation("create_directory")} title={workspace.writable ? "新建文件夹" : "工作区只读，无法新建文件夹"} type="button">＋文件夹</button>
            <button onClick={() => void scanDirectory(workspace, null)} title="刷新文件树" type="button">↻</button>
          </div>
          {selectedEntry ? (
            <div className="workbench__selection-actions" aria-label={`操作 ${selectedEntry.name}`}>
              <span title={selectedEntry.relativePath}>{selectedEntry.name}</span>
              <div>
                <button disabled={!selectedEntry.writable || operationProcessing} onClick={() => openOperation("rename")} type="button">重命名</button>
                <button disabled={!selectedEntry.writable || operationProcessing} onClick={() => openOperation("move")} type="button">移动</button>
                <button onClick={() => void revealSelected()} type="button">定位</button>
                <button className="is-danger" disabled={!selectedEntry.writable || operationProcessing} onClick={() => {
                  setDeleteTarget(selectedEntry);
                }} type="button">删除</button>
              </div>
            </div>
          ) : null}
          <div className="workbench__tree-scroll">
            {rootLoading && (tree.children[""]?.length ?? 0) === 0 ? (
              <AsyncStatePanel compact description="文件会分批出现，不阻塞窗口操作。" state="loading" title="正在读取目录" />
            ) : null}
            <WorkspaceTree
              expanded={expanded}
              onSelect={selectEntry}
              onToggle={toggleDirectory}
              selectedPath={selectedPath}
              state={tree}
            />
          </div>
        </aside>

        <section
          aria-label="文档编辑区"
          className="workbench__document"
          id="workspace-document-panel"
        >
          {tabRestoreIssues.length > 0 ? (
            <div className="workbench__document-warning">
              <AsyncStatePanel
                actions={
                  <>
                    <button
                      className="plainroot-button"
                      onClick={() => setTabRestoreIssues([])}
                      type="button"
                    >
                      跳过
                    </button>
                    <button
                      className="plainroot-button"
                      onClick={() => void retryTabRestoreIssues()}
                      type="button"
                    >
                      重新核对
                    </button>
                  </>
                }
                compact
                description={`${tabRestoreIssues
                  .slice(0, 3)
                  .map(
                    (issue) =>
                      `${issue.relativePath}：${desktopErrorMessage(issue.error)}`,
                  )
                  .join("；")}${
                  tabRestoreIssues.length > 3
                    ? `；另有 ${tabRestoreIssues.length - 3} 项`
                    : ""
                }。这些失败没有修改任何 Markdown 文件。`}
                state={
                  tabRestoreIssues.some(
                    (issue) => issue.error.code === "permission_denied",
                  )
                    ? "permission_denied"
                    : tabRestoreIssues.some(
                          (issue) => issue.error.code === "path_not_found",
                        )
                      ? "missing"
                      : "error"
                }
                title={`有 ${tabRestoreIssues.length} 个页签未恢复`}
              />
            </div>
          ) : null}
          {documentState.status === "ready" &&
          documentState.saveState.kind === "save_failed" &&
          documentState.saveState.error.code === "path_not_found" ? (
            <div className="workbench__document-warning">
              <AsyncStatePanel
                actions={
                  <>
                    <button
                      className="plainroot-button"
                      onClick={() => setSaveCopyOpen(true)}
                      type="button"
                    >
                      另存副本
                    </button>
                    <button
                      className="plainroot-button"
                      onClick={() => void closeExternallyDeletedDocument()}
                      type="button"
                    >
                      安全关闭文档
                    </button>
                  </>
                }
                compact
                description="原文件已被外部删除。Plainroot 不会在没有安全副本时丢弃当前内存内容。"
                state="missing"
                title="原文件已不存在"
              />
            </div>
          ) : null}
          <DocumentView
            activeTab={activeTab}
            assetGateway={gateway.assetGateway}
            editorHandleRef={editorHandleRef}
            onMetricsChange={setDocumentMetrics}
            onAdapterLifecycle={(event) => {
              if (!activeTab) return;
              if (event.phase === "mounted") {
                tabManagerRef.current?.noteAdapterMounted(
                  activeTab.tabId,
                  activeTab.incarnation,
                  event.mode,
                );
              } else {
                tabManagerRef.current?.noteAdapterUnmounted(
                  activeTab.tabId,
                  activeTab.incarnation,
                  event.mode,
                );
              }
            }}
            onResolveConflict={() => setConflictOpen(true)}
            onRetry={(path) => void openMarkdown(path)}
            onRuntimeStateChange={setEditorRuntime}
            onSave={() => void saveControllerRef.current?.manualSave()}
            onSaveCopy={() => setSaveCopyOpen(true)}
            onSessionChange={commitDocument}
            state={documentState}
          />
        </section>
      </div>

      <DocumentStatusBar
        activity={statusText}
        metrics={documentMetrics}
        session={documentState}
        workspaceWritable={workspace.writable}
      />

      <AppDialog
        actions={<><button className="plainroot-button" disabled={operationProcessing} onClick={() => setOperation(null)} type="button">取消</button><button className="plainroot-button plainroot-button--primary" disabled={operationProcessing || (!operation?.value.trim() && operation?.kind !== "move")} onClick={() => void submitOperation()} type="button">{operationSubmitLabel}</button></>}
        closeDisabled={operationProcessing}
        describedBy="workbench-operation-description"
        labelledBy="workbench-operation-title"
        onRequestClose={() => setOperation(null)}
        open={Boolean(operation)}
      >
        <div className="workbench-dialog-copy">
          <h2 id="workbench-operation-title">{operation?.title}</h2>
          <p
            aria-live={operation?.moveRisk ? "assertive" : undefined}
            id="workbench-operation-description"
          >
            {operationDescription}
          </p>
          <label>{operation?.label}<input autoFocus disabled={operationProcessing} onChange={(event) => {
            setOperation((current) => current ? { ...current, value: event.target.value } : null);
          }} value={operation?.value ?? ""} /></label>
          {operation?.kind === "move" &&
          (operation.localImageCount ?? 0) > 0 ? (
            <label>
              <input
                checked={operation.adjustImageLinks}
                onChange={(event) =>
                  setOperation((current) =>
                    current
                      ? {
                          ...current,
                          adjustImageLinks: event.currentTarget.checked,
                        }
                      : null,
                  )
                }
                type="checkbox"
              />
              移动后同步调整 {operation.localImageCount} 个本地图片链接
            </label>
          ) : null}
          {operationError ? <p aria-live="assertive" className="workbench-dialog-copy__error">{desktopErrorMessage(operationError)}</p> : null}
        </div>
      </AppDialog>

      <AppDialog
        actions={<><button className="plainroot-button" disabled={mutationProcessing} onClick={() => setDeleteTarget(null)} type="button">取消</button><button className="plainroot-button plainroot-button--danger" disabled={mutationProcessing} onClick={() => void moveToTrash()} type="button">{mutationProcessing ? "正在移动…" : "移到废纸篓"}</button></>}
        closeDisabled={mutationProcessing}
        describedBy="trash-description"
        labelledBy="trash-title"
        onRequestClose={() => setDeleteTarget(null)}
        open={Boolean(deleteTarget)}
      >
        <div className="workbench-dialog-copy"><h2 id="trash-title">删除“{deleteTarget?.name}”？</h2><p id="trash-description">Plainroot 会先安全结算所有受影响页签，再请求系统废纸篓或回收站。系统能力不可用时，才会另行询问是否永久删除。</p></div>
      </AppDialog>

      {permanentDeleteTarget ? (
        <PermanentDeleteDialog
          onClose={() => {
            setPermanentDeleteTarget(null);
            setPermanentDeleteTabTargets([]);
          }}
          onDeleted={(result) => {
            const mutationId = treeRef.current.mutation?.id ?? crypto.randomUUID();
            if (!treeRef.current.mutation) {
              commitTree((current) => beginWorkspaceTreeMutation(current, mutationId, "permanent", result.relativePath));
            }
            void finishDelete(
              mutationId,
              result,
              permanentDeleteTabTargets,
            ).finally(() => {
              setPermanentDeleteTarget(null);
              setPermanentDeleteTabTargets([]);
            });
          }}
          open
          relativePath={permanentDeleteTarget.relativePath}
          workspaceId={workspace.id}
        />
      ) : null}

      {documentState.status === "ready" ? (
        <>
          <ConflictDialog
            gateway={gateway.saveGateway}
            onClose={() => {
              setConflictOpen(false);
              setSettlementChild(null);
            }}
            onOverwrite={(result) => void applyConflictOverwrite(result)}
            onReload={reloadConflictFromDisk}
            onSaveCopy={() => {
              setConflictOpen(false);
              setSaveCopyOpen(true);
              setSettlementChild((current) =>
                current ? { ...current, kind: "save_copy" } : current,
              );
            }}
            open={
              conflictOpen && documentState.saveState.kind === "conflict"
            }
            session={documentState}
          />
          <SaveCopyDialog
            gateway={gateway.saveGateway}
            onClose={() => {
              setSaveCopyOpen(false);
              setSettlementChild(null);
            }}
            onSaved={(result) => {
              const current = documentStateRef.current;
              if (current.status === "ready") {
                setSavedCopyEvidence({
                  generation: current.generation,
                  editVersion: current.editVersion,
                  displayPath: result.displayPath,
                });
                if (settlementChild) {
                  setSettlementResolutions((resolutions) => {
                    const next = new Map(resolutions);
                    next.set(
                      settlementChild.tabId,
                      settlementResolutionFor(current, {
                        kind: "save_copy",
                        displayPath: result.displayPath,
                      }),
                    );
                    return next;
                  });
                }
              }
              setSaveCopyOpen(false);
              setSettlementChild(null);
              setLifecycleNotice(`副本已保存到 ${result.displayPath}`);
            }}
            open={saveCopyOpen}
            session={documentState}
          />
        </>
      ) : null}

      <RecoveryDialog
        gateway={gateway.recoveryGateway}
        onClose={() => setRecoveryOpen(false)}
        onDeleted={(snapshotId) =>
          setRecoverySnapshots((items) =>
            items.filter((item) => item.snapshotId !== snapshotId),
          )
        }
        onRestore={restoreSnapshot}
        open={recoveryOpen && recoverySnapshots.length > 0}
        snapshots={recoverySnapshots}
      />

      <AppDialog
        actions={<><button className="plainroot-button" onClick={() => void cancelPending()} type="button">取消</button><button className="plainroot-button plainroot-button--primary" onClick={() => void authorizePending()} type="button">授权并继续</button></>}
        describedBy="workbench-scope-description"
        labelledBy="workbench-scope-title"
        onRequestClose={() => void cancelPending()}
        open={Boolean(confirmation)}
      >
        <div className="workbench-dialog-copy"><h2 id="workbench-scope-title">确认新的本地访问范围</h2><p id="workbench-scope-description">当前工作区保持不变，直到你完成后续窗口选择。</p><dl><dt>所选位置</dt><dd>{confirmation?.proposal.selectedPath}</dd><dt>实际范围</dt><dd>{confirmation?.proposal.canonicalRoot}</dd></dl></div>
      </AppDialog>

      <WorkspaceOpenDecisionDialog
        error={decisionError}
        onChoose={(disposition, remember) =>
          void chooseDisposition(disposition, remember)
        }
        open={Boolean(decision)}
        outcome={decision?.outcome ?? null}
        processing={decisionProcessing}
      />

      <WorkspaceOpenPreferenceDialog
        gateway={gateway}
        onClose={() => setOpenPreferenceOpen(false)}
        open={openPreferenceOpen}
      />
    </main>
  );
}

function DocumentView({
  activeTab,
  assetGateway,
  editorHandleRef,
  onMetricsChange,
  onAdapterLifecycle,
  onResolveConflict,
  state,
  onRetry,
  onRuntimeStateChange,
  onSave,
  onSaveCopy,
  onSessionChange,
}: {
  activeTab: WorkspaceTabManagerSnapshot["activeTab"];
  assetGateway: WorkspaceWorkbenchGateway["assetGateway"];
  editorHandleRef: RefObject<DocumentEditorShellHandle | null>;
  onMetricsChange(metrics: DocumentEditorMetrics): void;
  onAdapterLifecycle: NonNullable<
    ComponentProps<typeof DocumentEditorShell>["onAdapterLifecycle"]
  >;
  onResolveConflict(): void;
  state: DocumentSessionState;
  onRetry(path: WorkspaceRelativePath): void;
  onRuntimeStateChange(state: DocumentEditorRuntimeState): void;
  onSave(): void;
  onSaveCopy(): void;
  onSessionChange(session: ReadyDocumentSession): void;
}) {
  if (
    activeTab?.loadState.kind === "idle" &&
    state.status === "empty"
  ) {
    return (
      <AsyncStatePanel
        description={activeTab.relativePath}
        state="unloaded"
        title="等待载入文档"
      />
    );
  }
  if (state.status === "empty") {
    return <div className="workbench__document-empty"><span aria-hidden="true">M↓</span><h1>选择一份 Markdown 文档</h1><p>文档会在当前窗口的新页签中打开；也可以从“所有页签”重新打开最近关闭的文档。</p></div>;
  }
  if (state.status === "loading") {
    return <AsyncStatePanel description={state.relativePath} state="loading" title="正在读取文档" />;
  }
  if (state.status === "unavailable" && state.reason !== "read_failed") {
    const title = state.reason === "too_large" ? "文档超过当前查看上限" : "文档不是受支持的 UTF-8 编码";
    return <AsyncStatePanel description="Plainroot 没有修改这个文件。请使用其他工具转换或缩小后重试。" state="unsupported" title={title} />;
  }
  if (state.status === "unavailable") {
    const error = state.error;
    return <AsyncStatePanel actions={<button className="plainroot-button" onClick={() => onRetry(state.relativePath)} type="button">重试读取</button>} description={`${error ? desktopErrorMessage(error) : "文档读取结果不完整。"} 当前内存中没有可安全展示的旧内容。`} state={error?.code === "permission_denied" ? "permission_denied" : error?.code === "path_not_found" ? "missing" : "error"} title="无法读取文档" />;
  }
  return (
    <DocumentEditorShell
      assetGateway={assetGateway}
      key={
        activeTab
          ? `${activeTab.tabId}:${activeTab.incarnation}`
          : "no-active-tab"
      }
      onAdapterLifecycle={onAdapterLifecycle}
      onMetricsChange={onMetricsChange}
      onResolveConflict={onResolveConflict}
      onRuntimeStateChange={onRuntimeStateChange}
      onSave={onSave}
      onSaveCopy={onSaveCopy}
      onSessionChange={onSessionChange}
      ref={editorHandleRef}
      session={state}
    />
  );
}

function workbenchMenuActionAvailable(
  state: EditorMenuState,
  action: WorkbenchMenuAction,
): boolean {
  if (!state.hasDocument || state.busy) return false;
  switch (action) {
    case "file.save":
      return !state.readOnly;
    case "file.save_copy":
    case "edit.find":
      return true;
    case "edit.undo":
      return !state.readOnly && state.canUndo;
    case "edit.redo":
      return !state.readOnly && state.canRedo;
    case "view.visual":
      return state.mode !== "visual";
    case "view.source":
      return state.mode !== "source";
  }
}

function pathImpactForOperation(
  snapshot: WorkspaceTabManagerSnapshot | null,
  operation: PendingOperation,
  selectedEntry: FsEntry | null,
): WorkspaceTabPathImpact | null {
  if (
    !snapshot ||
    !selectedEntry ||
    (operation.kind !== "rename" && operation.kind !== "move")
  ) {
    return null;
  }
  const targetPath =
    operation.kind === "rename"
      ? joinWorkspacePath(
          parentPath(selectedEntry.relativePath),
          operation.value.trim(),
        )
      : joinWorkspacePath(
          operation.value.trim() || null,
          selectedEntry.name,
        );
  const mutation: WorkspaceTabPathMutation = {
    kind: operation.kind,
    sourcePath: selectedEntry.relativePath,
    targetPath,
  };
  return analyzeWorkspaceTabPathImpact(snapshot, mutation);
}

function joinWorkspacePath(
  parent: WorkspaceRelativePath | null,
  name: string,
): WorkspaceRelativePath {
  return (parent ? `${parent}/${name}` : name) as WorkspaceRelativePath;
}

function recoveryUnavailableError(
  state: DocumentSessionState,
): DesktopError | null {
  if (state.status !== "unavailable") return null;
  if (state.error) return state.error;
  return normalizeDesktopError(
    null,
    state.reason === "too_large"
      ? "file_too_large"
      : state.reason === "unsupported_encoding"
        ? "unsupported_text_encoding"
        : "editor_save_unavailable",
  );
}

function tabSessionGateway(
  gateway: WorkspaceWorkbenchGateway,
): WorkspaceTabSessionGateway {
  return {
    resolvePath: gateway.resolveTabPath,
    read: gateway.read,
    saveGateway: gateway.saveGateway,
    recoveryGateway: gateway.recoveryGateway,
    parser: remarkMarkdownCompatibilityParser,
  };
}

function shouldProtectBeforeRecovery(
  session: ReadyDocumentSession,
  recoveryMarkdown: string,
): boolean {
  return (
    session.markdown !== recoveryMarkdown &&
    session.saveState.kind !== "clean" &&
    session.saveState.kind !== "saved" &&
    session.saveState.kind !== "readonly"
  );
}

function settlementMessage(result: Extract<DocumentSaveOutcome, { status: "blocked" }>) {
  switch (result.reason) {
    case "conflict":
      return "磁盘版本已变化，当前内容已保留；解决冲突前不会关闭或替换窗口。";
    case "failed":
      return "保存没有完成，当前内容已保留；重试保存前不会关闭或替换窗口。";
    case "readonly":
      return "当前文档无法写入，窗口保持打开。";
    case "stale":
      return "文档仍在变化，窗口保持打开，请再次保存。";
  }
}

function supportsPageRetry(error: DesktopError, hasSelectedEntry: boolean) {
  if (!error.retryable) return false;
  return (
    error.code === "scan_not_found" ||
    error.code === "scan_unavailable" ||
    error.code === "watch_not_found" ||
    error.code === "watch_unavailable" ||
    error.code === "path_not_found" ||
    error.code === "permission_denied" ||
    error.code === "window_title_failed" ||
    error.code === "menu_update_failed" ||
    (error.code === "reveal_unavailable" && hasSelectedEntry)
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
