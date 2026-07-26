import type {
  WorkspaceId,
  WorkspaceRelativePath,
  WorkspaceTabPathContract,
} from "../../services/desktop/contracts";
import { readMarkdownFile } from "../../services/desktop/files";
import { resolveWorkspaceTabPath } from "../../services/desktop/windowSession";
import {
  desktopRecoveryGateway,
  desktopSaveGateway,
  type EditorDocumentGateway,
  type EditorRecoveryGateway,
  type EditorSaveGateway,
  type MarkdownCompatibilityParser,
} from "../editor/editorGateway";
import { remarkMarkdownCompatibilityParser } from "../editor/remarkMarkdownParser";

/**
 * The manager consumes one narrow gateway so production and component tests use
 * the same path-authority, read, save and recovery boundaries.
 */
export interface WorkspaceTabSessionGateway extends EditorDocumentGateway {
  resolvePath(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<WorkspaceTabPathContract>;
  saveGateway: EditorSaveGateway;
  recoveryGateway: EditorRecoveryGateway;
  parser: MarkdownCompatibilityParser;
}

export const desktopWorkspaceTabSessionGateway: WorkspaceTabSessionGateway = {
  resolvePath: resolveWorkspaceTabPath,
  read: readMarkdownFile,
  saveGateway: desktopSaveGateway,
  recoveryGateway: desktopRecoveryGateway,
  parser: remarkMarkdownCompatibilityParser,
};
