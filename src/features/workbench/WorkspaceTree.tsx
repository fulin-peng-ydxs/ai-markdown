import { useEffect, useState, type KeyboardEvent } from "react";

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
  const visiblePaths = collectVisiblePaths(rootChildren, state, expanded);
  const visiblePathKey = visiblePaths.join("\u0000");
  const [rovingPath, setRovingPath] = useState<WorkspaceRelativePath | null>(
    selectedPath && visiblePaths.includes(selectedPath) ? selectedPath : visiblePaths[0] ?? null,
  );

  useEffect(() => {
    setRovingPath((current) => {
      if (current && visiblePaths.includes(current)) return current;
      if (selectedPath && visiblePaths.includes(selectedPath)) return selectedPath;
      return visiblePaths[0] ?? null;
    });
  }, [selectedPath, visiblePathKey]);

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
          onRovingPathChange={setRovingPath}
          rovingPath={rovingPath}
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
  rovingPath: WorkspaceRelativePath | null;
  onRovingPathChange(path: WorkspaceRelativePath): void;
}

function TreeItem({
  depth,
  entry,
  expanded,
  selectedPath,
  state,
  onSelect,
  onToggle,
  rovingPath,
  onRovingPathChange,
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
        aria-level={depth + 1}
        aria-selected={selectedPath === entry.relativePath}
        className="workspace-tree__row"
        data-kind={entry.kind}
        data-selected={selectedPath === entry.relativePath || undefined}
        data-tree-depth={depth}
        data-tree-path={entry.relativePath}
        onClick={() => {
          onRovingPathChange(entry.relativePath);
          onSelect(entry);
          if (isDirectory) onToggle(entry);
        }}
        onFocus={() => onRovingPathChange(entry.relativePath)}
        onKeyDown={(event) =>
          handleTreeKeyDown(event, entry, isExpanded, onToggle, onRovingPathChange)
        }
        role="treeitem"
        style={{ paddingInlineStart: `calc(var(--space-sm) + ${depth} * 16px)` }}
        tabIndex={rovingPath === entry.relativePath ? 0 : -1}
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
              onRovingPathChange={onRovingPathChange}
              rovingPath={rovingPath}
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

function collectVisiblePaths(
  paths: WorkspaceRelativePath[],
  state: WorkspaceTreeState,
  expanded: ReadonlySet<WorkspaceRelativePath>,
): WorkspaceRelativePath[] {
  const visible: WorkspaceRelativePath[] = [];
  for (const path of sortedPaths(paths, state)) {
    const entry = state.entries[path];
    if (!entry) continue;
    visible.push(path);
    if (entry.kind === "directory" && expanded.has(path)) {
      visible.push(...collectVisiblePaths(state.children[path] ?? [], state, expanded));
    }
  }
  return visible;
}

function handleTreeKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  entry: FsEntry,
  expanded: boolean,
  onToggle: (entry: FsEntry) => void,
  onRovingPathChange: (path: WorkspaceRelativePath) => void,
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
  const tree = event.currentTarget.closest('[role="tree"]');
  const items = tree ? [...tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')] : [];
  const currentIndex = items.indexOf(event.currentTarget);
  const depth = Number(event.currentTarget.dataset.treeDepth ?? 0);

  if (event.key === "ArrowRight" && entry.kind === "directory" && expanded) {
    const firstChild = items[currentIndex + 1];
    if (firstChild && Number(firstChild.dataset.treeDepth) === depth + 1) {
      moveTreeFocus(event, firstChild, onRovingPathChange);
    }
    return;
  }
  if (event.key === "ArrowLeft") {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = items[index];
      if (Number(candidate.dataset.treeDepth) === depth - 1) {
        moveTreeFocus(event, candidate, onRovingPathChange);
        return;
      }
    }
    return;
  }
  const target = event.key === "ArrowDown"
    ? items[currentIndex + 1]
    : event.key === "ArrowUp"
      ? items[currentIndex - 1]
      : event.key === "Home"
        ? items[0]
        : event.key === "End"
          ? items.at(-1)
          : undefined;
  if (target) moveTreeFocus(event, target, onRovingPathChange);
}

function moveTreeFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  target: HTMLButtonElement,
  onRovingPathChange: (path: WorkspaceRelativePath) => void,
) {
  event.preventDefault();
  const path = target.dataset.treePath as WorkspaceRelativePath;
  onRovingPathChange(path);
  target.focus();
}
