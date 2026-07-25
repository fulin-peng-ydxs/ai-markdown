import type { WorkspaceRelativePath } from "../../services/desktop/contracts";

declare const workspaceTabPathIdentityBrand: unique symbol;

/**
 * Opaque native path identity produced by Rust after resolving the authorized
 * workspace path. The frontend must never derive this value by lowercasing.
 */
export type WorkspaceTabPathIdentity = string & {
  readonly [workspaceTabPathIdentityBrand]: true;
};

export interface WorkspaceTabPath {
  relativePath: WorkspaceRelativePath;
  identity: WorkspaceTabPathIdentity;
}

/**
 * Accepts only Rust-normalized relative paths. The opaque identity carries
 * platform semantics such as Windows case folding and extended-path handling.
 */
export function acceptWorkspaceTabPath(input: {
  relativePath: WorkspaceRelativePath;
  identity: string;
}): WorkspaceTabPath {
  if (!isValidWorkspaceTabPath(input)) {
    throw new Error("Workspace tab path identity is invalid");
  }
  return {
    relativePath: input.relativePath,
    identity: input.identity as WorkspaceTabPathIdentity,
  };
}

export function isValidWorkspaceTabPath(input: {
  relativePath: WorkspaceRelativePath;
  identity: string;
}): boolean {
  return (
    isRustNormalizedRelativePath(input.relativePath) &&
    input.identity.length > 0 &&
    input.identity.length <= 8_192 &&
    !input.identity.includes("\0")
  );
}

function isRustNormalizedRelativePath(path: WorkspaceRelativePath): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return !segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":"),
  );
}
