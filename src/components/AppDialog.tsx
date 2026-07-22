import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

import {
  containTabFocus,
  focusContainmentEntry,
  restoreFocus,
} from "./focusContainment";

import "./AppDialog.css";

export interface AppDialogProps {
  open: boolean;
  labelledBy: string;
  describedBy?: string;
  className?: string;
  state?: string;
  closeDisabled?: boolean;
  onRequestClose(): void;
  children: ReactNode;
  actions?: ReactNode;
}

export function AppDialog({
  open,
  labelledBy,
  describedBy,
  className = "",
  state,
  closeDisabled = false,
  onRequestClose,
  children,
  actions,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      queueMicrotask(() => {
        if (dialog.open) {
          focusContainmentEntry(dialog);
        }
      });
      return;
    }
    if (!open && dialog.open) {
      closeDialog(dialog);
      queueMicrotask(() => restoreFocus(returnFocusRef.current));
    }
  }, [open]);

  useEffect(
    () => () => {
      const dialog = dialogRef.current;
      if (dialog?.open) {
        closeDialog(dialog);
      }
      queueMicrotask(() => restoreFocus(returnFocusRef.current));
    },
    [],
  );

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget && !closeDisabled) {
      onRequestClose();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    containTabFocus(event, event.currentTarget);
  }

  return (
    <dialog
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      aria-modal="true"
      className={`app-dialog ${className}`.trim()}
      data-state={state}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) {
          onRequestClose();
        }
      }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="app-dialog__body">{children}</div>
      {actions ? <div className="app-dialog__actions">{actions}</div> : null}
    </dialog>
  );
}

function closeDialog(dialog: HTMLDialogElement) {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}
