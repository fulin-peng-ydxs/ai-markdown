import { useEffect, useMemo, useRef, useState } from "react";

import { AppDialog } from "../../../components/AppDialog";
import { AsyncStatePanel } from "../../../components/AsyncStatePanel";
import type {
  DesktopError,
  RecoverySnapshot,
  RecoverySnapshotMetadata,
} from "../../../services/desktop/contracts";
import {
  desktopErrorMessage,
  normalizeDesktopError,
} from "../../../services/desktop/errors";
import type { EditorRecoveryGateway } from "../editorGateway";
import { desktopRecoveryGateway } from "../editorGateway";

import "./recoveryDialogs.css";

type ItemStatus = "idle" | "loading" | "deleting" | "failed";

export function RecoveryDialog({
  actionLabel = "恢复到编辑区",
  gateway = desktopRecoveryGateway,
  onClose,
  onDeleted,
  onRestore,
  open,
  snapshots,
}: {
  actionLabel?: string;
  gateway?: EditorRecoveryGateway;
  onClose(): void;
  onDeleted(snapshotId: string): void;
  onRestore(snapshot: RecoverySnapshot): Promise<void>;
  open: boolean;
  snapshots: RecoverySnapshotMetadata[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ItemStatus>>({});
  const [errors, setErrors] = useState<Record<string, DesktopError>>({});
  const sequenceRef = useRef(0);
  const ordered = useMemo(
    () => [...snapshots].sort((left, right) => right.updatedAt - left.updatedAt),
    [snapshots],
  );
  const selected =
    snapshots.find((snapshot) => snapshot.snapshotId === selectedId) ??
    ordered[0] ??
    null;
  const processing = Object.values(statuses).some(
    (status) => status === "loading" || status === "deleting",
  );

  useEffect(() => {
    if (!open) {
      sequenceRef.current += 1;
      setSelectedId(null);
      setStatuses({});
      setErrors({});
    }
  }, [open]);

  async function restore() {
    if (!selected || processing) return;
    const sequence = ++sequenceRef.current;
    setStatuses((current) => ({ ...current, [selected.snapshotId]: "loading" }));
    setErrors((current) => withoutKey(current, selected.snapshotId));
    try {
      const snapshot = await gateway.get(
        selected.snapshotId,
        selected.workspaceId,
        selected.relativePath,
      );
      if (sequence !== sequenceRef.current) return;
      await onRestore(snapshot);
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setErrors((current) => ({
        ...current,
        [selected.snapshotId]: normalizeDesktopError(
          reason,
          "recovery_read_failed",
        ),
      }));
      setStatuses((current) => ({ ...current, [selected.snapshotId]: "failed" }));
    }
  }

  async function remove(snapshot: RecoverySnapshotMetadata) {
    if (processing) return;
    const sequence = ++sequenceRef.current;
    setStatuses((current) => ({ ...current, [snapshot.snapshotId]: "deleting" }));
    setErrors((current) => withoutKey(current, snapshot.snapshotId));
    try {
      await gateway.delete(snapshot.snapshotId, snapshot.workspaceId);
      if (sequence !== sequenceRef.current) return;
      onDeleted(snapshot.snapshotId);
      setSelectedId(null);
      setStatuses((current) => withoutKey(current, snapshot.snapshotId));
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setErrors((current) => ({
        ...current,
        [snapshot.snapshotId]: normalizeDesktopError(
          reason,
          "recovery_write_failed",
        ),
      }));
      setStatuses((current) => ({ ...current, [snapshot.snapshotId]: "failed" }));
    }
  }

  return (
    <AppDialog
      actions={
        <>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={onClose}
            type="button"
          >
            暂不恢复
          </button>
          <button
            className="plainroot-button plainroot-button--primary"
            disabled={!selected || processing}
            onClick={() => void restore()}
            type="button"
          >
            {selected && statuses[selected.snapshotId] === "loading"
              ? "正在读取恢复副本…"
              : actionLabel}
          </button>
        </>
      }
      closeDisabled={processing}
      describedBy="recovery-description"
      labelledBy="recovery-title"
      onRequestClose={onClose}
      open={open}
      state={processing ? "loading" : snapshots.length === 0 ? "empty" : "ready"}
    >
      <div className="editor-recovery-dialog">
        <p className="editor-recovery-dialog__eyebrow">本机恢复副本</p>
        <h2 id="recovery-title">检查尚未写入原文件的内容</h2>
        <p id="recovery-description">
          恢复只会把副本载入编辑会话并标记为未保存，不会直接覆盖原 Markdown 文件。
        </p>
        {ordered.length === 0 ? (
          <AsyncStatePanel
            compact
            description="没有可恢复的未保存内容。"
            state="empty"
            title="恢复列表为空"
          />
        ) : (
          <ul className="editor-recovery-list">
            {ordered.map((snapshot) => {
              const error = errors[snapshot.snapshotId];
              return (
                <li
                  data-selected={selected?.snapshotId === snapshot.snapshotId || undefined}
                  key={snapshot.snapshotId}
                >
                  <button
                    className="editor-recovery-list__select"
                    disabled={processing}
                    onClick={() => setSelectedId(snapshot.snapshotId)}
                    type="button"
                  >
                    <strong>{snapshot.relativePath}</strong>
                    <span>
                      {formatTime(snapshot.updatedAt)} · {formatBytes(snapshot.sizeBytes)}
                    </span>
                    <small>
                      到期时间 {formatTime(snapshot.expiresAt)}
                    </small>
                  </button>
                  <button
                    className="plainroot-button"
                    disabled={processing}
                    onClick={() => void remove(snapshot)}
                    type="button"
                  >
                    {statuses[snapshot.snapshotId] === "deleting"
                      ? "正在删除…"
                      : "删除副本"}
                  </button>
                  {error ? (
                    <p aria-live="assertive">{desktopErrorMessage(error)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {selected ? (
          <dl className="editor-recovery-dialog__facts">
            <div>
              <dt>原文件基线</dt>
              <dd>{formatTime(selected.baseRevision.modifiedAt)}</dd>
            </div>
            <div>
              <dt>恢复副本</dt>
              <dd>
                {selected.baseRevision.encoding} ·{" "}
                {selected.baseRevision.lineEnding}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </AppDialog>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
