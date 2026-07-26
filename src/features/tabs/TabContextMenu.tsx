import type { CSSProperties } from "react";

import type { WorkspaceTabDescriptor } from "./tabTypes";
import { TabMenu, type TabMenuItem } from "./TabMenu";

interface TabContextMenuProps {
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onClose(): void;
  onCloseAll(): void;
  onCloseOthers(): void;
  onCloseRight(): void;
  onMoveLeft(): void;
  onMoveRight(): void;
  onRequestClose(restoreFocus: boolean): void;
  position: { x: number; y: number };
  tab: WorkspaceTabDescriptor;
}

export function TabContextMenu({
  canMoveLeft,
  canMoveRight,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseRight,
  onMoveLeft,
  onMoveRight,
  onRequestClose,
  position,
  tab,
}: TabContextMenuProps) {
  const style: CSSProperties = {
    left: Math.max(8, Math.min(position.x, globalThis.innerWidth - 260)),
    top: Math.max(8, Math.min(position.y, globalThis.innerHeight - 330)),
  };
  const items: TabMenuItem[] = [
    {
      id: "close",
      label: "关闭页签",
      description: tab.displayName,
      onSelect: onClose,
    },
    {
      id: "move-left",
      label: "向左移动",
      description: "Alt+Shift+←",
      disabled: !canMoveLeft,
      onSelect: onMoveLeft,
    },
    {
      id: "move-right",
      label: "向右移动",
      description: "Alt+Shift+→",
      disabled: !canMoveRight,
      onSelect: onMoveRight,
    },
    {
      id: "close-others",
      label: "关闭其他页签",
      description: "安全结算后一次关闭",
      onSelect: onCloseOthers,
    },
    {
      id: "close-right",
      label: "关闭右侧页签",
      description: "安全结算后一次关闭",
      disabled: !canMoveRight,
      onSelect: onCloseRight,
    },
    {
      id: "close-all",
      label: "关闭全部页签",
      description: "安全结算后一次关闭",
      onSelect: onCloseAll,
    },
  ];

  return (
    <TabMenu
      ariaLabel={`${tab.displayName} 页签操作`}
      className="workspace-tab-menu--context"
      items={items}
      onRequestClose={(reason) =>
        onRequestClose(reason === "dismiss")
      }
      style={style}
    />
  );
}
