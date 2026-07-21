import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppDialog } from "../../components/AppDialog";
import { AsyncStatePanel } from "../../components/AsyncStatePanel";
import type {
  DesktopError,
  RecentWorkspace,
  WorkspaceDescriptor,
  WorkspaceId,
  WorkspaceLauncherSnapshot,
  WorkspaceOpenDisposition,
  WorkspaceOpenOutcome,
  WorkspaceSelectionOutcome,
  WorkspaceSelectionProposal,
} from "../../services/desktop/contracts";
import {
  desktopErrorMessage,
  normalizeDesktopError,
} from "../../services/desktop/errors";
import {
  desktopWorkspaceLauncherGateway,
  type WorkspaceLauncherGateway,
} from "./launcherGateway";
import {
  filterRecentWorkspaces,
  formatLastOpened,
  restorableWorkspaces,
  type RestorableWorkspace,
} from "./launcherState";

import "./WorkspaceLauncher.css";

type OpenSource = { recent?: RecentWorkspace; restore?: RestorableWorkspace };
type BusyState = { title: string; description: string } | null;
type RestoreStatus = "waiting" | "restoring" | "restored" | "failed" | "needs_confirmation";

interface RestoreItem extends RestorableWorkspace {
  status: RestoreStatus;
  message?: string;
}

interface PendingConfirmation {
  proposal: WorkspaceSelectionProposal;
  source: OpenSource;
}

interface PendingDecision {
  outcome: Extract<WorkspaceOpenOutcome, { status: "decision_required" }>;
  source: OpenSource;
}

interface WorkspaceLauncherProps {
  gateway?: WorkspaceLauncherGateway;
  onWorkspaceOpened?(workspace: WorkspaceDescriptor): void;
}

interface LoadSnapshotOptions {
  preserveRestoreProgress?: boolean;
  showBusy?: boolean;
}

