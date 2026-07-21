import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function platformPathIdentity(path) {
  if (process.platform !== "win32") return path;
  return path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replaceAll("/", "\\")
    .toLocaleLowerCase("en-US");
}

function isTrustedTauriAppUrl(url) {
  return /^(?:tauri:\/\/localhost|http:\/\/tauri\.localhost)(?:\/|$)/.test(url);
}

async function resizeApp(width, height) {
  const result = await browser.executeAsync((nextWidth, nextHeight, done) => {
    const tauriWindow = window.__TAURI__?.window;
    if (!tauriWindow?.getCurrentWindow || !tauriWindow.LogicalSize) {
      done("missing-window-api");
      return;
    }
    tauriWindow
      .getCurrentWindow()
      .setSize(new tauriWindow.LogicalSize(nextWidth, nextHeight))
      .then(() => done("ok"), (error) => done(`error:${String(error)}`));
  }, width, height);
  assert.equal(result, "ok", "the E2E flavor must expose the scoped Tauri window API");
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => Math.abs(window.innerWidth - expectedWidth) <= 2, width),
    { timeout: 2_000, timeoutMsg: `native window did not reach ${width}px logical width` },
  );
}

async function layoutSnapshot() {
  return browser.execute(() => {
    const openPanel = document.querySelector(".launcher__open-panel");
    const recentPanel = document.querySelector(".launcher__recent-panel");
    const firstOpenButton = document.querySelector('[aria-label="打开文件夹"]');
    if (!(openPanel instanceof HTMLElement)
      || !(recentPanel instanceof HTMLElement)
      || !(firstOpenButton instanceof HTMLElement)) {
      throw new Error("launcher regions are not available");
    }
    return {
      href: window.location.href,
      hasTauriInvoke: typeof window.__TAURI_INTERNALS__?.invoke === "function",
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      openTop: Math.round(openPanel.getBoundingClientRect().top),
      openLeft: Math.round(openPanel.getBoundingClientRect().left),
      recentTop: Math.round(recentPanel.getBoundingClientRect().top),
      recentLeft: Math.round(recentPanel.getBoundingClientRect().left),
      focusedLabel: document.activeElement?.getAttribute("aria-label"),
      firstOpenVisible: firstOpenButton.getBoundingClientRect().height > 0,
    };
  });
}

describe("Plainroot desktop shell", () => {
  it("boots through the real Tauri IPC capability into the launcher", async () => {
    const launcher = await $('main[aria-label="Plainroot 启动页"]');
    await launcher.waitForDisplayed();
    assert.equal(await $("#open-local-title").getText(), "打开本地内容");
    assert.equal(await $(".launcher__empty h3").getText(), "还没有最近工作区");

    const state = await layoutSnapshot();
    assert.equal(
      isTrustedTauriAppUrl(state.href),
      true,
      `desktop shell must use a trusted Tauri app URL, received ${state.href}`,
    );
    assert.equal(state.hasTauriInvoke, true);
    assert.equal(state.firstOpenVisible, true);
  });

  it("keeps the launcher ordered and free of page overflow at desktop and narrow widths", async () => {
    await resizeApp(1100, 720);
    let state = await layoutSnapshot();
    assert.equal(state.horizontalOverflow, false);
    assert.ok(
      state.recentLeft > state.openLeft,
      `desktop panels should remain side by side: ${JSON.stringify(state)}`,
    );

    await resizeApp(740, 720);
    state = await layoutSnapshot();
    assert.equal(state.horizontalOverflow, false);
    assert.ok(state.openTop < state.recentTop, "narrow layout must keep opening actions before recents");
  });

  it("exposes the primary open actions in a stable focus sequence", async () => {
    await resizeApp(1100, 720);
    const focusSequence = await browser.execute(() => {
      const buttons = [...document.querySelectorAll(".launcher__open-panel .launcher__open-button")];
      return buttons.map((button) => {
        if (!(button instanceof HTMLElement)) throw new Error("open action is not focusable");
        button.focus();
        return {
          label: button.getAttribute("aria-label"),
          focused: document.activeElement === button,
          tabIndex: button.tabIndex,
        };
      });
    });
    assert.deepEqual(focusSequence, [
      { label: "打开文件夹", focused: true, tabIndex: 0 },
      { label: "打开 Markdown 文件", focused: true, tabIndex: 0 },
    ]);
  });

  it("opens a fixture workspace through real IPC and reads its initial Markdown", async () => {
    const fixtureRoot = resolve("tests/fixtures/workspaces/basic");
    const outcome = await browser.executeAsync((root, done) => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        done({ error: "missing-invoke" });
        return;
      }
      void (async () => {
        const selection = await invoke("prepare_e2e_workspace", { root });
        if (selection.status !== "ready") throw new Error(`unexpected selection: ${selection.status}`);
        const workspace = await invoke("authorize_workspace_selection", {
          selectionId: selection.proposal.selectionId,
          confirmed: true,
        });
        const opened = await invoke("coordinate_workspace_open", {
          workspaceId: workspace.id,
          disposition: null,
        });
        done({ opened, workspace });
      })().catch((error) => done({ error: String(error) }));
    }, fixtureRoot);

    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    assert.equal(outcome.opened.status, "opened_current");
    assert.equal(platformPathIdentity(outcome.workspace.canonicalRoot), platformPathIdentity(fixtureRoot));

    // The IPC call commits the native window binding behind the current React tree. Reloading
    // exercises the real bootstrap snapshot instead of injecting frontend state from the test.
    await browser.refresh();
    const workbench = await $('main[aria-label="Plainroot Markdown 工作台"]');
    await workbench.waitForDisplayed();
    const fixtureEntry = await $('[role="treeitem"][data-tree-path="note.md"]');
    await fixtureEntry.waitForDisplayed();
    await fixtureEntry.click();
    await browser.waitUntil(
      async () => (await $(".workbench__document pre").getText()).includes("# Plainroot fixture"),
      { timeout: 10_000, timeoutMsg: "fixture Markdown was not read through the workbench IPC" },
    );
    assert.equal(
      await $(".workbench__document pre").getText(),
      await readFile(resolve(fixtureRoot, "note.md"), "utf8"),
    );
  });
});
