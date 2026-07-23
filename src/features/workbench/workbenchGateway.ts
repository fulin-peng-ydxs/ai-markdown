import type {
  DeleteResult,
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceMutationResult,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceRelativePath,
  WorkspaceScanBatch,
  WorkspaceScanStart,
  WorkspaceSelectionOutcome,
  WindowSettlementIntent,
  WindowSettlementResolution,
  WorkspaceWatchBatch,
  WorkspaceWatchStart,
} from "../../services/desktop/contracts";
import {
  cancelWorkspaceScan,
  createMarkdownFile,
  createWorkspaceDirectory,
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
  listenForLauncherMenu,
  resolveWindowSettlement,
  selectMarkdownFile,
  selectWorkspaceFolder,
  setWorkbenchWindowTitle,
  type LauncherMenuAction,
} from "../../services/desktop/workspace";
import type { EditorDocumentGateway } from "../editor/editorGateway";
import {
  desktopRecoveryGateway,
  desktopSaveGateway,
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
  listenSettlement(
    listener: (intent: WindowSettlementIntent) => void,
  ): Promise<() => void>;
  resolveSettlement(
    intentId: string,
    allow: boolean,
  ): Promise<WindowSettlementResolution>;
  saveGateway: EditorSaveGateway;
  recoveryGateway: EditorRecoveryGateway;
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
  listenSettlement: listenForWindowSettlement,
  resolveSettlement: resolveWindowSettlement,
  saveGateway: desktopSaveGateway,
  recoveryGateway: desktopRecoveryGateway,
};
