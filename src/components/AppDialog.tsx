import {
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
      return;
    }
    if (!open && dialog.open) {
      closeDialog(dialog);
      queueMicrotask(() => returnFocusRef.current?.focus());
    }
  }, [open]);

  useEffect(
    () => () => {
      const dialog = dialogRef.current;
      if (dialog?.open) {
        closeDialog(dialog);
      }
      queueMicrotask(() => returnFocusRef.current?.focus());
    },
    [],
  );

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget && !closeDisabled) {
      onRequestClose();
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
      ref={dialogRef}
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
