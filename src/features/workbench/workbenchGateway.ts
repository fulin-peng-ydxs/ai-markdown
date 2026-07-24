import type {
  DeleteResult,
  EditorMenuState,
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceMoveRisk,
  WorkspaceMutationResult,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
  WorkspaceSelectionOutcome,
  WindowSettlementIntent,
  WindowSettlementResolution,
  WorkbenchMenuAction,
  WorkspaceWatchBatch,
  WorkspaceWatchStart,
} from "../../services/desktop/contracts";
import {
  cancelWorkspaceScan,
  createMarkdownFile,
  createWorkspaceDirectory,
  inspectWorkspaceMoveRisk,
  moveWorkspaceEntry,
  pollWorkspaceScan,
  pollWorkspaceWatch,
  readMarkdownFile,
  renameWorkspaceEntry,
  restartWorkspaceWatch,
  revealWorkspaceEntry,
  startWorkspaceScan,
  startWorkspaceWatch,
  stopWorkspaceWatch,
  trashWorkspaceEntry,
} from "../../services/desktop/files";
import {
  authorizeWorkspaceSelection,
  cancelWorkspaceSelection,
  coordinateWorkspaceOpen,
  listenForWindowSettlement,
  listenForWorkbenchMenu,
  listenForLauncherMenu,
  resetEditorMenuState,
  resolveWindowSettlement,
  selectMarkdownFile,
  selectWorkspaceFolder,
  setWorkbenchWindowTitle,
  updateEditorMenuState,
  type LauncherMenuAction,
} from "../../services/desktop/workspace";
import type { EditorDocumentGateway } from "../editor/editorGateway";
import {
  desktopAssetGateway,
  desktopRecoveryGateway,
  desktopSaveGateway,
  type EditorAssetGateway,
  type EditorRecoveryGateway,
  type EditorSaveGateway,
} from "../editor/editorGateway";

export interface WorkspaceWorkbenchGateway extends EditorDocumentGateway {
  scan(workspaceId: WorkspaceId, directory: WorkspaceRelativePath | null): Promise<WorkspaceScanStart>;
  pollScan(scanId: string): Promise<WorkspaceScanBatch>;
  cancelScan(scanId: string): Promise<boolean>;
  watch(workspaceId: WorkspaceId): Promise<WorkspaceWatchStart>;
  restartWatch(workspaceId: WorkspaceId): Promise<WorkspaceWatchStart>;
  pollWatch(watchId: string): Promise<WorkspaceWatchBatch>;
  stopWatch(watchId: string): Promise<boolean>;
  createFile(workspaceId: WorkspaceId, name: string, parent: WorkspaceRelativePath | null): Promise<WorkspaceMutationResult>;
  createDirectory(workspaceId: WorkspaceId, name: string, parent: WorkspaceRelativePath | null): Promise<WorkspaceMutationResult>;
  rename(workspaceId: WorkspaceId, path: WorkspaceRelativePath, name: string): Promise<WorkspaceMutationResult>;
  inspectMoveRisk(workspaceId: WorkspaceId, path: WorkspaceRelativePath): Promise<WorkspaceMoveRisk>;
  move(workspaceId: WorkspaceId, path: WorkspaceRelativePath, target: WorkspaceRelativePath | null): Promise<WorkspaceMutationResult>;
  trash(workspaceId: WorkspaceId, path: WorkspaceRelativePath): Promise<DeleteResult>;
  reveal(workspaceId: WorkspaceId, path: WorkspaceRelativePath): Promise<void>;
  selectFolder(): Promise<WorkspaceSelectionOutcome>;
  selectMarkdown(): Promise<WorkspaceSelectionOutcome>;
  authorize(selectionId: string, confirmed: boolean): Promise<WorkspaceDescriptor>;
  cancelSelection(selectionId: string): Promise<boolean>;
  open(workspaceId: WorkspaceId, disposition?: WorkspaceOpenDisposition): Promise<WorkspaceOpenOutcome>;
  setTitle(path: WorkspaceRelativePath | null): Promise<void>;
  listenMenu(listener: (action: LauncherMenuAction) => void): Promise<() => void>;
  listenWorkbenchMenu(
    listener: (action: WorkbenchMenuAction) => void,
  ): Promise<() => void>;
  updateEditorMenu(state: EditorMenuState): Promise<void>;
  resetEditorMenu(): Promise<void>;
  listenSettlement(
    listener: (intent: WindowSettlementIntent) => void,
  ): Promise<() => void>;
  resolveSettlement(
    intentId: string,
    allow: boolean,
  ): Promise<WindowSettlementResolution>;
  saveGateway: EditorSaveGateway;
  recoveryGateway: EditorRecoveryGateway;
  assetGateway: EditorAssetGateway;
}

export const desktopWorkspaceWorkbenchGateway: WorkspaceWorkbenchGateway = {
  scan: startWorkspaceScan,
  pollScan: pollWorkspaceScan,
  cancelScan: cancelWorkspaceScan,
  watch: startWorkspaceWatch,
  restartWatch: restartWorkspaceWatch,
  pollWatch: pollWorkspaceWatch,
  stopWatch: stopWorkspaceWatch,
  read: readMarkdownFile,
  createFile: createMarkdownFile,
  createDirectory: createWorkspaceDirectory,
  rename: renameWorkspaceEntry,
  inspectMoveRisk: inspectWorkspaceMoveRisk,
  move: moveWorkspaceEntry,
  trash: trashWorkspaceEntry,
  reveal: revealWorkspaceEntry,
  selectFolder: selectWorkspaceFolder,
  selectMarkdown: selectMarkdownFile,
  authorize: authorizeWorkspaceSelection,
  cancelSelection: cancelWorkspaceSelection,
  open: coordinateWorkspaceOpen,
  setTitle: async (path) => {
    await setWorkbenchWindowTitle(path);
  },
  listenMenu: listenForLauncherMenu,
  listenWorkbenchMenu: listenForWorkbenchMenu,
  updateEditorMenu: updateEditorMenuState,
  resetEditorMenu: resetEditorMenuState,
  listenSettlement: listenForWindowSettlement,
  resolveSettlement: resolveWindowSettlement,
  saveGateway: desktopSaveGateway,
  recoveryGateway: desktopRecoveryGateway,
  assetGateway: desktopAssetGateway,
};
