import type { KeyboardEvent } from "react";

import type { FsEntry, WorkspaceRelativePath } from "../../services/desktop/contracts";
import type { WorkspaceTreeState } from "./workspaceTreeState";

interface WorkspaceTreeProps {
  state: WorkspaceTreeState;
  expanded: ReadonlySet<WorkspaceRelativePath>;
  selectedPath: WorkspaceRelativePath | null;
  onSelect(entry: FsEntry): void;
  onToggle(entry: FsEntry): void;
}

export function WorkspaceTree({
  state,
  expanded,
  selectedPath,
  onSelect,
  onToggle,
}: WorkspaceTreeProps) {
  const rootChildren = state.children[""] ?? [];

  if (rootChildren.length === 0 && state.scans[""]?.status === "ready") {
    return (
      <div className="workspace-tree__empty">
        <p>这个目录还没有 Markdown 文件或文件夹。</p>
        <span>可以从上方新建文档或文件夹。</span>
      </div>
    );
  }

  return (
    <div aria-label="工作区文件" className="workspace-tree" role="tree">
      {sortedPaths(rootChildren, state).map((path) => (
        <TreeItem
          depth={0}
          entry={state.entries[path]}
          expanded={expanded}
          key={path}
          onSelect={onSelect}
          onToggle={onToggle}
          selectedPath={selectedPath}
          state={state}
        />
      ))}
    </div>
  );
}

interface TreeItemProps extends WorkspaceTreeProps {
  depth: number;
  entry: FsEntry | undefined;
}

function TreeItem({
  depth,
  entry,
  expanded,
  selectedPath,
  state,
  onSelect,
  onToggle,
}: TreeItemProps) {
  if (!entry) return null;
  const isDirectory = entry.kind === "directory";
  const isExpanded = isDirectory && expanded.has(entry.relativePath);
  const children = state.children[entry.relativePath] ?? [];
  const scan = state.scans[entry.relativePath];

  return (
    <div role="none">
      <button
        aria-expanded={isDirectory ? isExpanded : undefined}
        aria-selected={selectedPath === entry.relativePath}
        className="workspace-tree__row"
        data-kind={entry.kind}
        data-selected={selectedPath === entry.relativePath || undefined}
        onClick={() => {
          onSelect(entry);
          if (isDirectory) onToggle(entry);
        }}
        onKeyDown={(event) => handleTreeKeyDown(event, entry, isExpanded, onToggle)}
        role="treeitem"
        style={{ paddingInlineStart: `calc(var(--space-sm) + ${depth} * 16px)` }}
        title={entry.relativePath}
        type="button"
      >
        <span className="workspace-tree__twist" aria-hidden="true">
          {isDirectory ? (isExpanded ? "⌄" : "›") : ""}
        </span>
        <span className="workspace-tree__icon" aria-hidden="true">
          {isDirectory ? "▱" : "M"}
        </span>
        <span className="workspace-tree__name">{entry.name}</span>
        {!entry.writable ? <span className="workspace-tree__meta">只读</span> : null}
      </button>
      {isExpanded ? (
        <div role="group">
          {scan?.status === "loading" ? (
            <p className="workspace-tree__loading" style={{ paddingInlineStart: `${32 + depth * 16}px` }}>
              正在读取…
            </p>
          ) : null}
          {scan?.status === "error" ? (
            <p className="workspace-tree__issue" style={{ paddingInlineStart: `${32 + depth * 16}px` }}>
              无法读取此文件夹
            </p>
          ) : null}
          {sortedPaths(children, state).map((path) => (
            <TreeItem
              depth={depth + 1}
              entry={state.entries[path]}
              expanded={expanded}
              key={path}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedPath={selectedPath}
              state={state}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function sortedPaths(paths: WorkspaceRelativePath[], state: WorkspaceTreeState) {
  return [...paths].sort((left, right) => {
    const leftEntry = state.entries[left];
    const rightEntry = state.entries[right];
    if (leftEntry?.kind !== rightEntry?.kind) {
      return leftEntry?.kind === "directory" ? -1 : 1;
    }
    return (leftEntry?.name ?? left).localeCompare(rightEntry?.name ?? right, "zh-CN");
  });
}

function handleTreeKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  entry: FsEntry,
  expanded: boolean,
  onToggle: (entry: FsEntry) => void,
) {
  if (event.key === "ArrowRight" && entry.kind === "directory" && !expanded) {
    event.preventDefault();
    onToggle(entry);
    return;
  }
  if (event.key === "ArrowLeft" && entry.kind === "directory" && expanded) {
    event.preventDefault();
    onToggle(entry);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const tree = event.currentTarget.closest('[role="tree"]');
  const items = tree ? [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')] : [];
  const currentIndex = items.indexOf(event.currentTarget);
  const nextIndex = event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1;
  const next = items[nextIndex];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}
