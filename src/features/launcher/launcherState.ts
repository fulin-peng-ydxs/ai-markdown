import type {
  RecentWorkspace,
  WindowTabSessionSummary,
  WorkspaceId,
  WorkspaceLauncherSnapshot,
  WorkspaceSessionRoot,
} from "../../services/desktop/contracts";

export interface RestorableWorkspace {
  session: WorkspaceSessionRoot;
  recent: RecentWorkspace | null;
  summary: WindowTabSessionSummary | null;
}

export function filterRecentWorkspaces(
  workspaces: RecentWorkspace[],
  query: string,
): RecentWorkspace[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return workspaces;
  }
  return workspaces.filter(
    (workspace) =>
      workspace.displayName.toLocaleLowerCase().includes(normalized) ||
      workspace.canonicalRoot.toLocaleLowerCase().includes(normalized),
  );
}

export function restorableWorkspaces(
  snapshot: WorkspaceLauncherSnapshot,
): RestorableWorkspace[] {
  const active = new Set<WorkspaceId>(snapshot.activeWorkspaceIds);
  const recentById = new Map(
    snapshot.recentWorkspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const summaryByReference = new Map(
    snapshot.windowSessionSummaries.map((summary) => [
      `${summary.workspaceId}\u0000${summary.windowStateRef}`,
      summary,
    ]),
  );
  return snapshot.workspaceSessions
    .filter((session) => !active.has(session.workspaceId))
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
    .map((session) => ({
      session,
      recent: recentById.get(session.workspaceId) ?? null,
      summary: session.windowStateRef
        ? summaryByReference.get(
            `${session.workspaceId}\u0000${session.windowStateRef}`,
          ) ?? null
        : null,
    }));
}

export function formatLastOpened(timestamp: number, now = Date.now()): string {
  const difference = Math.max(0, now - timestamp);
  const day = 24 * 60 * 60 * 1000;
  if (difference < day) {
    return "今天";
  }
  if (difference < day * 2) {
    return "昨天";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}
