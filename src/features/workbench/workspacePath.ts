import type { WorkspaceRelativePath } from "../../services/desktop/contracts";

export function parentPath(
  path: WorkspaceRelativePath,
): WorkspaceRelativePath | null {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : path.slice(0, separator);
}

export function isSameOrInside(
  path: WorkspaceRelativePath,
  parent: WorkspaceRelativePath,
): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function replacePrefix(
  path: WorkspaceRelativePath,
  previous: WorkspaceRelativePath,
  next: WorkspaceRelativePath,
): WorkspaceRelativePath {
  if (path === previous) return next;
  return path.startsWith(`${previous}/`)
    ? `${next}${path.slice(previous.length)}`
    : path;
}
