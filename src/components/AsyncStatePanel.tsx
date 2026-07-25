import type { ReactNode } from "react";

import {
  getAsyncStatePresentation,
  resolveAsyncState,
  type AsyncState,
} from "./asyncState";
import "./AsyncStatePanel.css";

export { resolveAsyncState, type AsyncState } from "./asyncState";

export interface AsyncStatePanelProps {
  title: string;
  description: string;
  state: AsyncState | readonly AsyncState[];
  compact?: boolean;
  actions?: ReactNode;
}

export function AsyncStatePanel({
  title,
  description,
  state,
  compact = false,
  actions,
}: AsyncStatePanelProps) {
  const resolvedState = resolveAsyncState(state);
  const presentation = getAsyncStatePresentation(resolvedState);
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
