import { useEffect, useRef, useState } from "react";

import { AppDialog } from "../../../components/AppDialog";
import { AsyncStatePanel } from "../../../components/AsyncStatePanel";
import type {
  ConflictOverwriteProposal,
  DesktopError,
  SafeWriteResult,
} from "../../../services/desktop/contracts";
import {
  desktopErrorMessage,
  normalizeDesktopError,
} from "../../../services/desktop/errors";
import type { ReadyDocumentSession } from "../documentSession";
import type { EditorSaveGateway } from "../editorGateway";
import { desktopSaveGateway } from "../editorGateway";
import { ContentSafetySummary } from "./ContentSafetySummary";

import "./recoveryDialogs.css";

type ConflictStep = "decision" | "preparing" | "confirm_overwrite" | "processing";

export function ConflictDialog({
  gateway = desktopSaveGateway,
  onClose,
  onOverwrite,
  onReload,
  onSaveCopy,
  open,
  session,
}: {
  gateway?: EditorSaveGateway;
  onClose(): void;
  onOverwrite(result: SafeWriteResult): void;
  onReload(): Promise<void>;
  onSaveCopy(): void;
  open: boolean;
  session: ReadyDocumentSession;
}) {
  const [step, setStep] = useState<ConflictStep>("decision");
  const [proposal, setProposal] = useState<ConflictOverwriteProposal | null>(null);
  const [error, setError] = useState<DesktopError | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (open) return;
    sequenceRef.current += 1;
    setStep("decision");
    setProposal(null);
    setError(null);
  }, [open]);

  async function prepareOverwrite() {
    if (step !== "decision") return;
    const sequence = ++sequenceRef.current;
    setError(null);
    setStep("preparing");
    try {
      if (session.conflictEvidence) {
        await gateway
          .cancelOverwrite(session.conflictEvidence.evidenceId)
          .catch(() => false);
      }
      const next = await gateway.prepareOverwrite(
        session.workspaceId,
        session.relativePath,
        session.markdown,
      );
      if (sequence !== sequenceRef.current) return;
      setProposal(next);
      setStep("confirm_overwrite");
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setError(normalizeDesktopError(reason, "editor_save_unavailable"));
      setStep("decision");
    }
  }

  async function confirmOverwrite() {
    if (!proposal || step !== "confirm_overwrite") return;
    const sequence = ++sequenceRef.current;
    setError(null);
    setStep("processing");
    try {
      const result = await gateway.confirmOverwrite(
        session.workspaceId,
        proposal.confirmationId,
        session.markdown,
      );
      if (sequence !== sequenceRef.current) return;
      onOverwrite(result);
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setProposal(null);
      setError(normalizeDesktopError(reason, "editor_save_unavailable"));
      setStep("decision");
    }
  }

  async function reload() {
    if (step !== "decision") return;
    setError(null);
    setStep("processing");
    try {
      await onReload();
    } catch (reason) {
      setError(normalizeDesktopError(reason, "editor_save_unavailable"));
      setStep("decision");
    }
  }

  async function close() {
    sequenceRef.current += 1;
    if (proposal) {
      await gateway.cancelOverwrite(proposal.confirmationId).catch(() => false);
    }
    setProposal(null);
    setStep("decision");
    onClose();
  }

  const processing = step === "preparing" || step === "processing";
  const latestRevision =
    proposal?.latestRevision ?? session.conflictEvidence?.diskRevision;
  return (
    <AppDialog
      actions={
        step === "confirm_overwrite" ? (
          <>
            <button
              className="plainroot-button"
              onClick={() => {
                if (proposal) {
                  void gateway
                    .cancelOverwrite(proposal.confirmationId)
                    .catch(() => false);
                }
                setProposal(null);
                setStep("decision");
              }}
              type="button"
            >
              返回选择
            </button>
            <button
              className="plainroot-button plainroot-button--danger"
              onClick={() => void confirmOverwrite()}
              type="button"
            >
              覆盖磁盘版本
            </button>
          </>
        ) : (
          <>
            <button
              className="plainroot-button"
              disabled={processing}
              onClick={() => void close()}
              type="button"
            >
              保持当前内容
            </button>
            <button
              className="plainroot-button"
              disabled={processing}
              onClick={onSaveCopy}
              type="button"
            >
              另存副本
            </button>
            <button
              className="plainroot-button"
              disabled={processing}
              onClick={() => void reload()}
              type="button"
            >
              放弃修改并重新加载
            </button>
            <button
              className="plainroot-button plainroot-button--danger"
              disabled={processing}
              onClick={() => void prepareOverwrite()}
              type="button"
            >
              准备覆盖磁盘版本
            </button>
          </>
        )
      }
      closeDisabled={processing}
      describedBy="conflict-description"
      labelledBy="conflict-title"
      onRequestClose={() => void close()}
      open={open}
      state={error ? "error" : processing ? "loading" : "conflict"}
    >
      <div className="editor-recovery-dialog">
        <p className="editor-recovery-dialog__eyebrow">外部修改冲突</p>
        <h2 id="conflict-title">
          {step === "confirm_overwrite"
            ? "再次确认覆盖磁盘版本"
            : "磁盘内容已在 Plainroot 之外变化"}
        </h2>
        <p id="conflict-description">
          {step === "confirm_overwrite"
            ? "继续会用当前编辑内容替换磁盘上的新版本。这个结果不会自动生成历史版本。"
            : "当前编辑内容没有被覆盖。请核对证据并选择明确的处理方式。"}
        </p>
        <dl className="editor-recovery-dialog__facts">
          <div>
            <dt>文档</dt>
            <dd>{session.relativePath}</dd>
          </div>
          <div>
            <dt>磁盘修改时间</dt>
            <dd>{formatTimestamp(latestRevision?.modifiedAt)}</dd>
          </div>
          <div>
            <dt>磁盘大小</dt>
            <dd>{latestRevision ? formatBytes(latestRevision.size) : "等待重新检查"}</dd>
          </div>
        </dl>
        <ContentSafetySummary
          contentSafety={session.contentSafety}
          saveState={session.saveState}
        />
        {error ? (
          <AsyncStatePanel
            compact
            description={desktopErrorMessage(error)}
            state="error"
            title="冲突处理没有完成"
          />
        ) : null}
      </div>
    </AppDialog>
  );
}

function formatTimestamp(value?: number): string {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(value))
    : "等待重新检查";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
