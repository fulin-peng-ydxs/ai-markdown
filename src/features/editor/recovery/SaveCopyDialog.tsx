import { useEffect, useRef, useState } from "react";

import { AppDialog } from "../../../components/AppDialog";
import { AsyncStatePanel } from "../../../components/AsyncStatePanel";
import type {
  DesktopError,
  SaveCopyFormatChoice,
  SaveCopyProposal,
  SaveCopyResult,
  SaveCopySource,
} from "../../../services/desktop/contracts";
import {
  desktopErrorMessage,
  normalizeDesktopError,
} from "../../../services/desktop/errors";
import type { EditorSaveGateway } from "../editorGateway";
import { desktopSaveGateway } from "../editorGateway";
import type { ReadyDocumentSession } from "../documentSession";
import { ContentSafetySummary } from "./ContentSafetySummary";

import "./recoveryDialogs.css";

type SaveCopyStep = "choose" | "choosing" | "confirm" | "saving";

export function SaveCopyDialog({
  gateway = desktopSaveGateway,
  onClose,
  onSaved,
  open,
  session,
}: {
  gateway?: EditorSaveGateway;
  onClose(): void;
  onSaved(result: SaveCopyResult): void;
  open: boolean;
  session: ReadyDocumentSession;
}) {
  const [step, setStep] = useState<SaveCopyStep>("choose");
  const [proposal, setProposal] = useState<SaveCopyProposal | null>(null);
  const [error, setError] = useState<DesktopError | null>(null);
  const [formatChoice, setFormatChoice] =
    useState<SaveCopyFormatChoice>(defaultFormatChoice(session));
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (open) return;
    sequenceRef.current += 1;
    setStep("choose");
    setProposal(null);
    setError(null);
    setFormatChoice(defaultFormatChoice(session));
  }, [open, session]);

  async function chooseTarget() {
    if (step === "choosing" || step === "saving") return;
    const sequence = ++sequenceRef.current;
    if (proposal) {
      await gateway.cancelSaveCopy(proposal.confirmationId).catch(() => false);
    }
    setProposal(null);
    setError(null);
    setStep("choosing");
    try {
      const outcome = await gateway.prepareSaveCopy(
        sourceForSession(session),
        formatChoice,
      );
      if (sequence !== sequenceRef.current) return;
      if (outcome.status === "cancelled") {
        setStep("choose");
        return;
      }
      setProposal(outcome.proposal);
      setStep("confirm");
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setError(normalizeDesktopError(reason, "save_copy_failed"));
      setStep("choose");
    }
  }

  async function saveCopy() {
    if (!proposal || step !== "confirm") return;
    const sequence = ++sequenceRef.current;
    setError(null);
    setStep("saving");
    try {
      const result = await gateway.confirmSaveCopy(
        proposal.confirmationId,
        session.markdown,
        proposal.targetState === "existing",
      );
      if (sequence !== sequenceRef.current) return;
      onSaved(result);
    } catch (reason) {
      if (sequence !== sequenceRef.current) return;
      setError(normalizeDesktopError(reason, "save_copy_failed"));
      setProposal(null);
      setStep("choose");
    }
  }

  async function close() {
    sequenceRef.current += 1;
    if (proposal) {
      await gateway.cancelSaveCopy(proposal.confirmationId).catch(() => false);
    }
    onClose();
  }

  const processing = step === "choosing" || step === "saving";
  return (
    <AppDialog
      actions={
        <>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={() => void close()}
            type="button"
          >
            取消另存
          </button>
          {proposal ? (
            <button
              className={
                proposal.targetState === "existing"
                  ? "plainroot-button plainroot-button--danger"
                  : "plainroot-button plainroot-button--primary"
              }
              disabled={processing}
              onClick={() => void saveCopy()}
              type="button"
            >
              {proposal.targetState === "existing" ? "覆盖并保存副本" : "保存副本"}
            </button>
          ) : (
            <button
              className="plainroot-button plainroot-button--primary"
              disabled={processing}
              onClick={() => void chooseTarget()}
              type="button"
            >
              {step === "choosing" ? "正在打开系统选择器…" : "选择保存位置"}
            </button>
          )}
        </>
      }
      closeDisabled={processing}
      describedBy="save-copy-description"
      labelledBy="save-copy-title"
      onRequestClose={() => void close()}
      open={open}
      state={error ? "error" : processing ? "loading" : "ready"}
    >
      <div className="editor-recovery-dialog">
        <p className="editor-recovery-dialog__eyebrow">另存副本</p>
        <h2 id="save-copy-title">保存一份独立的 Markdown 副本</h2>
        <p id="save-copy-description">
          目标只通过系统保存对话框授权一次。另存不会改变当前原文件的冲突或只读状态。
        </p>
        <ContentSafetySummary
          contentSafety={session.contentSafety}
          saveState={session.saveState}
        />
        {!proposal ? (
          <label className="editor-recovery-dialog__field">
            输出格式
            <select
              disabled={processing}
              onChange={(event) =>
                setFormatChoice(event.target.value as SaveCopyFormatChoice)
              }
              value={formatChoice}
            >
              <option value="preserve">保留 UTF-8 编码与原换行</option>
              <option value="utf8_lf">UTF-8 · LF</option>
              <option value="utf8_crlf">UTF-8 · CRLF</option>
              <option value="utf8_cr">UTF-8 · CR</option>
            </select>
          </label>
        ) : (
          <dl className="editor-recovery-dialog__facts">
            <div>
              <dt>保存目标</dt>
              <dd>{proposal.displayPath}</dd>
            </div>
            <div>
              <dt>目标状态</dt>
              <dd>
                {proposal.targetState === "existing"
                  ? "文件已存在；继续会覆盖这个目标"
                  : "新文件；不会覆盖已有内容"}
              </dd>
            </div>
            <div>
              <dt>输出格式</dt>
              <dd>
                {proposal.outputEncoding} · {proposal.outputLineEnding}
              </dd>
            </div>
          </dl>
        )}
        {error ? (
          <AsyncStatePanel
            compact
            description={desktopErrorMessage(error)}
            state="error"
            title="副本尚未保存"
          />
        ) : null}
      </div>
    </AppDialog>
  );
}

function defaultFormatChoice(
  session: ReadyDocumentSession,
): SaveCopyFormatChoice {
  if (!requiresDetachedSource(session) && session.sourceFormat.lineEnding !== "mixed") {
    return "preserve";
  }
  if (session.sourceFormat.lineEnding === "crlf") return "utf8_crlf";
  if (session.sourceFormat.lineEnding === "cr") return "utf8_cr";
  return "utf8_lf";
}

function sourceForSession(session: ReadyDocumentSession): SaveCopySource {
  if (requiresDetachedSource(session)) {
    return {
      kind: "new_document",
      suggestedName: session.relativePath.split("/").at(-1) ?? "恢复文档.md",
    };
  }
  return {
    kind: "workspace_document",
    workspaceId: session.workspaceId,
    relativePath: session.relativePath,
    revision: session.diskRevision,
  };
}

function requiresDetachedSource(session: ReadyDocumentSession): boolean {
  return (
    session.saveState.kind === "conflict" ||
    (session.saveState.kind === "save_failed" &&
      session.saveState.error.code === "path_not_found")
  );
}
