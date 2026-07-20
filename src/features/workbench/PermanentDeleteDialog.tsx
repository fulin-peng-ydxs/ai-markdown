import { useEffect, useRef, useState } from "react";

import type {
  DeleteResult,
  DesktopError,
  PermanentDeleteProposal,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../services/desktop/contracts";
import {
  cancelPermanentDelete,
  confirmPermanentDelete,
  preparePermanentDelete,
} from "../../services/desktop/files";
import {
  permanentDeleteErrorMessage,
  type PermanentDeleteErrorPhase,
} from "./permanentDeleteFeedback";

import "./PermanentDeleteDialog.css";

type DialogStatus = "preparing" | "ready" | "deleting" | "error";

export interface PermanentDeleteDialogProps {
  open: boolean;
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  onDeleted(result: DeleteResult): void;
  onClose(): void;
}

export function PermanentDeleteDialog({
  open,
  workspaceId,
  relativePath,
  onDeleted,
  onClose,
}: PermanentDeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestSequenceRef = useRef(0);
  const proposalRef = useRef<PermanentDeleteProposal | null>(null);
  const [status, setStatus] = useState<DialogStatus>("preparing");
  const [proposal, setProposal] = useState<PermanentDeleteProposal | null>(null);
  const [error, setError] = useState<DesktopError | null>(null);
  const [errorPhase, setErrorPhase] =
    useState<PermanentDeleteErrorPhase | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (!open) {
      requestSequenceRef.current += 1;
      if (proposalRef.current) {
        void cancelPermanentDelete(proposalRef.current.confirmationId).catch(
          () => undefined,
        );
        storeProposal(null);
      }
      if (dialog.open) {
        dialog.close();
      }
      queueMicrotask(() => returnFocusRef.current?.focus());
      return;
    }

    if (!dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    void loadProposal();

    return () => {
      requestSequenceRef.current += 1;
    };
    // The parent owns when a new destructive flow begins. A changed target starts a fresh proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, relativePath]);

  useEffect(
    () => () => {
      requestSequenceRef.current += 1;
      if (proposalRef.current) {
        void cancelPermanentDelete(proposalRef.current.confirmationId).catch(
          () => undefined,
        );
      }
    },
    [],
  );

  function storeProposal(next: PermanentDeleteProposal | null) {
    proposalRef.current = next;
    setProposal(next);
  }

  async function loadProposal() {
    const sequence = ++requestSequenceRef.current;
    setStatus("preparing");
    if (proposalRef.current) {
      void cancelPermanentDelete(proposalRef.current.confirmationId).catch(
        () => undefined,
      );
    }
    storeProposal(null);
    setError(null);
    setErrorPhase(null);
    try {
      const nextProposal = await preparePermanentDelete(
        workspaceId,
        relativePath,
      );
      if (sequence !== requestSequenceRef.current) {
        void cancelPermanentDelete(nextProposal.confirmationId).catch(() => undefined);
        return;
      }
      storeProposal(nextProposal);
      setStatus("ready");
    } catch (reason) {
      if (sequence === requestSequenceRef.current) {
        setError(asDesktopError(reason));
        setErrorPhase("prepare");
        setStatus("error");
      }
    }
  }

  function closeSafely() {
    requestSequenceRef.current += 1;
    if (proposalRef.current) {
      void cancelPermanentDelete(proposalRef.current.confirmationId).catch(
        () => undefined,
      );
      storeProposal(null);
    }
    dialogRef.current?.close();
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  }

  async function deletePermanently() {
    if (!proposal || status !== "ready") {
      return;
    }
    setStatus("deleting");
    setError(null);
    setErrorPhase(null);
    try {
      const result = await confirmPermanentDelete(
        workspaceId,
        proposal.confirmationId,
      );
      storeProposal(null);
      dialogRef.current?.close();
      onDeleted(result);
      onClose();
      queueMicrotask(() => returnFocusRef.current?.focus());
    } catch (reason) {
      storeProposal(null);
      setError(asDesktopError(reason));
      setErrorPhase("delete");
      setStatus("error");
    }
  }

  const itemName = proposal?.name ?? relativePath.split("/").at(-1) ?? relativePath;
  const errorMessage =
    error && errorPhase
      ? permanentDeleteErrorMessage(error, errorPhase)
      : null;

  return (
    <dialog
      aria-describedby="permanent-delete-description"
      aria-labelledby="permanent-delete-title"
      className="permanent-delete-dialog"
      data-state={status}
      onCancel={(event) => {
        event.preventDefault();
        if (status !== "deleting") {
          closeSafely();
        }
      }}
      ref={dialogRef}
    >
      <div className="permanent-delete-dialog__body">
        <p className="permanent-delete-dialog__eyebrow">回收站不可用</p>
        <h2 id="permanent-delete-title">永久删除“{itemName}”？</h2>
        <p id="permanent-delete-description">
          此操作会立即删除该项目及其内容，无法从系统废纸篓或回收站恢复。
        </p>
        {status === "preparing" ? (
          <p aria-live="polite" className="permanent-delete-dialog__status">
            正在重新确认文件状态…
          </p>
        ) : null}
        {errorMessage ? (
          <p
            aria-live="assertive"
            className="permanent-delete-dialog__error"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
      </div>
      <div className="permanent-delete-dialog__actions">
        <button
          autoFocus
          className="plainroot-button plainroot-button--secondary"
          disabled={status === "deleting"}
          onClick={closeSafely}
          type="button"
        >
          {status === "error" && errorPhase === "delete" ? "关闭" : "取消"}
        </button>
        {status === "error" && errorPhase === "prepare" ? (
          <button
            className="plainroot-button plainroot-button--secondary"
            onClick={() => void loadProposal()}
            type="button"
          >
            重新确认
          </button>
        ) : (
          <button
            className="plainroot-button plainroot-button--danger"
            disabled={status !== "ready"}
            onClick={() => void deletePermanently()}
            type="button"
          >
            {status === "deleting" ? "正在永久删除…" : "永久删除"}
          </button>
        )}
      </div>
    </dialog>
  );
}

function asDesktopError(reason: unknown): DesktopError {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    "messageKey" in reason
  ) {
    return reason as DesktopError;
  }
  return {
    code: "permanent_delete_failed",
    messageKey: "error.file.permanentDeleteFailed",
    pathHint: null,
    contentSafe: true,
    retryable: true,
  };
}