export function WorkspaceLauncher({
  gateway = desktopWorkspaceLauncherGateway,
  onWorkspaceOpened,
}: WorkspaceLauncherProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceLauncherSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<BusyState>({
    title: "正在读取本地工作区",
    description: "只读取 Plainroot 已保存的本地记录。",
  });
  const [error, setError] = useState<DesktopError | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [invalidRecent, setInvalidRecent] = useState<RecentWorkspace | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RecentWorkspace | null>(null);
  const [restoreItems, setRestoreItems] = useState<RestoreItem[]>([]);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const mountedRef = useRef(true);
  const openInFlightRef = useRef(false);
  const retryActionRef = useRef<(() => Promise<void>) | null>(null);
  const selectAndOpenRef = useRef<(kind: "folder" | "markdown") => Promise<void>>(
    async () => undefined,
  );

  const loadSnapshot = useCallback(async ({
    preserveRestoreProgress = false,
    showBusy = true,
  }: LoadSnapshotOptions = {}) => {
    retryActionRef.current = () => loadSnapshot();
    if (showBusy) {
      setBusy({
        title: "正在读取本地工作区",
        description: "正在核对最近记录与尚未恢复的窗口会话。",
      });
    }
    setError(null);
    try {
      const next = await gateway.snapshot();
      if (!mountedRef.current) return;
      setSnapshot(next);
      const restorable = restorableWorkspaces(next);
      setRestoreItems((current) => restorable.map((item) => {
        const previous = preserveRestoreProgress
          ? current.find(
            (candidate) => candidate.session.workspaceId === item.session.workspaceId,
          )
          : undefined;
        return {
          ...item,
          status: previous?.status ?? "waiting",
          message: previous?.message,
        };
      }));
      setRestoreOpen(restorable.length > 0);
    } catch (reason) {
      if (mountedRef.current) {
        setError(normalizeDesktopError(reason, "state_unavailable"));
      }
    } finally {
      if (mountedRef.current && showBusy) setBusy(null);
    }
  }, [gateway]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSnapshot();
    return () => {
      mountedRef.current = false;
    };
  }, [loadSnapshot]);

  const openFolder = useCallback(() => {
    void selectAndOpenRef.current("folder");
  }, []);

  const openMarkdown = useCallback(() => {
    void selectAndOpenRef.current("markdown");
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void gateway
      .listenMenu((action) => {
        if (action === "file.open_folder") openFolder();
        if (action === "file.open_markdown") openMarkdown();
      })
      .then((next) => {
        unlisten = next;
      })
      .catch(() => {
        // 页面按钮仍是完整入口；菜单订阅失败不应覆盖真实的状态仓储错误，
        // 也不能伪装成与本次失败无关的窗口聚焦错误。
      });
    return () => unlisten?.();
  }, [gateway, openFolder, openMarkdown]);

  const visibleRecent = useMemo(
    () => filterRecentWorkspaces(snapshot?.recentWorkspaces ?? [], query),
    [query, snapshot?.recentWorkspaces],
  );

  async function selectAndOpen(kind: "folder" | "markdown") {
    if (openInFlightRef.current) return;
    openInFlightRef.current = true;
    retryActionRef.current = () => selectAndOpen(kind);
    setBusy({
      title: kind === "folder" ? "正在打开文件夹" : "正在打开 Markdown 文件",
      description: "请在系统选择器中选择本地内容；取消不会写入任何记录。",
    });
    setError(null);
    try {
      const outcome =
        kind === "folder" ? await gateway.selectFolder() : await gateway.selectMarkdown();
      await consumeSelection(outcome, {});
    } catch (reason) {
      setError(normalizeDesktopError(reason, "selection_unavailable"));
    } finally {
      openInFlightRef.current = false;
      setBusy(null);
    }
  }

  selectAndOpenRef.current = selectAndOpen;

  async function openRecent(workspace: RecentWorkspace, restore?: RestorableWorkspace) {
    retryActionRef.current = () => openRecent(workspace, restore);
    setBusy({
      title: `正在核对“${workspace.displayName}”`,
      description: "确认目录仍可访问后才会恢复窗口。",
    });
    setError(null);
    try {
      const outcome = await gateway.validateRecent(workspace.workspaceId);
      await consumeSelection(outcome, { recent: workspace, restore });
    } catch (reason) {
      const nextError = normalizeDesktopError(reason, "recent_workspace_not_found");
      if (nextError.code === "path_not_found" || nextError.code === "permission_denied") {
        setInvalidRecent(workspace);
      } else {
        setError(nextError);
      }
    } finally {
      setBusy(null);
    }
  }

  async function consumeSelection(outcome: WorkspaceSelectionOutcome, source: OpenSource) {
    if (outcome.status === "cancelled") return;
    if (outcome.status === "already_open") {
      await coordinate(outcome.workspaceId, undefined, source);
      return;
    }
    if (outcome.status === "confirmation_required") {
      setConfirmation({ proposal: outcome.proposal, source });
      return;
    }
    const workspace = await gateway.authorize(outcome.proposal.selectionId, false);
    await coordinate(workspace.id, dispositionFor(source), source);
  }

  function dispositionFor(source: OpenSource): WorkspaceOpenDisposition | undefined {
    if (!source.restore || !snapshot) return undefined;
    return source.restore.session.windowLabel === snapshot.windowLabel
      ? "current_window"
      : "new_window";
  }

  async function coordinate(
    workspaceId: WorkspaceId,
    disposition: WorkspaceOpenDisposition | undefined,
    source: OpenSource,
    reloadSnapshot = true,
  ) {
    const outcome = await gateway.open(workspaceId, disposition);
    if (outcome.status === "decision_required") {
      setDecision({ outcome, source });
      return;
    }
    if (outcome.status === "cancelled") return;
    if (outcome.status === "opened_current" && onWorkspaceOpened) {
      onWorkspaceOpened(outcome.workspace);
      return;
    }
    if (source.restore) markRestore(source.restore.session.workspaceId, "restored");
    if (source.recent && source.recent.workspaceId !== workspaceId) {
      await gateway.removeRecent(source.recent.workspaceId).catch(() => false);
    }
    if (reloadSnapshot) await loadSnapshot();
  }

  async function authorizePending() {
    if (!confirmation) return;
    const pending = confirmation;
    setBusy({ title: "正在授权本地范围", description: "授权前会再次校验所选路径。" });
    setConfirmation(null);
    retryActionRef.current = null;
    try {
      const workspace = await gateway.authorize(pending.proposal.selectionId, true);
      await coordinate(workspace.id, dispositionFor(pending.source), pending.source);
    } catch (reason) {
      setError(normalizeDesktopError(reason, "selection_unavailable"));
    } finally {
      setBusy(null);
    }
  }

  async function cancelPending() {
    if (!confirmation) return;
    const id = confirmation.proposal.selectionId;
    setConfirmation(null);
    await gateway.cancelSelection(id).catch(() => false);
  }

  async function chooseDisposition(disposition: WorkspaceOpenDisposition) {
    if (!decision) return;
    const pending = decision;
    setDecision(null);
    retryActionRef.current = () =>
      coordinate(pending.outcome.workspace.id, disposition, pending.source);
    setBusy({ title: "正在打开工作区", description: "正在提交窗口与本地会话状态。" });
    try {
      await coordinate(pending.outcome.workspace.id, disposition, pending.source);
    } catch (reason) {
      setError(normalizeDesktopError(reason, "window_create_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function removeRecentRecord(workspace: RecentWorkspace) {
    setBusy({ title: "正在移除记录", description: "不会删除本地文件。" });
    setRemoveTarget(null);
    try {
      await gateway.removeRecent(workspace.workspaceId);
      setInvalidRecent(null);
      await loadSnapshot();
    } catch (reason) {
      setError(normalizeDesktopError(reason, "state_write_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function reauthorizeInvalid() {
    const previous = invalidRecent;
    setInvalidRecent(null);
    if (!previous) return;
    setBusy({ title: "正在重新授权", description: "请选择该工作区当前所在的文件夹。" });
    try {
      const outcome = await gateway.selectFolder();
      await consumeSelection(outcome, { recent: previous });
    } catch (reason) {
      setError(normalizeDesktopError(reason, "selection_unavailable"));
    } finally {
      setBusy(null);
    }
  }

  function markRestore(workspaceId: WorkspaceId, status: RestoreStatus, message?: string) {
    setRestoreItems((items) =>
      items.map((item) =>
        item.session.workspaceId === workspaceId ? { ...item, status, message } : item,
      ),
    );
  }

  async function removeRestoreItem(item: RestoreItem) {
    try {
      await gateway.removeSession(item.session.workspaceId);
      setRestoreItems((items) =>
        items.filter((candidate) => candidate.session.workspaceId !== item.session.workspaceId),
      );
    } catch (reason) {
      markRestore(
        item.session.workspaceId,
        "failed",
        desktopErrorMessage(normalizeDesktopError(reason, "state_write_failed")),
      );
    }
  }

  async function restoreAll() {
    const ordered = [...restoreItems].sort((left, right) => {
      if (!snapshot) return 0;
      return Number(right.session.windowLabel === snapshot.windowLabel) -
        Number(left.session.windowLabel === snapshot.windowLabel);
    });
    for (const item of ordered) {
      if (!item.recent || item.status === "restored") continue;
      markRestore(item.session.workspaceId, "restoring");
      try {
        const outcome = await gateway.validateRecent(item.session.workspaceId);
        if (outcome.status === "confirmation_required") {
          await gateway.cancelSelection(outcome.proposal.selectionId).catch(() => false);
          markRestore(item.session.workspaceId, "needs_confirmation", "需要重新确认授权范围");
          continue;
        }
        if (outcome.status === "cancelled") {
          markRestore(item.session.workspaceId, "failed", "校验已取消");
          continue;
        }
        const workspaceId =
          outcome.status === "already_open"
            ? outcome.workspaceId
            : (await gateway.authorize(outcome.proposal.selectionId, false)).id;
        await coordinate(
          workspaceId,
          dispositionFor({ restore: item }),
          { restore: item },
          false,
        );
        markRestore(item.session.workspaceId, "restored");
      } catch (reason) {
        const nextError = normalizeDesktopError(reason, "state_unavailable");
        markRestore(item.session.workspaceId, "failed", desktopErrorMessage(nextError));
      }
    }
    await loadSnapshot({ preserveRestoreProgress: true, showBusy: false });
  }

  const currentWorkspace = snapshot?.currentWorkspaceId
    ? snapshot.recentWorkspaces.find(
        (workspace) => workspace.workspaceId === snapshot.currentWorkspaceId,
      ) ?? null
    : null;

  return (
    <main className="launcher" aria-label="Plainroot 启动页">
      <header className="launcher__header">
        <div className="launcher__brand" aria-label="Plainroot">
          <span aria-hidden="true">~/</span>
          <strong>Plainroot</strong>
        </div>
        <p>本地优先的 Markdown 工作空间</p>
      </header>

      <section className="launcher__content">
        <aside className="launcher__open-panel" aria-labelledby="open-local-title">
          <div>
            <p className="launcher__eyebrow">LOCAL FIRST</p>
            <h1 id="open-local-title">打开本地内容</h1>
            <p className="launcher__lead">
              文档保留在你的目录中。Plainroot 只访问你明确选择的范围。
            </p>
          </div>
          <div className="launcher__primary-actions">
            <button aria-label="打开文件夹" className="launcher__open-button" onClick={openFolder} type="button">
              <span className="launcher__open-icon" aria-hidden="true">⌁</span>
              <span><strong>打开文件夹</strong><small>作为独立工作区</small></span>
              <kbd>⌘ O</kbd>
            </button>
            <button aria-label="打开 Markdown 文件" className="launcher__open-button" onClick={openMarkdown} type="button">
              <span className="launcher__open-icon" aria-hidden="true">M↓</span>
              <span><strong>打开 Markdown 文件</strong><small>授权文件所在目录</small></span>
              <kbd>⇧ ⌘ O</kbd>
            </button>
          </div>
          <p className="launcher__privacy">无需账号 · 不上传文档 · 可离线使用</p>
        </aside>

        <section className="launcher__recent-panel" aria-labelledby="recent-title">
          <div className="launcher__recent-heading">
            <div>
              <p className="launcher__eyebrow">WORKSPACES</p>
              <h2 id="recent-title">最近打开</h2>
            </div>
            {snapshot && snapshot.recentWorkspaces.length > 0 ? (
              <label className="launcher__filter">
                <span className="sr-only">过滤最近工作区</span>
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="按名称或路径过滤"
                  type="search"
                  value={query}
                />
              </label>
            ) : null}
          </div>

          {error ? (
            <AsyncStatePanel
              actions={<><button className="plainroot-button" onClick={() => setError(null)} type="button">关闭</button><button className="plainroot-button" onClick={() => void (retryActionRef.current?.() ?? loadSnapshot())} type="button">重试</button></>}
              description={desktopErrorMessage(error)}
              live="assertive"
              title={snapshot ? "操作没有完成" : "无法读取本地工作区"}
              tone="error"
            />
          ) : null}

          {currentWorkspace ? (
            <AsyncStatePanel
              description={`${currentWorkspace.canonicalRoot} 已连接。当前窗口尚未载入文件树与编辑视图。`}
              title={`已打开“${currentWorkspace.displayName}”`}
              tone="success"
            />
          ) : null}

          {!busy && snapshot && snapshot.recentWorkspaces.length === 0 ? (
            <div className="launcher__empty">
              <span aria-hidden="true">~/</span>
              <h3>还没有最近工作区</h3>
              <p>打开一个本地文件夹后，它会安全地出现在这里。</p>
              <button className="plainroot-button" onClick={openFolder} type="button">打开文件夹</button>
            </div>
          ) : null}

          {!busy && snapshot && snapshot.recentWorkspaces.length > 0 && visibleRecent.length === 0 ? (
            <div className="launcher__empty launcher__empty--filtered">
              <h3>没有匹配的工作区</h3>
              <p>过滤只检查工作区名称和本地路径。</p>
              <button className="plainroot-button" onClick={() => setQuery("")} type="button">清除过滤</button>
            </div>
          ) : null}

          {visibleRecent.length > 0 ? (
            <ul className="launcher__recent-list">
              {visibleRecent.map((workspace) => (
                <li key={workspace.workspaceId} data-availability={workspace.availability}>
                  <button className="launcher__recent-main" onClick={() => void openRecent(workspace)} type="button">
                    <span className="launcher__folder-mark" aria-hidden="true">▱</span>
                    <span className="launcher__recent-copy">
                      <strong>{workspace.displayName}</strong>
                      <small>{workspace.canonicalRoot}</small>
                    </span>
                    <span className="launcher__recent-meta">
                      {workspace.availability === "missing" ? "位置失效" : workspace.availability === "permission_denied" ? "需要授权" : formatLastOpened(workspace.lastOpenedAt)}
                    </span>
                  </button>
                  <button
                    aria-label={`移除“${workspace.displayName}”的最近记录`}
                    className="launcher__remove"
                    onClick={() => setRemoveTarget(workspace)}
                    title="仅移除记录，不删除本地文件"
                    type="button"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </section>

      <footer className="launcher__footer">
        <span>Plainroot</span><span>本地文档不会离开你的设备</span>
      </footer>

      <AppDialog
        closeDisabled
        describedBy="launcher-busy-description"
        labelledBy="launcher-busy-title"
        onRequestClose={() => undefined}
        open={Boolean(busy)}
        state="loading"
      >
        <div className="launcher-dialog-copy">
          <span className="launcher-spinner" aria-hidden="true" />
          <div><h2 id="launcher-busy-title">{busy?.title}</h2><p id="launcher-busy-description">{busy?.description}</p></div>
        </div>
      </AppDialog>

      <AppDialog
        describedBy="scope-description"
        labelledBy="scope-title"
        onRequestClose={() => void cancelPending()}
        open={Boolean(confirmation)}
        actions={<><button className="plainroot-button" onClick={() => void cancelPending()} type="button">取消</button><button className="plainroot-button plainroot-button--primary" onClick={() => void authorizePending()} type="button">授权并打开</button></>}
      >
        <div className="launcher-dialog-text"><p className="launcher__eyebrow">授权范围确认</p><h2 id="scope-title">允许访问“{confirmation?.proposal.displayName}”？</h2><p id="scope-description">Plainroot 将访问下列本地目录。打开单个 Markdown 文件时，也需要访问它所在的目录。</p><dl><dt>所选位置</dt><dd>{confirmation?.proposal.selectedPath}</dd><dt>实际范围</dt><dd>{confirmation?.proposal.canonicalRoot}</dd></dl></div>
      </AppDialog>

      <AppDialog
        describedBy="decision-description"
        labelledBy="decision-title"
        onRequestClose={() => void chooseDisposition("cancel")}
        open={Boolean(decision)}
        actions={<><button className="plainroot-button" onClick={() => void chooseDisposition("cancel")} type="button">取消</button><button className="plainroot-button" onClick={() => void chooseDisposition("new_window")} type="button">在新窗口打开</button><button className="plainroot-button plainroot-button--primary" onClick={() => void chooseDisposition("current_window")} type="button">替换当前窗口</button></>}
      >
        <div className="launcher-dialog-text"><p className="launcher__eyebrow">选择打开位置</p><h2 id="decision-title">当前窗口已有工作区</h2><p id="decision-description">“{decision?.outcome.currentWorkspaceName}”正在当前窗口中。你想在哪里打开“{decision?.outcome.workspace.displayName}”？</p></div>
      </AppDialog>

      <AppDialog
        describedBy="invalid-description"
        labelledBy="invalid-title"
        onRequestClose={() => setInvalidRecent(null)}
        open={Boolean(invalidRecent)}
        actions={<><button className="plainroot-button" onClick={() => setInvalidRecent(null)} type="button">稍后处理</button><button className="plainroot-button" onClick={() => { if (invalidRecent) setRemoveTarget(invalidRecent); setInvalidRecent(null); }} type="button">移除记录</button><button className="plainroot-button plainroot-button--primary" onClick={() => void reauthorizeInvalid()} type="button">重新授权并继续</button></>}
      >
        <div className="launcher-dialog-text"><p className="launcher__eyebrow">本地位置不可用</p><h2 id="invalid-title">无法打开“{invalidRecent?.displayName}”</h2><p id="invalid-description">目录可能已移动、断开或权限已变化。移除记录不会删除本地文件。</p><code>{invalidRecent?.canonicalRoot}</code></div>
      </AppDialog>

      <AppDialog
        describedBy="remove-description"
        labelledBy="remove-title"
        onRequestClose={() => setRemoveTarget(null)}
        open={Boolean(removeTarget)}
        actions={<><button className="plainroot-button" onClick={() => setRemoveTarget(null)} type="button">取消</button><button className="plainroot-button plainroot-button--danger" onClick={() => removeTarget && void removeRecentRecord(removeTarget)} type="button">仅移除记录</button></>}
      >
        <div className="launcher-dialog-text"><p className="launcher__eyebrow">最近记录</p><h2 id="remove-title">移除“{removeTarget?.displayName}”？</h2><p id="remove-description">只会从 Plainroot 的最近列表和待恢复会话中移除，不会删除或修改任何本地文件。</p></div>
      </AppDialog>

      <AppDialog
        describedBy="restore-description"
        labelledBy="restore-title"
        onRequestClose={() => setRestoreOpen(false)}
        open={restoreOpen && restoreItems.length > 0}
        actions={<><button className="plainroot-button" onClick={() => setRestoreOpen(false)} type="button">暂不恢复</button><button className="plainroot-button plainroot-button--primary" onClick={() => void restoreAll()} type="button">恢复可用窗口</button></>}
      >
        <div className="launcher-dialog-text"><p className="launcher__eyebrow">上次会话</p><h2 id="restore-title">恢复工作区窗口</h2><p id="restore-description">逐个核对本地目录；一个项目失败不会阻止其他项目恢复。</p><ul className="launcher__restore-list">{restoreItems.map((item) => <li key={item.session.workspaceId} data-status={item.status}><span><strong>{item.recent?.displayName ?? "未知工作区"}</strong><small>{item.message ?? item.recent?.canonicalRoot ?? "最近记录已移除"}</small></span><div className="launcher__restore-actions"><em>{restoreStatusLabel(item.status)}</em>{item.status === "failed" || item.status === "needs_confirmation" ? item.recent ? <button className="plainroot-button" onClick={() => void openRecent(item.recent!, item)} type="button">重试</button> : <button className="plainroot-button" onClick={() => void removeRestoreItem(item)} type="button">移除失效会话</button> : null}{item.status === "waiting" ? <button className="plainroot-button" onClick={() => markRestore(item.session.workspaceId, "failed", "本次已跳过")} type="button">跳过</button> : null}</div></li>)}</ul></div>
      </AppDialog>
    </main>
  );
}

function restoreStatusLabel(status: RestoreStatus): string {
  return {
    waiting: "等待",
    restoring: "正在恢复",
    restored: "已恢复",
    failed: "失败",
    needs_confirmation: "需确认",
  }[status];
}
