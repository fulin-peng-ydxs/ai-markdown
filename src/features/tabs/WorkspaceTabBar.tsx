import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { DesktopError } from "../../services/desktop/contracts";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import type { WorkspaceTabOpenResult } from "./WorkspaceTabManager";
import { TabContextMenu } from "./TabContextMenu";
import { TabOverflowMenu } from "./TabOverflowMenu";
import type { WorkspaceTabPathIdentity } from "./tabPath";
import {
  projectWorkspaceTabStatus,
  type WorkspaceTabDescriptor,
  type WorkspaceTabId,
  type WorkspaceTabStatus,
} from "./tabTypes";

import "./WorkspaceTabBar.css";

interface WorkspaceTabBarProps {
  closingTabIds?: ReadonlySet<WorkspaceTabId>;
  onActivate(tabId: WorkspaceTabId): void;
  onClose(tabId: WorkspaceTabId): void | Promise<void>;
  onDiscardRecent(pathIdentity: WorkspaceTabPathIdentity): void;
  onMove(tabId: WorkspaceTabId, toIndex: number): void;
  onReopen(
    pathIdentity: WorkspaceTabPathIdentity,
  ): Promise<WorkspaceTabOpenResult>;
  snapshot: WorkspaceTabManagerSnapshot | null;
}

interface ContextTarget {
  tabId: WorkspaceTabId;
  x: number;
  y: number;
}

