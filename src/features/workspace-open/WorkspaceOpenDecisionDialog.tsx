import { useEffect, useState } from "react";

import { AppDialog } from "../../components/AppDialog";
import type {
  DesktopError,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
} from "../../services/desktop/contracts";
import { desktopErrorMessage } from "../../services/desktop/errors";

import "./WorkspaceOpenDialogs.css";

type DecisionOutcome = Extract<
  WorkspaceOpenOutcome,
  { status: "decision_required" }
>;

export function WorkspaceOpenDecisionDialog({
  error,
  onChoose,
  open,
  outcome,
  processing,
}: {
  error: DesktopError | null;
  onChoose(disposition: WorkspaceOpenDisposition, remember: boolean): void;
  open: boolean;
  outcome: DecisionOutcome | null;
  processing: boolean;
}) {
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) setRemember(false);
  }, [open, outcome?.workspace.id]);

  return (
    <AppDialog
      actions={
        <>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={() => onChoose("cancel", false)}
            type="button"
          >
            取消
          </button>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={() => onChoose("new_window", remember)}
            type="button"
          >
            在新窗口打开
          </button>
          <button
            className="plainroot-button plainroot-button--primary"
            disabled={processing}
            onClick={() => onChoose("current_window", remember)}
            type="button"
          >
            替换当前窗口
          </button>
        </>
      }
      closeDisabled={processing}
      describedBy="workspace-open-decision-description"
      labelledBy="workspace-open-decision-title"
      onRequestClose={() => onChoose("cancel", false)}
      open={open}
      state={error ? "error" : "ready"}
    >
      <div className="workspace-open-dialog">
        <p className="workspace-open-dialog__eyebrow">选择打开位置</p>
        <h2 id="workspace-open-decision-title">
          在哪里打开“{outcome?.workspace.displayName}”？
        </h2>
        <p id="workspace-open-decision-description">
          “{outcome?.currentWorkspaceName}”仍在当前窗口中。替换当前窗口前，
          Plainroot 会先处理全部页签；任何未解决项都会阻止替换。
        </p>
        <label className="workspace-open-dialog__check">
          <input
            checked={remember}
            disabled={processing}
            onChange={(event) => setRemember(event.currentTarget.checked)}
            type="checkbox"
          />
          记住这次选择
        </label>
        {error ? (
          <p
            aria-live="assertive"
            className="workspace-open-dialog__error"
          >
            {desktopErrorMessage(error)}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
