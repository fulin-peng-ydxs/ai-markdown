import { useEffect, useState } from "react";

import { AsyncStatePanel } from "./components/AsyncStatePanel";
import { WorkspaceLauncher } from "./features/launcher/WorkspaceLauncher";
import { WorkspaceWorkbench } from "./features/workbench/WorkspaceWorkbench";
import type { DesktopError, WorkspaceDescriptor } from "./services/desktop/contracts";
import { desktopErrorMessage, normalizeDesktopError } from "./services/desktop/errors";
import { getWorkspaceWorkbenchSnapshot } from "./services/desktop/workspace";

import "./App.css";

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null | undefined>(undefined);
  const [error, setError] = useState<DesktopError | null>(null);

  useEffect(() => {
    let active = true;
    void getWorkspaceWorkbenchSnapshot()
      .then((snapshot) => {
        if (active) setWorkspace(snapshot?.workspace ?? null);
      })
      .catch((reason) => {
        if (!active) return;
        setError(normalizeDesktopError(reason, "state_unavailable"));
        setWorkspace(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (workspace === undefined) {
    return (
      <main className="app-bootstrap" aria-label="Plainroot 正在启动">
        <AsyncStatePanel description="正在确认当前窗口是否已经绑定本地工作区。" title="正在启动 Plainroot" />
      </main>
    );
  }

  if (workspace) {
    return (
      <WorkspaceWorkbench
        initialWorkspace={workspace}
        onWorkspaceChanged={setWorkspace}
      />
    );
  }

  return (
    <>
      {error ? (
        <div className="app-bootstrap app-bootstrap--error">
          <AsyncStatePanel description={desktopErrorMessage(error)} title="无法恢复当前窗口" tone="error" />
        </div>
      ) : null}
      <WorkspaceLauncher onWorkspaceOpened={setWorkspace} />
    </>
  );
}
