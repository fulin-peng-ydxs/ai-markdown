import type {
  WorkspaceTabDescriptor,
  WorkspaceTabId,
  WorkspaceTabStatus,
} from "./tabTypes";
import { TabMenu } from "./TabMenu";

interface TabOverflowMenuProps {
  activeTabId: WorkspaceTabId | null;
  onActivate(tabId: WorkspaceTabId): void;
  onRequestClose(restoreFocus: boolean): void;
  statusById: ReadonlyMap<WorkspaceTabId, WorkspaceTabStatus>;
  tabs: readonly WorkspaceTabDescriptor[];
}

export function TabOverflowMenu({
  activeTabId,
  onActivate,
  onRequestClose,
  statusById,
  tabs,
}: TabOverflowMenuProps) {
  return (
    <TabMenu
      ariaLabel="所有打开的页签"
      childrenBeforeItems={
        <div className="workspace-tab-menu__heading">
          <strong>打开的文档</strong>
          <span>{tabs.length} 个页签</span>
        </div>
      }
      className="workspace-tab-menu--overflow"
      items={tabs.map((tab) => {
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
      })}
      onRequestClose={(reason) =>
        onRequestClose(reason === "dismiss")
      }
    />
  );
}
