import { useMemo, useState } from "react";

import { AppDialog } from "../../components/AppDialog";
import type { WorkspaceTabManagerSnapshot } from "./WorkspaceTabManager";
import {
  projectWorkspaceTabSettlement,
  settlementBatchIsSafe,
  type WorkspaceTabExplicitResolution,
  type WorkspaceTabSettlementBatch,
  type WorkspaceTabSettlementProjection,
} from "./tabSettlement";
import type { WorkspaceTabId } from "./tabTypes";

import "./TabSettlementDialog.css";

export function TabSettlementDialog({
  batch,
  busyTabIds,
  finalActionLabel,
  onCancel,
  onCommit,
  onDiscard,
  onResolveConflict,
  onRetry,
  onSaveCopy,
  resolutions,
  snapshot,
}: {
  batch: WorkspaceTabSettlementBatch | null;
  busyTabIds: ReadonlySet<WorkspaceTabId>;
  finalActionLabel: string;
  onCancel(): void;
  onCommit(): void;
  onDiscard(tabId: WorkspaceTabId): void;
  onResolveConflict(tabId: WorkspaceTabId): void;
  onRetry(tabId: WorkspaceTabId): void;
  onSaveCopy(tabId: WorkspaceTabId): void;
  resolutions: ReadonlyMap<WorkspaceTabId, WorkspaceTabExplicitResolution>;
  snapshot: WorkspaceTabManagerSnapshot | null;
}) {
  const [discardTarget, setDiscardTarget] =
    useState<WorkspaceTabSettlementProjection | null>(null);
  const projections = useMemo(
    () =>
      batch && snapshot
        ? projectWorkspaceTabSettlement(batch, snapshot, resolutions)
        : [],
    [batch, resolutions, snapshot],
  );
  const safeCount = projections.filter((item) => item.safe).length;
  const ready = settlementBatchIsSafe(projections);
  const processing = busyTabIds.size > 0;

  return (
    <>
      <AppDialog
        actions={
          <>
            <button
              className="plainroot-button"
              disabled={processing}
              onClick={onCancel}
              type="button"
            >
              取消并保持全部页签
            </button>
            <button
              className="plainroot-button plainroot-button--primary"
              disabled={!ready || processing}
              onClick={onCommit}
              type="button"
            >
              {finalActionLabel}
            </button>
          </>
        }
        className="tab-settlement-dialog"
        closeDisabled={processing}
        describedBy="tab-settlement-description"
        labelledBy="tab-settlement-title"
        onRequestClose={onCancel}
        open={Boolean(batch && snapshot)}
        state={ready ? "ready" : "conflict"}
      >
        <div className="tab-settlement">
          <header className="tab-settlement__header">
            <div>
              <p className="tab-settlement__eyebrow">内容安全结算</p>
              <h2 id="tab-settlement-title">
                处理 {projections.length} 个页签后继续
              </h2>
            </div>
            <span aria-live="polite">
              已安全 {safeCount} / {projections.length}
            </span>
          </header>
          <p id="tab-settlement-description">
            取消会保持全部页签打开；已经成功写入磁盘的保存不会回滚。
          </p>
          <ol className="tab-settlement__list">
            {projections.map((item) => (
              <SettlementRow
                busy={busyTabIds.has(item.target.tabId)}
                item={item}
                key={`${item.target.tabId}:${item.target.incarnation}`}
                onDiscard={() => setDiscardTarget(item)}
                onResolveConflict={() => onResolveConflict(item.target.tabId)}
                onRetry={() => onRetry(item.target.tabId)}
                onSaveCopy={() => onSaveCopy(item.target.tabId)}
              />
            ))}
          </ol>
          <p className="tab-settlement__footnote">
            最终动作只在每个页签都有明确安全去向后启用。
          </p>
        </div>
      </AppDialog>
      <AppDialog
        actions={
          <>
            <button
              className="plainroot-button"
              onClick={() => setDiscardTarget(null)}
              type="button"
            >
              返回列表
            </button>
            <button
              className="plainroot-button plainroot-button--danger"
              onClick={() => {
                if (discardTarget) onDiscard(discardTarget.target.tabId);
                setDiscardTarget(null);
              }}
              type="button"
            >
              确认放弃这个页签的修改
            </button>
          </>
        }
        describedBy="tab-discard-description"
        labelledBy="tab-discard-title"
        onRequestClose={() => setDiscardTarget(null)}
        open={Boolean(discardTarget)}
        state="conflict"
      >
        <div className="tab-settlement__confirm">
          <h2 id="tab-discard-title">
            放弃“{discardTarget?.tab?.displayName}”的修改？
          </h2>
          <p id="tab-discard-description">
            这只会标记该页签可在最终提交时放弃。点击最终动作之前，页签和当前内存内容仍会保留。
          </p>
        </div>
      </AppDialog>
    </>
  );
}

