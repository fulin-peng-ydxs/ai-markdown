import assert from "node:assert/strict";

const workspaceRoot = process.env.PLAINROOT_E2E_WORKSPACE_ROOT;

async function invoke(command, args = {}) {
  const result = await browser.executeAsync((nextCommand, nextArgs, done) => {
    const tauriInvoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof tauriInvoke !== "function") {
      done({ error: "missing-invoke" });
      return;
    }
    tauriInvoke(nextCommand, nextArgs).then(
      (value) => done({ value }),
      (error) =>
        done({
          error:
            error && typeof error === "object"
              ? JSON.stringify(error)
              : String(error),
        }),
    );
  }, command, args);
  assert.equal(result.error, undefined, `${command}: ${JSON.stringify(result)}`);
  return result.value;
}

describe("Plainroot restart seed", () => {
  it("persists three real tabs before the desktop process stops", async () => {
    assert.ok(workspaceRoot, "restart fixture root is required");
    const selection = await invoke("prepare_e2e_workspace", {
      root: workspaceRoot,
    });
    assert.equal(selection.status, "ready");
    const workspace = await invoke("authorize_workspace_selection", {
      selectionId: selection.proposal.selectionId,
      confirmed: true,
    });
    const opened = await invoke("coordinate_workspace_open", {
      workspaceId: workspace.id,
      disposition: null,
    });
    assert.equal(opened.status, "opened_current");
    await browser.refresh();

    const workbench = await $('main[aria-label="Plainroot Markdown 工作台"]');
    await workbench.waitForDisplayed();
    for (const relativePath of [
      "note.md",
      "restart-ready.md",
      "restart-missing.md",
    ]) {
      const entry = await $(
        `[role="treeitem"][data-tree-path="${relativePath}"]`,
      );
      await entry.waitForDisplayed({ timeout: 10_000 });
      await entry.click();
      await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();
    }

    await browser.waitUntil(
      async () => {
        const session = await invoke("get_workspace_tab_session", {
          workspaceId: workspace.id,
          windowStateRef: null,
        });
        return (
          session.revision > 0 &&
          session.activeRelativePath === "restart-missing.md" &&
          session.tabs.length === 3
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: "the restart seed session was not persisted before exit",
      },
    );
  });
});