export function WorkspaceTabBar({
  closingTabIds = new Set(),
  onActivate,
  onClose,
  onDiscardRecent,
  onMove,
  onReopen,
  snapshot,
}: WorkspaceTabBarProps) {
  const tabs = useMemo(
    () =>
      snapshot
        ? snapshot.collection.orderedTabIds.flatMap((tabId) => {
            const tab = snapshot.collection.tabsById.get(tabId);
            return tab ? [tab] : [];
          })
        : [],
    [snapshot],
  );
  const activeTabId = snapshot?.collection.activeTabId ?? null;
  const statusById = useMemo(() => {
    const statuses = new Map<WorkspaceTabId, WorkspaceTabStatus>();
    for (const tab of tabs) {
      statuses.set(
        tab.tabId,
        projectWorkspaceTabStatus(
          tab,
          snapshot?.runtimes.get(tab.tabId) ?? null,
        ),
      );
    }
    return statuses;
  }, [snapshot, tabs]);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      counts.set(tab.displayName, (counts.get(tab.displayName) ?? 0) + 1);
    }
    return counts;
  }, [tabs]);
  const [rovingTabId, setRovingTabId] = useState<WorkspaceTabId | null>(
    activeTabId,
  );
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<WorkspaceTabId | null>(null);
  const [dropTabId, setDropTabId] = useState<WorkspaceTabId | null>(null);
  const [recentFailures, setRecentFailures] = useState<
    Map<WorkspaceTabPathIdentity, DesktopError>
  >(new Map());
  const tabRefs = useRef(new Map<WorkspaceTabId, HTMLButtonElement>());
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingCloseIndexRef = useRef<number | null>(null);

  useEffect(() => {
    if (rovingTabId && tabs.some((tab) => tab.tabId === rovingTabId)) return;
    setRovingTabId(activeTabId ?? tabs[0]?.tabId ?? null);
  }, [activeTabId, rovingTabId, tabs]);

  useEffect(() => {
    const pendingIndex = pendingCloseIndexRef.current;
    if (pendingIndex === null) return;
    pendingCloseIndexRef.current = null;
    const target =
      (activeTabId && tabRefs.current.get(activeTabId)) ||
      tabRefs.current.get(tabs[Math.min(pendingIndex, tabs.length - 1)]?.tabId);
    queueMicrotask(() => target?.focus());
  }, [activeTabId, tabs]);

  useEffect(() => {
    const available = new Set(
      snapshot?.collection.recentlyClosed.map((recent) => recent.pathIdentity) ??
        [],
    );
    setRecentFailures((current) => {
      const next = new Map(
        [...current].filter(([identity]) => available.has(identity)),
      );
      return next.size === current.size ? current : next;
    });
  }, [snapshot?.collection.recentlyClosed]);

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;
  const activeStatus = activeTab
    ? statusById.get(activeTab.tabId) ?? null
    : null;
  const contextTab = contextTarget
    ? tabs.find((tab) => tab.tabId === contextTarget.tabId) ?? null
    : null;

  function focusAndActivate(tabId: WorkspaceTabId) {
    setRovingTabId(tabId);
    onActivate(tabId);
    queueMicrotask(() => tabRefs.current.get(tabId)?.focus());
  }

  function requestClose(tabId: WorkspaceTabId) {
    pendingCloseIndexRef.current = tabs.findIndex((tab) => tab.tabId === tabId);
    void onClose(tabId);
  }

  function moveTab(tabId: WorkspaceTabId, toIndex: number) {
    const clamped = Math.max(0, Math.min(toIndex, tabs.length - 1));
    onMove(tabId, clamped);
    setRovingTabId(tabId);
    queueMicrotask(() => tabRefs.current.get(tabId)?.focus());
  }

  function openContextMenu(
    tab: WorkspaceTabDescriptor,
    x: number,
    y: number,
  ) {
    contextTriggerRef.current = tabRefs.current.get(tab.tabId) ?? null;
    setOverflowOpen(false);
    setContextTarget({ tabId: tab.tabId, x, y });
  }

  function onTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tab: WorkspaceTabDescriptor,
    index: number,
  ) {
    const horizontalDirection =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (horizontalDirection !== 0 && event.altKey && event.shiftKey) {
      event.preventDefault();
      moveTab(tab.tabId, index + horizontalDirection);
      return;
    }
    if (horizontalDirection !== 0 || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const targetIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + horizontalDirection + tabs.length) % tabs.length;
      const target = tabs[targetIndex];
      if (target) focusAndActivate(target.tabId);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      requestClose(tab.tabId);
      return;
    }
    if (
      (event.key === "F10" && event.shiftKey) ||
      event.key === "ContextMenu"
    ) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openContextMenu(tab, bounds.left + 16, bounds.bottom - 2);
    }
  }

  function closeOverflowMenu(restoreFocus = true) {
    setOverflowOpen(false);
    if (restoreFocus) queueMicrotask(() => overflowTriggerRef.current?.focus());
  }

  function closeContextMenu(restoreFocus = true) {
    setContextTarget(null);
    if (restoreFocus) queueMicrotask(() => contextTriggerRef.current?.focus());
  }

  function requestReopen(pathIdentity: WorkspaceTabPathIdentity) {
    void onReopen(pathIdentity).then((result) => {
      setRecentFailures((current) => {
        const next = new Map(current);
        if (result.status === "failed") {
          next.set(pathIdentity, result.error);
        } else {
          next.delete(pathIdentity);
        }
        return next;
      });
    });
  }

  function discardRecent(pathIdentity: WorkspaceTabPathIdentity) {
    onDiscardRecent(pathIdentity);
    setRecentFailures((current) => {
      if (!current.has(pathIdentity)) return current;
      const next = new Map(current);
      next.delete(pathIdentity);
      return next;
    });
  }

  return (
    <nav className="workspace-tab-bar" aria-label="文档页签">
      <div className="workspace-tab-bar__viewport">
        <div
          aria-label="打开的文档"
          className="workspace-tab-bar__list"
          role="tablist"
        >
          {tabs.length === 0 ? (
            <span className="workspace-tab-bar__empty">尚未打开文档</span>
          ) : null}
          {tabs.map((tab, index) => {
            const active = tab.tabId === activeTabId;
            const status = statusById.get(tab.tabId);
            const duplicate = (duplicateNames.get(tab.displayName) ?? 0) > 1;
            const fullPath = tab.parentHint
              ? `${tab.parentHint}/${tab.displayName}`
              : tab.displayName;
            const closing = closingTabIds.has(tab.tabId);
            return (
              <div
                className="workspace-tab"
                data-active={active || undefined}
                data-dragging={draggedTabId === tab.tabId || undefined}
                data-drop-target={dropTabId === tab.tabId || undefined}
                key={`${tab.tabId}:${tab.incarnation}`}
                role="presentation"
              >
                <button
                  aria-controls="workspace-document-panel"
                  aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                  aria-selected={active}
                  className="workspace-tab__target"
                  draggable
                  onClick={() => focusAndActivate(tab.tabId)}
                  onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    openContextMenu(tab, event.clientX, event.clientY);
                  }}
                  onDragEnd={() => {
                    setDraggedTabId(null);
                    setDropTabId(null);
                  }}
                  onDragOver={(event: DragEvent<HTMLButtonElement>) => {
                    if (!draggedTabId || draggedTabId === tab.tabId) return;
                    event.preventDefault();
                    setDropTabId(tab.tabId);
                  }}
                  onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                    setDraggedTabId(tab.tabId);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", tab.tabId);
                  }}
                  onDrop={(event: DragEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    const source = draggedTabId ||
                      (event.dataTransfer.getData("text/plain") as WorkspaceTabId);
                    if (source && source !== tab.tabId) moveTab(source, index);
                    setDraggedTabId(null);
                    setDropTabId(null);
                  }}
                  onFocus={() => setRovingTabId(tab.tabId)}
                  onKeyDown={(event) => onTabKeyDown(event, tab, index)}
                  ref={(element) => {
                    if (element) tabRefs.current.set(tab.tabId, element);
                    else tabRefs.current.delete(tab.tabId);
                  }}
                  role="tab"
                  tabIndex={rovingTabId === tab.tabId ? 0 : -1}
                  title={`${fullPath} · ${status?.presentation.label ?? "等待打开"}`}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="workspace-tab__state"
                    data-state={status?.state ?? "unloaded"}
                  >
                    {closing ? "…" : stateGlyph(status?.state ?? "unloaded")}
                  </span>
                  <span className="workspace-tab__label">
                    <strong>{tab.displayName}</strong>
                    {duplicate && tab.parentHint ? (
                      <small>{tab.parentHint}</small>
                    ) : null}
                  </span>
                  <span className="workspace-tab-bar__sr-only">
                    {closing ? "正在关闭" : status?.presentation.label}
                  </span>
                </button>
                <button
                  aria-label={`关闭 ${tab.displayName}`}
                  className="workspace-tab__close"
                  disabled={closing}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestClose(tab.tabId);
                  }}
                  tabIndex={-1}
                  title={`关闭 ${fullPath}`}
                  type="button"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <button
        aria-expanded={overflowOpen}
        aria-haspopup="menu"
        aria-label="所有页签"
        className="workspace-tab-bar__overflow"
        disabled={
          tabs.length === 0 &&
          (snapshot?.collection.recentlyClosed.length ?? 0) === 0
        }
        onClick={() => {
          setContextTarget(null);
          setOverflowOpen((current) => !current);
        }}
        ref={overflowTriggerRef}
        title="所有页签"
        type="button"
      >
        ⋮
      </button>
      {overflowOpen ? (
        <TabOverflowMenu
          activeTabId={activeTabId}
          onActivate={(tabId) => {
            focusAndActivate(tabId);
          }}
          onDiscardRecent={discardRecent}
          onReopen={requestReopen}
          onRequestClose={closeOverflowMenu}
          recentFailures={recentFailures}
          recentlyClosed={snapshot?.collection.recentlyClosed ?? []}
          statusById={statusById}
          tabs={tabs}
        />
      ) : null}
      {contextTarget && contextTab ? (
        <TabContextMenu
          canMoveLeft={tabs.findIndex((tab) => tab.tabId === contextTarget.tabId) > 0}
          canMoveRight={
            tabs.findIndex((tab) => tab.tabId === contextTarget.tabId) <
            tabs.length - 1
          }
          onClose={() => requestClose(contextTarget.tabId)}
          onMoveLeft={() => {
            const index = tabs.findIndex((tab) => tab.tabId === contextTarget.tabId);
            moveTab(contextTarget.tabId, index - 1);
          }}
          onMoveRight={() => {
            const index = tabs.findIndex((tab) => tab.tabId === contextTarget.tabId);
            moveTab(contextTarget.tabId, index + 1);
          }}
          onRequestClose={closeContextMenu}
          position={{ x: contextTarget.x, y: contextTarget.y }}
          tab={contextTab}
        />
      ) : null}
      {activeTab && activeStatus ? (
        <span
          aria-live={activeStatus.presentation.live}
          className="workspace-tab-bar__sr-only"
          role={activeStatus.presentation.role}
        >
          {activeTab.displayName}：{activeStatus.presentation.label}
        </span>
      ) : null}
    </nav>
  );
}

function stateGlyph(state: WorkspaceTabStatus["state"]): string {
  switch (state) {
    case "ready":
      return "✓";
    case "dirty":
      return "●";
    case "loading":
    case "saving":
      return "…";
    case "readonly":
      return "◇";
    case "conflict":
    case "error":
    case "permission_denied":
      return "!";
    case "missing":
      return "×";
    case "unsupported":
      return "–";
    case "empty":
    case "unloaded":
      return "○";
  }
}
