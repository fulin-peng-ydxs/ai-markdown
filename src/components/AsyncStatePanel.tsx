import type { ReactNode } from "react";

import "./AsyncStatePanel.css";

export interface AsyncStatePanelProps {
  title: string;
  description: string;
  state: AsyncState | readonly AsyncState[];
  compact?: boolean;
  actions?: ReactNode;
}

export type AsyncState =
  | "ready"
  | "loading"
  | "empty"
  | "error"
  | "readonly"
  | "dirty"
  | "saving"
  | "conflict"
  | "missing"
  | "permission_denied"
  | "unsupported";

const STATE_PRESENTATION: Record<
  AsyncState,
  {
    label: string;
    live: "polite" | "assertive";
    role: "status" | "alert";
    tone: "neutral" | "success" | "warning" | "error";
    priority: number;
  }
> = {
  ready: { label: "已就绪", live: "polite", role: "status", tone: "success", priority: 10 },
  empty: { label: "暂无内容", live: "polite", role: "status", tone: "neutral", priority: 20 },
  readonly: { label: "只读", live: "polite", role: "status", tone: "warning", priority: 40 },
  dirty: { label: "未保存", live: "polite", role: "status", tone: "warning", priority: 50 },
  loading: { label: "正在处理", live: "polite", role: "status", tone: "neutral", priority: 60 },
  saving: { label: "正在保存", live: "polite", role: "status", tone: "neutral", priority: 70 },
  unsupported: { label: "不支持", live: "polite", role: "status", tone: "warning", priority: 75 },
  error: { label: "操作失败", live: "assertive", role: "alert", tone: "error", priority: 80 },
  conflict: { label: "内容冲突", live: "assertive", role: "alert", tone: "error", priority: 90 },
  missing: { label: "位置失效", live: "assertive", role: "alert", tone: "warning", priority: 95 },
  permission_denied: { label: "需要授权", live: "assertive", role: "alert", tone: "error", priority: 100 },
};

export function resolveAsyncState(states: AsyncState | readonly AsyncState[]): AsyncState {
  const candidates = typeof states === "string" ? [states] : states;
  return candidates.reduce<AsyncState>(
    (dominant, candidate) =>
      STATE_PRESENTATION[candidate].priority > STATE_PRESENTATION[dominant].priority
        ? candidate
        : dominant,
    "ready",
  );
}

export function AsyncStatePanel({
  title,
  description,
  state,
  compact = false,
  actions,
}: AsyncStatePanelProps) {
  const resolvedState = resolveAsyncState(state);
  const presentation = STATE_PRESENTATION[resolvedState];
  return (
    <section
      aria-live={presentation.live}
      className="async-state-panel"
      data-compact={compact || undefined}
      data-state={resolvedState}
      data-tone={presentation.tone}
      role={presentation.role}
    >
      <div>
        <span className="async-state-panel__label">{presentation.label}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="async-state-panel__actions">{actions}</div> : null}
    </section>
  );
}
