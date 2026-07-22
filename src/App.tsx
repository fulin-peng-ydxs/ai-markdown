import { useEffect, useState } from "react";

import { AsyncStatePanel } from "./components/AsyncStatePanel";
import { WorkspaceLauncher } from "./features/launcher/WorkspaceLauncher";
import { WorkspaceWorkbench } from "./features/workbench/WorkspaceWorkbench";
import type { WorkspaceDescriptor } from "./services/desktop/contracts";
import { getWorkspaceWorkbenchSnapshot } from "./services/desktop/workspace";

import "./App.css";

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void getWorkspaceWorkbenchSnapshot()
      .then((snapshot) => {
        if (active) setWorkspace(snapshot?.workspace ?? null);
      })
      .catch(() => {
        if (!active) return;
        // The launcher reads the same versioned state and owns its actionable retry panel.
        // Falling back here avoids announcing the same persistent error twice.
        setWorkspace(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (workspace === undefined) {
    return (
      <main className="app-bootstrap" aria-label="Plainroot 正在启动">
        <AsyncStatePanel description="正在确认当前窗口是否已经绑定本地工作区。" state="loading" title="正在启动 Plainroot" />
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

  return <WorkspaceLauncher onWorkspaceOpened={setWorkspace} />;
}
