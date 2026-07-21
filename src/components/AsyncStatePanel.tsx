import type { ReactNode } from "react";

import "./AsyncStatePanel.css";

export interface AsyncStatePanelProps {
  title: string;
  description: string;
  tone?: "neutral" | "success" | "warning" | "error";
  compact?: boolean;
  live?: "polite" | "assertive";
  actions?: ReactNode;
}

export function AsyncStatePanel({
  title,
  description,
  tone = "neutral",
  compact = false,
  live = "polite",
  actions,
}: AsyncStatePanelProps) {
  return (
    <section
      aria-live={live}
      className="async-state-panel"
      data-compact={compact || undefined}
      data-tone={tone}
    >
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="async-state-panel__actions">{actions}</div> : null}
    </section>
  );
}
