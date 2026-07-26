import { desktopErrorMessage } from "../../services/desktop/errors";
import type { DesktopError } from "../../services/desktop/contracts";
import type { WorkspaceTabPathIdentity } from "./tabPath";
import type {
  RecentlyClosedWorkspaceTab,
  WorkspaceTabDescriptor,
  WorkspaceTabId,
  WorkspaceTabStatus,
} from "./tabTypes";
import { TabMenu } from "./TabMenu";

interface TabOverflowMenuProps {
  activeTabId: WorkspaceTabId | null;
  onActivate(tabId: WorkspaceTabId): void;
  onDiscardRecent(pathIdentity: WorkspaceTabPathIdentity): void;
  onReopen(pathIdentity: WorkspaceTabPathIdentity): void;
  onRequestClose(restoreFocus: boolean): void;
  recentFailures: ReadonlyMap<WorkspaceTabPathIdentity, DesktopError>;
  recentlyClosed: readonly RecentlyClosedWorkspaceTab[];
  statusById: ReadonlyMap<WorkspaceTabId, WorkspaceTabStatus>;
  tabs: readonly WorkspaceTabDescriptor[];
}

export function TabOverflowMenu({
  activeTabId,
  onActivate,
  onDiscardRecent,
  onReopen,
  onRequestClose,
  recentFailures,
  recentlyClosed,
  statusById,
  tabs,
}: TabOverflowMenuProps) {
  const openItems = tabs.map((tab) => {
    const status = statusById.get(tab.tabId);
    const path = tab.parentHint
      ? `${tab.parentHint}/${tab.displayName}`
      : tab.displayName;
    return {
      id: tab.tabId,
      label: `${tab.tabId === activeTabId ? "当前 · " : ""}${tab.displayName}`,
      description: `${path} · ${status?.presentation.label ?? "等待打开"}`,
      onSelect: () => onActivate(tab.tabId),
    };
  });
  const recentItems = recentlyClosed.flatMap((recent, index) => {
    const failure = recentFailures.get(recent.pathIdentity);
    const path = recent.parentHint
      ? `${recent.parentHint}/${recent.displayName}`
      : recent.displayName;
    return [
      {
        id: `recent:${recent.pathIdentity}`,
        label: `重新打开 ${recent.displayName}`,
        description: failure
          ? `${path} · ${desktopErrorMessage(failure)}`
          : `${path} · 最近关闭`,
        sectionLabel: index === 0 ? "最近关闭" : undefined,
        onSelect: () => onReopen(recent.pathIdentity),
      },
      ...(failure
        ? [{
            id: `discard:${recent.pathIdentity}`,
            label: `移除失效记录 ${recent.displayName}`,
            description: "只移除最近关闭记录，不删除本地文件",
            destructive: true,
            onSelect: () => onDiscardRecent(recent.pathIdentity),
          }]
        : []),
    ];
  });
  return (
    <TabMenu
      ariaLabel="所有页签与最近关闭"
      childrenBeforeItems={
        <div className="workspace-tab-menu__heading">
          <strong>打开的文档</strong>
          <span>{tabs.length} 个页签</span>
        </div>
      }
      className="workspace-tab-menu--overflow"
      items={[...openItems, ...recentItems]}
      onRequestClose={(reason) =>
        onRequestClose(reason === "dismiss")
      }
    />
  );
}
