import { useEffect, useState } from "react";

import { AppDialog } from "../../components/AppDialog";
import type {
  DesktopError,
  WorkspaceOpenPreference,
  WorkspaceOpenPreferenceState,
} from "../../services/desktop/contracts";
import {
  desktopErrorMessage,
  normalizeDesktopError,
} from "../../services/desktop/errors";

import "./WorkspaceOpenDialogs.css";

export interface WorkspaceOpenPreferenceGateway {
  getOpenPreference(): Promise<WorkspaceOpenPreferenceState>;
  setOpenPreference(
    disposition: WorkspaceOpenPreference,
  ): Promise<WorkspaceOpenPreferenceState>;
  resetOpenPreference(): Promise<WorkspaceOpenPreferenceState>;
}

const OPTIONS: readonly {
  value: WorkspaceOpenPreference;
  label: string;
  description: string;
}[] = [
  {
    value: "ask",
    label: "每次询问",
    description: "当前窗口已有其他工作区时，再选择当前窗口或新窗口。",
  },
  {
    value: "current_window",
    label: "当前窗口",
    description: "先安全处理全部页签，再替换当前窗口的工作区。",
  },
  {
    value: "new_window",
    label: "新窗口",
    description: "为不同工作区创建独立窗口；已打开的目录仍会聚焦原窗口。",
  },
];

export function WorkspaceOpenPreferenceDialog({
  gateway,
  onClose,
  open,
}: {
  gateway: WorkspaceOpenPreferenceGateway;
  onClose(): void;
  open: boolean;
}) {
  const [value, setValue] = useState<WorkspaceOpenPreference>("ask");
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<DesktopError | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void gateway
      .getOpenPreference()
      .then((preference) => {
        if (!cancelled) setValue(preference.disposition);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(normalizeDesktopError(reason, "preferences_read_failed"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gateway, open]);

  async function save() {
    if (processing || loading) return;
    setProcessing(true);
    setError(null);
    try {
      const saved = await gateway.setOpenPreference(value);
      setValue(saved.disposition);
      onClose();
    } catch (reason) {
      setError(normalizeDesktopError(reason, "preferences_write_failed"));
    } finally {
      setProcessing(false);
    }
  }

  async function reset() {
    if (processing || loading) return;
    setProcessing(true);
    setError(null);
    try {
      const saved = await gateway.resetOpenPreference();
      setValue(saved.disposition);
    } catch (reason) {
      setError(normalizeDesktopError(reason, "preferences_write_failed"));
    } finally {
      setProcessing(false);
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
            取消
          </button>
          <button
            className="plainroot-button"
            disabled={processing || loading || value === "ask"}
            onClick={() => void reset()}
            type="button"
          >
            恢复为每次询问
          </button>
          <button
            className="plainroot-button plainroot-button--primary"
            disabled={processing || loading || Boolean(error)}
            onClick={() => void save()}
            type="button"
          >
            保存打开方式
          </button>
        </>
      }
      closeDisabled={processing}
      describedBy="workspace-open-preference-description"
      labelledBy="workspace-open-preference-title"
      onRequestClose={onClose}
      open={open}
      state={loading ? "loading" : error ? "error" : "ready"}
    >
      <div className="workspace-open-dialog">
        <p className="workspace-open-dialog__eyebrow">工作区偏好</p>
        <h2 id="workspace-open-preference-title">选择默认打开方式</h2>
        <p id="workspace-open-preference-description">
          该偏好只决定打开位置，不会跳过未保存、冲突或只读页签的安全处理。
        </p>
        <fieldset
          className="workspace-open-dialog__options"
          disabled={loading || processing}
        >
          <legend className="sr-only">默认打开方式</legend>
          {OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                checked={value === option.value}
                name="workspace-open-preference"
                onChange={() => setValue(option.value)}
                type="radio"
                value={option.value}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {loading ? (
          <p aria-live="polite" className="workspace-open-dialog__status">
            正在读取本机偏好…
          </p>
        ) : null}
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
