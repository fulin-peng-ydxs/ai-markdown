import type {
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceLauncherSnapshot,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceSelectionOutcome,
} from "../../services/desktop/contracts";
import {
  authorizeWorkspaceSelection,
  cancelWorkspaceSelection,
  coordinateWorkspaceOpen,
  getWorkspaceLauncherSnapshot,
  listenForLauncherMenu,
  removeRecentWorkspace,
  removeWorkspaceSession,
  selectMarkdownFile,
  selectWorkspaceFolder,
  validateRecentWorkspace,
  type LauncherMenuAction,
} from "../../services/desktop/workspace";
import {
  desktopRecoveryGateway,
  type EditorRecoveryGateway,
} from "../editor/editorGateway";

export interface WorkspaceLauncherGateway {
  snapshot(): Promise<WorkspaceLauncherSnapshot>;
  selectFolder(): Promise<WorkspaceSelectionOutcome>;
  selectMarkdown(): Promise<WorkspaceSelectionOutcome>;
  validateRecent(workspaceId: WorkspaceId): Promise<WorkspaceSelectionOutcome>;
  authorize(selectionId: string, confirmed: boolean): Promise<WorkspaceDescriptor>;
  cancelSelection(selectionId: string): Promise<boolean>;
  open(
    workspaceId: WorkspaceId,
    disposition?: WorkspaceOpenDisposition,
  ): Promise<WorkspaceOpenOutcome>;
  removeRecent(workspaceId: WorkspaceId): Promise<boolean>;
  removeSession(workspaceId: WorkspaceId): Promise<boolean>;
  listenMenu(listener: (action: LauncherMenuAction) => void): Promise<() => void>;
  recoveryGateway: EditorRecoveryGateway;
}

export const desktopWorkspaceLauncherGateway: WorkspaceLauncherGateway = {
  snapshot: getWorkspaceLauncherSnapshot,
  selectFolder: selectWorkspaceFolder,
  selectMarkdown: selectMarkdownFile,
  validateRecent: validateRecentWorkspace,
  authorize: authorizeWorkspaceSelection,
  cancelSelection: cancelWorkspaceSelection,
  open: coordinateWorkspaceOpen,
  removeRecent: removeRecentWorkspace,
  removeSession: removeWorkspaceSession,
  listenMenu: listenForLauncherMenu,
  recoveryGateway: desktopRecoveryGateway,
};
