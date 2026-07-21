import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

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
      queueMicrotask(() => focusDialogEntry(dialog));
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
    if (event.key !== "Tab") {
      return;
    }
    const dialog = event.currentTarget;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
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

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

function focusDialogEntry(dialog: HTMLDialogElement) {
  if (!dialog.open || dialog.contains(document.activeElement)) {
    return;
  }
  const autofocus = dialog.querySelector<HTMLElement>("[autofocus]");
  (autofocus ?? focusableElements(dialog)[0] ?? dialog).focus();
}

function restoreFocus(element: HTMLElement | null) {
  if (element?.isConnected) {
    element.focus();
  }
}

function closeDialog(dialog: HTMLDialogElement) {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}
