import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { focusableElements } from "../../components/focusContainment";

export interface TabMenuItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  destructive?: boolean;
  sectionLabel?: string;
  onSelect(): void;
}

interface TabMenuProps {
  ariaLabel: string;
  childrenBeforeItems?: ReactNode;
  className?: string;
  items: readonly TabMenuItem[];
  onRequestClose(reason: "dismiss" | "selection" | "tab"): void;
  style?: CSSProperties;
}

export function TabMenu({
  ariaLabel,
  childrenBeforeItems,
  className = "",
  items,
  onRequestClose,
  style,
}: TabMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    queueMicrotask(() => focusableElements(menu)[0]?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) onRequestClose("dismiss");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onRequestClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onRequestClose(event.key === "Tab" ? "tab" : "dismiss");
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const focusable = focusableElements(menu);
    if (focusable.length === 0) return;
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? focusable.length - 1
          : event.key === "ArrowDown"
            ? (Math.max(currentIndex, -1) + 1) % focusable.length
            : (currentIndex <= 0 ? focusable.length : currentIndex) - 1;
    focusable[targetIndex]?.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={`workspace-tab-menu ${className}`.trim()}
      onKeyDown={onKeyDown}
      ref={menuRef}
      role="menu"
      style={style}
      tabIndex={-1}
    >
      {childrenBeforeItems}
      {items.map((item) => (
        <div className="workspace-tab-menu__entry" key={item.id} role="none">
          {item.sectionLabel ? (
            <div
              className="workspace-tab-menu__section"
              role="separator"
            >
              {item.sectionLabel}
            </div>
          ) : null}
          <button
            className="workspace-tab-menu__item"
            data-destructive={item.destructive || undefined}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onRequestClose("selection");
            }}
            role="menuitem"
            title={item.description}
            type="button"
          >
            <span>{item.label}</span>
            {item.description ? <small>{item.description}</small> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
