import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  WorkspaceDescriptor,
  WorkspaceMutationResult,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceRelativePath,
  WorkspaceSelectionOutcome,
  WorkspaceSelectionProposal,
  WindowSettlementIntent,
} from "../../services/desktop/contracts";
import { desktopErrorMessage, normalizeDesktopError } from "../../services/desktop/errors";
import {
  beginDocumentLoad,
  createEmptyDocumentSession,
  type DocumentSessionState,
  type ReadyDocumentSession,
} from "../editor/documentSession";
import {
  DocumentSaveController,
  type DocumentSaveOutcome,
} from "../editor/save/DocumentSaveController";
import {
  applyDocumentLoadOutcome,
  requestDocumentLoad,
} from "../editor/editorGateway";
import {
  DocumentEditorShell,
  type DocumentEditorMetrics,
} from "../editor/DocumentEditorShell";
import { remarkMarkdownCompatibilityParser } from "../editor/remarkMarkdownParser";
import { PermanentDeleteDialog } from "./PermanentDeleteDialog";
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
  const documentStateRef = useRef(documentState);
  const saveControllerRef = useRef<DocumentSaveController | null>(null);
  const [pageError, setPageError] = useState<DesktopError | null>(null);
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const [operationError, setOperationError] = useState<DesktopError | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<FsEntry | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null);
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

  const selectedEntry = selectedPath ? tree.entries[selectedPath] ?? null : null;
  const rootScan = tree.scans[""];
  const rootLoading = rootScan?.status === "loading";
  const mutationProcessing = tree.mutation?.status === "processing";
  const activeDocumentPath =
    documentState.status === "empty" ? null : documentState.relativePath;

  const commitDocument = useCallback((next: DocumentSessionState) => {
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
  }, [commitTree, gateway, scanDirectory]);

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
    commitDocument(
      createEmptyDocumentSession(documentStateRef.current.generation + 1),
    );
    setPageError(null);
    void gateway.setTitle(null).catch((reason) => {
      if (mountedRef.current && generation === generationRef.current) {
        setPageError(normalizeDesktopError(reason, "window_title_failed"));
      }
    });
    void scanDirectory(nextWorkspace, null, false, generation);
    void startWatchLoop(nextWorkspace, generation);
    if (nextWorkspace.initialFile) {
      void openMarkdown(nextWorkspace.initialFile, nextWorkspace, generation);
    }
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
    };
  }, [gateway, initialWorkspace, loadWorkspace]);

  useEffect(() => {
    const controller = new DocumentSaveController({
      getSession: () =>
        documentStateRef.current.status === "ready"
          ? documentStateRef.current
          : null,
      onSessionChange: commitDocument,
      saveGateway: gateway.saveGateway,
      recoveryGateway: gateway.recoveryGateway,
    });
    saveControllerRef.current = controller;
    controller.observe(
      documentStateRef.current.status === "ready"
        ? documentStateRef.current
        : null,
    );
    return () => {
      controller.dispose();
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
      }
    };
  }, [commitDocument, gateway]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void gateway.listenMenu((action) => {
      if (action === "file.open_folder") void selectOtherWorkspaceRef.current("folder");
      if (action === "file.open_markdown") void selectOtherWorkspaceRef.current("markdown");
    }).then((stop) => {
      unlisten = stop;
    }).catch(() => undefined);
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
      lifecycleNotice &&
      ready &&
      (ready.saveState.kind === "clean" || ready.saveState.kind === "saved")
    ) {
      setLifecycleNotice(null);
    }
  }, [documentState, lifecycleNotice]);

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

  async function openMarkdown(
    path: WorkspaceRelativePath,
    targetWorkspace = workspace,
    generation = generationRef.current,
  ) {
    const current = documentStateRef.current;
    if (
      current.status === "ready" &&
      (current.workspaceId !== targetWorkspace.id ||
        current.relativePath !== path)
    ) {
      const settlement = await settleCurrentDocument();
      if (settlement.status === "blocked") return;
    }
    setLifecycleNotice(null);
    setSelectedPath(path);
    const loading = beginDocumentLoad(documentStateRef.current, {
      workspaceId: targetWorkspace.id,
      relativePath: path,
    });
    commitDocument(loading);
    setDocumentMetrics(null);
    const outcome = await requestDocumentLoad(
      {
        generation: loading.generation,
        workspaceId: targetWorkspace.id,
        relativePath: path,
        writable:
          targetWorkspace.writable &&
          (treeRef.current.entries[path]?.writable ?? true),
      },
      gateway,
      remarkMarkdownCompatibilityParser,
    );
    if (!mountedRef.current || generation !== generationRef.current) return;
    const resolved = applyDocumentLoadOutcome(
      documentStateRef.current,
      outcome,
    );
    commitDocument(resolved);
    if (
      resolved.status !== "empty" &&
      resolved.generation === loading.generation &&
      resolved.relativePath === path
    ) {
      void gateway.setTitle(path).catch((reason) => {
        if (
          mountedRef.current &&
          generation === generationRef.current &&
          documentStateRef.current.generation === loading.generation
        ) {
          setPageError(normalizeDesktopError(reason, "window_title_failed"));
        }
      });
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

  async function resolveSettlementIntent(intent: WindowSettlementIntent) {
    const settlement = await settleCurrentDocument();
    try {
      const outcome = await gateway.resolveSettlement(
        intent.intentId,
        settlement.status !== "blocked",
      );
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
    const details: Record<OperationKind, PendingOperation> = {
      create_file: { kind, title: "新建 Markdown 文档", label: "文件名", value: "未命名文档.md" },
      create_directory: { kind, title: "新建文件夹", label: "文件夹名称", value: "新文件夹" },
      rename: { kind, title: `重命名“${selectedEntry?.name ?? ""}”`, label: "新名称", value: selectedEntry?.name ?? "" },
      move: { kind, title: `移动“${selectedEntry?.name ?? ""}”`, label: "目标文件夹（留空表示根目录）", value: parentPath(selectedEntry?.relativePath ?? "") ?? "" },
    };
    setOperationError(null);
    setOperation(details[kind]);
  }

  async function submitOperation() {
    if (!operation || mutationInFlightRef.current) return;
    const value = operation.value;
    if (!value.trim() && operation.kind !== "move") return;
    const currentDocument = documentStateRef.current;
    if (
      currentDocument.status === "ready" &&
      selectedEntry &&
      (operation.kind === "rename" || operation.kind === "move") &&
      isSameOrInside(currentDocument.relativePath, selectedEntry.relativePath)
    ) {
      const settlement = await settleCurrentDocument();
      if (settlement.status === "blocked") return;
    }
    const mutationId = crypto.randomUUID();
    mutationInFlightRef.current = true;
    const sourcePath = operation.kind === "rename" || operation.kind === "move"
      ? selectedEntry?.relativePath ?? null
      : null;
    commitTree((current) => beginWorkspaceTreeMutation(current, mutationId, operation.kind, sourcePath));
    setBusyLabel("正在提交磁盘变更");
    setOperationError(null);
    try {
      let result: WorkspaceMutationResult;
      if (operation.kind === "create_file") {
        result = await gateway.createFile(workspace.id, value, parentForCreate());
      } else if (operation.kind === "create_directory") {
        result = await gateway.createDirectory(workspace.id, value, parentForCreate());
      } else if (operation.kind === "rename" && selectedEntry) {
        result = await gateway.rename(workspace.id, selectedEntry.relativePath, value);
      } else if (operation.kind === "move" && selectedEntry) {
        result = await gateway.move(workspace.id, selectedEntry.relativePath, value.trim() || null);
      } else {
        return;
      }
      commitTree((current) => applyWorkspaceTreeMutationSuccess(current, mutationId, result));
      remapSelectionAfterMutation(result);
      setOperation(null);
      if (result.entry.kind === "markdown_file" && operation.kind === "create_file") {
        void openMarkdown(result.entry.relativePath);
      }
    } catch (reason) {
      const error = normalizeDesktopError(reason, "mutation_unavailable");
      commitTree((current) => applyWorkspaceTreeMutationFailure(current, mutationId, error));
      setOperationError(error);
    } finally {
      mutationInFlightRef.current = false;
      setBusyLabel(null);
    }
  }

  function remapSelectionAfterMutation(result: WorkspaceMutationResult) {
    if (!result.previousPath) return;
    const previousPath = result.previousPath;
    const nextPath = result.entry.relativePath;
    const documentPath =
      documentState.status === "empty" ? null : documentState.relativePath;
    setSelectedPath((current) => current ? replacePrefix(current, previousPath, nextPath) : null);
    setExpanded((current) => new Set([...current].map((path) => replacePrefix(path, previousPath, nextPath))));
    if (documentPath && isSameOrInside(documentPath, previousPath)) {
      void openMarkdown(replacePrefix(documentPath, previousPath, nextPath));
    }
  }

  async function moveToTrash() {
    if (!deleteTarget || mutationInFlightRef.current) return;
    const target = deleteTarget;
    const currentDocument = documentStateRef.current;
    if (
      currentDocument.status === "ready" &&
      isSameOrInside(currentDocument.relativePath, target.relativePath)
    ) {
      const settlement = await settleCurrentDocument();
      if (settlement.status === "blocked") return;
    }
    mutationInFlightRef.current = true;
    const mutationId = crypto.randomUUID();
    commitTree((current) => beginWorkspaceTreeMutation(current, mutationId, "trash", target.relativePath));
    setBusyLabel("正在移到系统废纸篓");
    try {
      const result = await gateway.trash(workspace.id, target.relativePath);
      finishDelete(mutationId, result);
      setDeleteTarget(null);
    } catch (reason) {
      const error = normalizeDesktopError(reason, "trash_unavailable");
      commitTree((current) => applyWorkspaceTreeMutationFailure(current, mutationId, error));
      setDeleteTarget(null);
      if (error.code === "trash_unavailable") {
        setPermanentDeleteTarget(target);
      } else {
        setPageError(error);
      }
    } finally {
      mutationInFlightRef.current = false;
      setBusyLabel(null);
    }
  }

  function finishDelete(mutationId: string, result: DeleteResult) {
    commitTree((current) => applyWorkspaceTreeDeleteSuccess(current, mutationId, result));
    if (selectedPath && isSameOrInside(selectedPath, result.relativePath)) {
      setSelectedPath(null);
    }
    const openDocumentPath =
      documentState.status === "empty" ? null : documentState.relativePath;
    if (openDocumentPath && isSameOrInside(openDocumentPath, result.relativePath)) {
      commitDocument(
        createEmptyDocumentSession(documentStateRef.current.generation + 1),
      );
      void gateway.setTitle(null).catch(() => undefined);
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
      setDecision({ outcome });
      return;
    }
    if (outcome.status === "opened_current") {
      onWorkspaceChanged(outcome.workspace);
    }
  }

  async function chooseDisposition(disposition: WorkspaceOpenDisposition) {
    if (!decision) return;
    const pending = decision;
    setDecision(null);
    setBusyLabel(disposition === "new_window" ? "正在创建新窗口" : "正在替换当前工作区");
    try {
      await coordinate(pending.outcome.workspace.id, disposition);
    } catch (reason) {
      setPageError(normalizeDesktopError(reason, "window_create_failed"));
    } finally {
      setBusyLabel(null);
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
    if (error.code === "reveal_unavailable" && selectedEntry) void revealSelected();
  }

  const pageRetryAvailable = pageError
    ? supportsPageRetry(pageError, selectedEntry !== null)
    : false;

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
      </header>

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
            <button disabled={!workspace.writable || mutationProcessing} onClick={() => openOperation("create_file")} title={workspace.writable ? "新建 Markdown 文档" : "工作区只读，无法新建文档"} type="button">＋文档</button>
            <button disabled={!workspace.writable || mutationProcessing} onClick={() => openOperation("create_directory")} title={workspace.writable ? "新建文件夹" : "工作区只读，无法新建文件夹"} type="button">＋文件夹</button>
            <button onClick={() => void scanDirectory(workspace, null)} title="刷新文件树" type="button">↻</button>
          </div>
          {selectedEntry ? (
            <div className="workbench__selection-actions" aria-label={`操作 ${selectedEntry.name}`}>
              <span title={selectedEntry.relativePath}>{selectedEntry.name}</span>
              <div>
                <button disabled={!selectedEntry.writable || mutationProcessing} onClick={() => openOperation("rename")} type="button">重命名</button>
                <button disabled={!selectedEntry.writable || mutationProcessing} onClick={() => openOperation("move")} type="button">移动</button>
                <button onClick={() => void revealSelected()} type="button">定位</button>
                <button className="is-danger" disabled={!selectedEntry.writable || mutationProcessing} onClick={() => setDeleteTarget(selectedEntry)} type="button">删除</button>
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

        <section className="workbench__document" aria-label="文档编辑区">
          <DocumentView
            onMetricsChange={setDocumentMetrics}
            onRetry={(path) => void openMarkdown(path)}
            onSave={() => void saveControllerRef.current?.manualSave()}
            onSessionChange={commitDocument}
            state={documentState}
          />
        </section>
      </div>

      <footer className="workbench__statusbar" aria-live="polite">
        <span>{statusText}</span>
        <span>{documentMetric(documentState, documentMetrics)}</span>
        <span>{workspace.writable ? "工作区可写" : "工作区只读"}</span>
      </footer>

      <AppDialog
        actions={<><button className="plainroot-button" disabled={mutationProcessing} onClick={() => setOperation(null)} type="button">取消</button><button className="plainroot-button plainroot-button--primary" disabled={mutationProcessing || (!operation?.value.trim() && operation?.kind !== "move")} onClick={() => void submitOperation()} type="button">{mutationProcessing ? "正在提交…" : "提交到磁盘"}</button></>}
        closeDisabled={mutationProcessing}
        describedBy="workbench-operation-description"
        labelledBy="workbench-operation-title"
        onRequestClose={() => setOperation(null)}
        open={Boolean(operation)}
      >
        <div className="workbench-dialog-copy">
          <h2 id="workbench-operation-title">{operation?.title}</h2>
          <p id="workbench-operation-description">只有磁盘操作成功后，文件树才会更新。</p>
          <label>{operation?.label}<input autoFocus onChange={(event) => setOperation((current) => current ? { ...current, value: event.target.value } : null)} value={operation?.value ?? ""} /></label>
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
        <div className="workbench-dialog-copy"><h2 id="trash-title">删除“{deleteTarget?.name}”？</h2><p id="trash-description">Plainroot 会先请求系统废纸篓或回收站。系统能力不可用时，才会另行询问是否永久删除。</p></div>
      </AppDialog>

      {permanentDeleteTarget ? (
        <PermanentDeleteDialog
          onClose={() => setPermanentDeleteTarget(null)}
          onDeleted={(result) => {
            const mutationId = treeRef.current.mutation?.id ?? crypto.randomUUID();
            if (!treeRef.current.mutation) {
              commitTree((current) => beginWorkspaceTreeMutation(current, mutationId, "permanent", result.relativePath));
            }
            finishDelete(mutationId, result);
          }}
          open
          relativePath={permanentDeleteTarget.relativePath}
          workspaceId={workspace.id}
        />
      ) : null}

      <AppDialog
        actions={<><button className="plainroot-button" onClick={() => void cancelPending()} type="button">取消</button><button className="plainroot-button plainroot-button--primary" onClick={() => void authorizePending()} type="button">授权并继续</button></>}
        describedBy="workbench-scope-description"
        labelledBy="workbench-scope-title"
        onRequestClose={() => void cancelPending()}
        open={Boolean(confirmation)}
      >
        <div className="workbench-dialog-copy"><h2 id="workbench-scope-title">确认新的本地访问范围</h2><p id="workbench-scope-description">当前工作区保持不变，直到你完成后续窗口选择。</p><dl><dt>所选位置</dt><dd>{confirmation?.proposal.selectedPath}</dd><dt>实际范围</dt><dd>{confirmation?.proposal.canonicalRoot}</dd></dl></div>
      </AppDialog>

      <AppDialog
        actions={<><button className="plainroot-button" onClick={() => void chooseDisposition("cancel")} type="button">取消</button><button className="plainroot-button" onClick={() => void chooseDisposition("new_window")} type="button">在新窗口打开</button><button className="plainroot-button plainroot-button--primary" onClick={() => void chooseDisposition("current_window")} type="button">替换当前窗口</button></>}
        describedBy="workbench-decision-description"
        labelledBy="workbench-decision-title"
        onRequestClose={() => void chooseDisposition("cancel")}
        open={Boolean(decision)}
      >
        <div className="workbench-dialog-copy"><h2 id="workbench-decision-title">在哪里打开“{decision?.outcome.workspace.displayName}”？</h2><p id="workbench-decision-description">当前阶段还没有编辑页签，因此替换只提交根工作区会话；后续页签阶段会在这里增加完整保存检查。</p></div>
      </AppDialog>
    </main>
  );
}

function DocumentView({
  onMetricsChange,
  state,
  onRetry,
  onSave,
  onSessionChange,
}: {
  onMetricsChange(metrics: DocumentEditorMetrics): void;
  state: DocumentSessionState;
  onRetry(path: WorkspaceRelativePath): void;
  onSave(): void;
  onSessionChange(session: ReadyDocumentSession): void;
}) {
  if (state.status === "empty") {
    return <div className="workbench__document-empty"><span aria-hidden="true">M↓</span><h1>选择一份 Markdown 文档</h1><p>文档会在当前窗口打开；页签将在后续阶段接入。</p></div>;
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
      onMetricsChange={onMetricsChange}
      onSave={onSave}
      onSessionChange={onSessionChange}
      session={state}
    />
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

function documentMetric(
  state: Parameters<typeof DocumentView>[0]["state"],
  metrics: DocumentEditorMetrics | null,
): string {
  if (state.status !== "ready") return "未打开文档";
  return metrics
    ? `${metrics.wordCount} 字/词 · ${metrics.characterCount} 字符`
    : `${state.markdown.length} 字符`;
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
    (error.code === "reveal_unavailable" && hasSelectedEntry)
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