function SettlementRow({
  busy,
  item,
  onDiscard,
  onResolveConflict,
  onRetry,
  onSaveCopy,
}: {
  busy: boolean;
  item: WorkspaceTabSettlementProjection;
  onDiscard(): void;
  onResolveConflict(): void;
  onRetry(): void;
  onSaveCopy(): void;
}) {
  const presentation = settlementPresentation(item);
  return (
    <li className="tab-settlement__row" data-state={item.state}>
      <div className="tab-settlement__copy">
        <div>
          <strong>{item.tab?.displayName ?? "页签已变化"}</strong>
          <span>{presentation.label}</span>
        </div>
        <code>{item.tab?.relativePath ?? item.target.tabId}</code>
        <p>
          <b>内容安全：</b>
          {presentation.safety}
        </p>
      </div>
      <div className="tab-settlement__actions">
        {item.safe ? (
          <button className="plainroot-button" disabled type="button">
            {presentation.action}
          </button>
        ) : (
          <>
            {item.state === "conflict" ? (
              <button
                className="plainroot-button"
                disabled={busy}
                onClick={onResolveConflict}
                type="button"
              >
                处理冲突
              </button>
            ) : (
              <button
                className="plainroot-button"
                disabled={busy || item.state === "stale"}
                onClick={onRetry}
                type="button"
              >
                {busy ? "正在保存…" : "重试保存"}
              </button>
            )}
            {item.session ? (
              <button
                className="plainroot-button"
                disabled={busy}
                onClick={onSaveCopy}
                type="button"
              >
                另存副本
              </button>
            ) : null}
            {item.session ? (
              <button
                className="plainroot-button plainroot-button--danger"
                disabled={busy}
                onClick={onDiscard}
                type="button"
              >
                放弃修改
              </button>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function settlementPresentation(item: WorkspaceTabSettlementProjection): {
  label: string;
  safety: string;
  action: string;
} {
  switch (item.state) {
    case "safe":
      return { label: "已保存", safety: "磁盘已是最新安全版本。", action: "无需处理" };
    case "resolved_copy":
      return {
        label: "副本已保存",
        safety: `独立副本已保存到 ${item.resolution?.kind === "save_copy" ? item.resolution.displayPath : "所选位置"}。`,
        action: "已处理",
      };
    case "resolved_discard":
      return { label: "待最终放弃", safety: "最终提交前内存内容仍保留。", action: "已确认" };
    case "dirty":
      return { label: "有未保存修改", safety: "当前窗口内存与恢复快照。", action: "" };
    case "saving":
      return { label: "正在保存", safety: "等待磁盘写入结果，尚未宣称保存完成。", action: "" };
    case "conflict":
      return { label: "磁盘冲突", safety: "内存内容仍在；磁盘已有外部版本。", action: "" };
    case "missing":
      return {
        label: "原文件缺失",
        safety: item.session
          ? "当前内容只在内存或恢复快照中。"
          : "没有已加载的内存修改；关闭不会删除其他内容。",
        action: item.session ? "" : "可安全关闭",
      };
    case "readonly":
      return { label: "只读", safety: "当前内容无法写回原文件。", action: "" };
    case "save_failed":
      return { label: "保存失败", safety: "当前内容尚未安全写入磁盘。", action: "" };
    case "unavailable":
      return { label: "不可用", safety: "没有待写入的内存修改。", action: "无需处理" };
    case "stale":
      return { label: "页签已变化", safety: "请取消并重新发起操作。", action: "" };
  }
}
