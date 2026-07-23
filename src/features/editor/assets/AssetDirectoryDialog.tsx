import { useEffect, useRef, useState } from "react";

import { AppDialog } from "../../../components/AppDialog";
import { AsyncStatePanel } from "../../../components/AsyncStatePanel";
import type {
  WorkspaceAssetPreference,
  WorkspaceId,
  WorkspaceRelativePath,
} from "../../../services/desktop/contracts";
import { desktopErrorMessage, normalizeDesktopError } from "../../../services/desktop/errors";
import type { EditorAssetGateway } from "../editorGateway";
import "./AssetDirectoryDialog.css";

export interface AssetDirectoryDialogProps {
  gateway: EditorAssetGateway;
  open: boolean;
  workspaceId: WorkspaceId;
  onPreferenceChange?(preference: WorkspaceAssetPreference): void;
  onRequestClose(): void;
}

export function AssetDirectoryDialog({
  gateway,
  open,
  workspaceId,
  onPreferenceChange,
  onRequestClose,
}: AssetDirectoryDialogProps) {
  const sequenceRef = useRef(0);
  const [directory, setDirectory] = useState("assets");
  const [status, setStatus] = useState<
    "idle" | "loading" | "saving" | "error"
  >("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const sequence = ++sequenceRef.current;
    setStatus("loading");
    setError("");
    void gateway
      .getPreference(workspaceId)
      .then((preference) => {
        if (sequence !== sequenceRef.current) return;
        setDirectory(preference.assetDirectory);
        setStatus("idle");
      })
      .catch((reason) => {
        if (sequence !== sequenceRef.current) return;
        setError(
          desktopErrorMessage(
            normalizeDesktopError(reason, "invalid_asset_directory"),
          ),
        );
        setStatus("error");
      });
    return () => {
      sequenceRef.current += 1;
    };
  }, [gateway, open, workspaceId]);

  async function persist(reset: boolean) {
    if (status === "saving") return;
    setStatus("saving");
    setError("");
    try {
      const preference = reset
        ? await gateway.resetDirectory(workspaceId)
        : await gateway.setDirectory(
            workspaceId,
            directory.trim() as WorkspaceRelativePath,
          );
      setDirectory(preference.assetDirectory);
      onPreferenceChange?.(preference);
      setStatus("idle");
      onRequestClose();
    } catch (reason) {
      setError(
        desktopErrorMessage(
          normalizeDesktopError(reason, "invalid_asset_directory"),
        ),
      );
      setStatus("error");
    }
  }

  const processing = status === "loading" || status === "saving";
  return (
    <AppDialog
      actions={
        <>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={onRequestClose}
            type="button"
          >
            取消
          </button>
          <button
            className="plainroot-button"
            disabled={processing}
            onClick={() => void persist(true)}
            type="button"
          >
            恢复为 assets/
          </button>
          <button
            className="plainroot-button plainroot-button--primary"
            disabled={processing || !directory.trim()}
            onClick={() => void persist(false)}
            type="button"
          >
            {status === "saving" ? "正在保存…" : "保存资源目录"}
          </button>
        </>
      }
      className="asset-directory-dialog"
      closeDisabled={processing}
      describedBy="asset-directory-description"
      labelledBy="asset-directory-title"
      onRequestClose={onRequestClose}
      open={open}
      state={status}
    >
      <div className="asset-directory-dialog__content">
        <p className="asset-directory-dialog__eyebrow">工作区资源</p>
        <h2 id="asset-directory-title">图片保存目录</h2>
        <p id="asset-directory-description">
          图片先写入这个工作区相对目录，成功后才把文档相对链接插入 Markdown。
        </p>
        {status === "loading" ? (
          <AsyncStatePanel
            compact
            description="正在读取此工作区的本地偏好。"
            state="loading"
            title="正在读取资源目录"
          />
        ) : (
          <label
            className="asset-directory-dialog__field"
            htmlFor="asset-directory-input"
          >
            <span>工作区相对目录</span>
            <input
              aria-label="工作区相对目录"
              autoComplete="off"
              disabled={processing}
              id="asset-directory-input"
              onChange={(event) => setDirectory(event.currentTarget.value)}
              spellCheck={false}
              value={directory}
            />
            <small>
              例如 assets 或 media/images；不能使用绝对路径、.. 或符号链接逃逸。
            </small>
          </label>
        )}
        {error ? (
          <AsyncStatePanel
            compact
            description={`${error} 原设置未被覆盖。`}
            state="error"
            title="资源目录没有更新"
          />
        ) : null}
      </div>
    </AppDialog>
  );
}
