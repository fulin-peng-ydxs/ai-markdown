import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createWorkspaceFixture } from "../../support/workspace-fixture.mjs";

const VISUAL_MARKER = "T31-visual-edit";
const SOURCE_MARKER = "T31-source-edit";
const VISUAL_EVIDENCE = "T31-visual-";
const SOURCE_EVIDENCE = "T31-source-";
const EXTERNAL_MARKER = "T31-external-conflict";
const LOCAL_CONFLICT_MARKER = "T31-local-conflict";
const WINDOW_INTENT_DIRTY_MARKER = "T45-window-intent-dirty";
const WINDOW_INTENT_EXTERNAL_MARKER = "T45-window-intent-external";
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
  0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

let fixture;
let fixtureCanonicalRoot;
let workspaceId;

function platformPathIdentity(path) {
  if (process.platform !== "win32") return path;
  return path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replaceAll("/", "\\")
    .toLocaleLowerCase("en-US");
}

function normalizeLineEndings(markdown) {
  return markdown.replace(/\r\n|\r/g, "\n");
}

function lineEndingFromMarkdown(markdown) {
  if (markdown.includes("\r\n")) return "\r\n";
  if (markdown.includes("\r")) return "\r";
  return "\n";
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

async function editorChromeSnapshot() {
  return browser.execute(() => {
    const toolbar = document.querySelector(".document-editor-toolbar");
    const actions = document.querySelector(".document-editor-toolbar__actions");
    const scrollRegion = document.querySelector(
      ".document-editor-toolbar__scroll-region",
    );
    const save = document.querySelector('[aria-label="保存当前文档"]');
    const find = document.querySelector(
      '[aria-label="切换源码并查找"], [aria-label="在当前文档中查找"]',
    );
    const statusbar = document.querySelector(".workbench__statusbar");
    const path = document.querySelector(".workbench__document-path");
    if (
      !(toolbar instanceof HTMLElement) ||
      !(actions instanceof HTMLElement) ||
      !(scrollRegion instanceof HTMLElement) ||
      !(save instanceof HTMLElement) ||
      !(find instanceof HTMLElement) ||
      !(statusbar instanceof HTMLElement) ||
      !(path instanceof HTMLElement)
    ) {
      throw new Error("editor chrome is not available");
    }
    const toolbarRect = toolbar.getBoundingClientRect();
    const actionRect = actions.getBoundingClientRect();
    const saveRect = save.getBoundingClientRect();
    const findRect = find.getBoundingClientRect();
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      formatRegionOverflowX: getComputedStyle(scrollRegion).overflowX,
      actionsInsideToolbar:
        actionRect.left >= toolbarRect.left &&
        actionRect.right <= toolbarRect.right + 1,
      saveVisible:
        saveRect.width > 0 &&
        saveRect.left >= toolbarRect.left &&
        saveRect.right <= toolbarRect.right + 1,
      findVisible:
        findRect.width > 0 &&
        findRect.left >= toolbarRect.left &&
        findRect.right <= toolbarRect.right + 1,
      saveStatusCount: document.querySelectorAll(".document-save-status").length,
      statusPath: path.textContent?.trim() ?? "",
      statusPathTitle: path.getAttribute("title"),
    };
  });
}

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

async function openFixtureWorkspace() {
  const selection = await invoke("prepare_e2e_workspace", { root: fixture.root });
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
  assert.equal(
    platformPathIdentity(workspace.canonicalRoot),
    platformPathIdentity(fixtureCanonicalRoot),
  );
  workspaceId = workspace.id;
}

async function focusAtEnd(selector) {
  const focused = await browser.execute((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) return false;
    target.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.activeElement === target;
  }, selector);
  assert.equal(focused, true, `could not focus ${selector}`);
}

async function appendEditorText(selector, text) {
  await focusAtEnd(selector);
  await $(selector).addValue(text);
}

async function editorText(selector) {
  return browser.execute((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!target) return "";
    const codeMirrorLines = [...target.querySelectorAll(".cm-line")];
    if (codeMirrorLines.length > 0) {
      return codeMirrorLines.map((line) => line.textContent ?? "").join("\n");
    }
    return target.textContent ?? "";
  }, selector);
}

async function switchToSource() {
  const sourceButton = await $('button=源码');
  await sourceButton.click();
  const source = await $('[aria-label="Markdown 源码编辑区"]');
  await source.waitForDisplayed();
  return source;
}

async function openFixtureDocument() {
  const fixtureEntry = await $('[role="treeitem"][data-tree-path="note.md"]');
  await fixtureEntry.waitForDisplayed();
  await fixtureEntry.click();
  const editor = await $('[aria-label="Markdown 排版编辑区"]');
  await editor.waitForDisplayed();
  return editor;
}

async function runtimeMemorySnapshot() {
  const rssBytes = await invoke("e2e_process_rss_bytes");
  const heapBytes = await browser.execute(
    () => performance.memory?.usedJSHeapSize ?? null,
  );
  return { rssBytes, heapBytes };
}

describe("Plainroot desktop shell", () => {
  before(async () => {
    fixture = await createWorkspaceFixture();
    fixtureCanonicalRoot = await realpath(fixture.root);
  });

  after(async () => {
    await fixture?.cleanup();
  });

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
    await openFixtureWorkspace();

    // The IPC call commits the native window binding behind the current React tree. Reloading
    // exercises the real bootstrap snapshot instead of injecting frontend state from the test.
    await browser.refresh();
    const workbench = await $('main[aria-label="Plainroot Markdown 工作台"]');
    await workbench.waitForDisplayed();
    const editor = await openFixtureDocument();
    assert.equal(
      (
        await editorText('[aria-label="Markdown 排版编辑区"]')
      ).includes("Plainroot fixture"),
      true,
      "fixture Markdown was not read through the production visual editor",
    );
    assert.equal(
      normalizeLineEndings(
        await readFile(join(fixture.root, "note.md"), "utf8"),
      ),
      "# Plainroot fixture\n\nThis Markdown file belongs only to the automated test fixture.\n",
    );
    for (const width of [1100, 1050, 820, 740]) {
      await resizeApp(width, 720);
      const chrome = await editorChromeSnapshot();
      assert.equal(chrome.horizontalOverflow, false);
      assert.equal(chrome.toolbarOverflow, false);
      assert.equal(chrome.formatRegionOverflowX, "auto");
      assert.equal(chrome.actionsInsideToolbar, true);
      assert.equal(chrome.saveVisible, true);
      assert.equal(chrome.findVisible, true);
      assert.equal(chrome.saveStatusCount, 1);
      assert.equal(chrome.statusPath, "note.md");
      assert.equal(chrome.statusPathTitle, "note.md");
    }
    await resizeApp(1100, 720);
  });

  it("keeps one real editor adapter while three document sessions switch within a bounded runtime", async () => {
    const extraPaths = ["tab-two.md", "tab-three.md"];
    const largeBody = `${"# Runtime tab\n\n"}${"Plainroot tab runtime probe.\n\n".repeat(700)}`;
    for (const relativePath of extraPaths) {
      await writeFile(join(fixture.root, relativePath), largeBody, "utf8");
    }
    await $('[title="刷新文件树"]').click();
    for (const relativePath of extraPaths) {
      const entry = await $(
        `[role="treeitem"][data-tree-path="${relativePath}"]`,
      );
      await entry.waitForDisplayed({ timeout: 10_000 });
      await entry.click();
      await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();
    }
    await $('[role="treeitem"][data-tree-path="note.md"]').click();
    await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();
    const tabList = await $('[role="tablist"][aria-label="打开的文档"]');
    await tabList.waitForDisplayed();
    assert.equal(
      await tabList.$$('[role="tab"]').length,
      3,
      "three open documents must render as three real tabs",
    );
    assert.equal(
      await tabList.$('[role="tab"][aria-selected="true"] strong').getText(),
      "note.md",
    );

    await tabList.$$('button[role="tab"]')[1].click();
    await browser.waitUntil(
      async () =>
        (await tabList
          .$('[role="tab"][aria-selected="true"] strong')
          .getText()) === "tab-two.md",
      {
        timeout: 10_000,
        timeoutMsg: "clicking the visible tab did not activate its document",
      },
    );

    const overflowTrigger = await $('button[aria-label="所有页签"]');
    await overflowTrigger.click();
    const overflowMenu = await $('[role="menu"][aria-label="所有页签与最近关闭"]');
    await overflowMenu.waitForDisplayed();
    assert.equal(
      await overflowMenu.$$('[role="menuitem"]').length,
      3,
      "overflow menu must expose every open tab",
    );
    await browser.keys("Escape");
    await overflowMenu.waitForDisplayed({ reverse: true });
    assert.equal(
      await browser.execute(
        () => document.activeElement?.getAttribute("aria-label"),
      ),
      "所有页签",
      "Escape must restore focus to the overflow trigger",
    );

    for (const width of [1100, 1050, 820, 760, 740]) {
      await resizeApp(width, 720);
      const tabLayout = await browser.execute(() => {
        const bar = document.querySelector(".workspace-tab-bar");
        const viewport = document.querySelector(".workspace-tab-bar__viewport");
        if (!(bar instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
          throw new Error("tab chrome is not available");
        }
        return {
          rootOverflow: document.documentElement.scrollWidth > window.innerWidth,
          barVisible: bar.getBoundingClientRect().height > 0,
          viewportOwnsOverflow: getComputedStyle(viewport).overflowX === "auto",
        };
      });
      assert.equal(tabLayout.rootOverflow, false);
      assert.equal(tabLayout.barVisible, true);
      assert.equal(tabLayout.viewportOwnsOverflow, true);
    }
    await resizeApp(1100, 720);
    const baseline = await runtimeMemorySnapshot();

    const paths = ["note.md", ...extraPaths];
    for (let round = 0; round < 12; round += 1) {
      for (const relativePath of paths) {
        await tabList
          .$(`button[role="tab"][title^="${relativePath} ·"]`)
          .click();
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () =>
                document.querySelectorAll(
                  ".ProseMirror, .cm-editor",
                ).length,
            )) === 1,
          {
            timeout: 10_000,
            timeoutMsg: "tab switch mounted more than one editor adapter",
          },
        );
      }
    }

    const after = await runtimeMemorySnapshot();
    const rssDelta = after.rssBytes - baseline.rssBytes;
    const heapDelta =
      baseline.heapBytes !== null && after.heapBytes !== null
        ? after.heapBytes - baseline.heapBytes
        : null;
    console.log(
      "T37 tab runtime memory",
      JSON.stringify({ baseline, after, rssDelta, heapDelta }),
    );
    assert.ok(
      rssDelta <= 128 * 1024 * 1024,
      `tab runtime RSS grew beyond 128 MiB: ${JSON.stringify({ baseline, after, rssDelta })}`,
    );
    if (heapDelta !== null) {
      assert.ok(
        heapDelta <= 64 * 1024 * 1024,
        `tab runtime JS heap grew beyond 64 MiB: ${JSON.stringify({ baseline, after, heapDelta })}`,
      );
    }
    await tabList.$('button[role="tab"][title^="note.md ·"]').click();
    await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();

    await tabList.$('button[role="tab"][title^="tab-three.md ·"]').click();
    await $('button[aria-label="关闭 tab-three.md"]').click();
    await browser.waitUntil(
      async () => (await tabList.$$('[role="tab"]').length) === 2,
      {
        timeout: 10_000,
        timeoutMsg: "closing a clean tab did not update the visible tab list",
      },
    );
    await overflowTrigger.click();
    const recentMenu = await $(
      '[role="menu"][aria-label="所有页签与最近关闭"]',
    );
    await recentMenu.waitForDisplayed();
    await recentMenu
      .$('[role="menuitem"]')
      .waitForDisplayed();
    await recentMenu
      .$('button*=重新打开 tab-three.md')
      .click();
    await browser.waitUntil(
      async () =>
        (await tabList.$$('[role="tab"]').length) === 3 &&
        (await tabList
          .$('[role="tab"][aria-selected="true"] strong')
          .getText()) === "tab-three.md",
      {
        timeout: 10_000,
        timeoutMsg: "recently closed tab did not revalidate and reopen",
      },
    );
    await browser.pause(400);
    const persistedTabs = await invoke("get_workspace_tab_session", {
      workspaceId,
      windowStateRef: null,
    });
    assert.deepEqual(
      persistedTabs.tabs.map((tab) => tab.path.relativePath),
      ["note.md", "tab-two.md", "tab-three.md"],
    );
    assert.equal(persistedTabs.recentlyClosed.length, 0);
    await tabList.$('button[role="tab"][title^="note.md ·"]').click();
    await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();
  });

  it("settles tab batches before real rename, move and delete mutations", async () => {
    const tabList = await $('[role="tablist"][aria-label="打开的文档"]');
    const noteTab = await tabList.$('button[role="tab"][title^="note.md ·"]');
    await noteTab.click();
    await browser.execute((element) => {
      element.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 140,
          clientY: 80,
        }),
      );
    }, noteTab);
    const contextMenu = await $('[role="menu"][aria-label="note.md 页签操作"]');
    await contextMenu.waitForDisplayed();
    await contextMenu.$("button*=关闭右侧页签").click();
    await browser.waitUntil(
      async () => (await tabList.$$('[role="tab"]').length) === 1,
      {
        timeout: 10_000,
        timeoutMsg: "batch close did not settle and remove the right-side tabs",
      },
    );

    const renameSource = "t40-rename.md";
    const renameTarget = "t40-renamed.md";
    const moveSource = "t40-move.md";
    const moveTargetDirectory = "t40-target";
    const moveTarget = `${moveTargetDirectory}/${moveSource}`;
    const deletePath = "t40-delete.md";
    const imagePath = join(fixture.root, "assets", "t40-move.png");
    await mkdir(join(fixture.root, "assets"), { recursive: true });
    await mkdir(join(fixture.root, moveTargetDirectory), { recursive: true });
    await writeFile(join(fixture.root, renameSource), "# Rename through T40\n");
    await writeFile(
      join(fixture.root, moveSource),
      "# Move through T40\n\n![asset](assets/t40-move.png)\n",
    );
    await writeFile(join(fixture.root, deletePath), "# Delete through T40\n");
    await writeFile(imagePath, new Uint8Array(PNG_BYTES));

    try {
      await $('[title="刷新文件树"]').click();

      const renameEntry = await $(
        `[role="treeitem"][data-tree-path="${renameSource}"]`,
      );
      await renameEntry.waitForDisplayed({ timeout: 10_000 });
      await renameEntry.click();
      await $('button=重命名').click();
      const renameDialog = await $("dialog[open]");
      await renameDialog.$('input[aria-label="新名称"], input').setValue(renameTarget);
      await renameDialog.$("button=提交到磁盘").click();
      await browser.waitUntil(
        async () =>
          (await tabList
            .$(`button[role="tab"][title^="${renameTarget} ·"]`)
            .isExisting()) &&
          (await readFile(join(fixture.root, renameTarget), "utf8")).includes(
            "Rename through T40",
          ),
        {
          timeout: 10_000,
          timeoutMsg: "real rename did not remap the open tab after disk success",
        },
      );
      await assert.rejects(readFile(join(fixture.root, renameSource), "utf8"));

      const moveEntry = await $(
        `[role="treeitem"][data-tree-path="${moveSource}"]`,
      );
      await moveEntry.waitForDisplayed({ timeout: 10_000 });
      await moveEntry.click();
      await $('button=移动').click();
      const moveDialog = await $("dialog[open]");
      await moveDialog
        .$('input[aria-label="目标文件夹（留空表示根目录）"], input')
        .setValue(moveTargetDirectory);
      assert.equal(
        await moveDialog
          .$("input[type=checkbox]")
          .isSelected(),
        true,
        "the real move must offer image-link adjustment for the open document",
      );
      await moveDialog.$("button=提交到磁盘").click();
      await browser.waitUntil(
        async () => {
          try {
            await readFile(join(fixture.root, moveTarget), "utf8");
            return true;
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          timeoutMsg: "real move did not commit the target file on disk",
        },
      );
      await tabList
        .$(`button[role="tab"][title^="${moveTarget} ·"]`)
        .waitForExist({
          timeout: 10_000,
          timeoutMsg: "real move did not remap the open tab after disk success",
        });
      await browser.waitUntil(
        async () =>
          (
            await readFile(join(fixture.root, moveTarget), "utf8")
          ).includes("![asset](../assets/t40-move.png)"),
        {
          timeout: 10_000,
          timeoutMsg:
            "real move remapped the tab but did not save the adjusted image link",
        },
      );
      await assert.rejects(readFile(join(fixture.root, moveSource), "utf8"));

      const deleteEntry = await $(
        `[role="treeitem"][data-tree-path="${deletePath}"]`,
      );
      await deleteEntry.waitForDisplayed({ timeout: 10_000 });
      await deleteEntry.click();
      await $('button=删除').click();
      const trashDialog = await $("dialog[open]");
      await trashDialog.$("button=移到废纸篓").click();
      await browser.waitUntil(
        async () => {
          const deleteTab = await tabList.$(
            `button[role="tab"][title^="${deletePath} ·"]`,
          );
          const permanent = await $("button=永久删除");
          return !(await deleteTab.isExisting()) ||
            (await permanent.isDisplayed().catch(() => false));
        },
        {
          timeout: 10_000,
          timeoutMsg: "real trash flow neither closed the tab nor offered fallback",
        },
      );
      const permanent = await $("button=永久删除");
      if (await permanent.isDisplayed().catch(() => false)) {
        await permanent.click();
      }
      await browser.waitUntil(
        async () =>
          !(await tabList
            .$(`button[role="tab"][title^="${deletePath} ·"]`)
            .isExisting()),
        {
          timeout: 10_000,
          timeoutMsg: "delete success did not atomically close the open tab",
        },
      );
      await assert.rejects(readFile(join(fixture.root, deletePath), "utf8"));
    } finally {
      await rm(join(fixture.root, renameSource), { force: true });
      await rm(join(fixture.root, renameTarget), { force: true });
      await rm(join(fixture.root, moveSource), { force: true });
      await rm(join(fixture.root, moveTargetDirectory), {
        recursive: true,
        force: true,
      });
      await rm(join(fixture.root, deletePath), { force: true });
      await rm(imagePath, { force: true });
      const note = await tabList.$('button[role="tab"][title^="note.md ·"]');
      if (await note.isExisting()) await note.click();
    }
  });

  it("requires an explicit warning confirmation before moving a directory with images", async () => {
    const warningImage = join(fixture.root, "guides", "move-warning.png");
    await writeFile(warningImage, new Uint8Array(PNG_BYTES));
    try {
      const risk = await invoke("inspect_workspace_move_risk", {
        workspaceId,
        relativePath: "guides",
      });
      assert.equal(risk.containsSupportedImages, true);
      assert.equal(risk.mayBreakImageLinks, true);

      const guideEntry = await $('[role="treeitem"][data-tree-path="guides"]');
      await guideEntry.waitForDisplayed();
      await guideEntry.click();
      await $('button=移动').click();
      const operationDialog = await $("dialog[open]");
      await operationDialog.waitForDisplayed();
      await operationDialog.$("button=提交到磁盘").click();

      const warning = await $("#workbench-operation-description");
      await browser.waitUntil(
        async () =>
          (await warning.getText()).includes(
            "未打开 Markdown 文档中的相对图片链接可能失效",
          ),
        {
          timeout: 10_000,
          timeoutMsg: "directory move risk warning did not replace the move description",
        },
      );
      assert.equal(
        await operationDialog
          .$("button=继续移动（链接可能失效）")
          .isDisplayed(),
        true,
      );
      await operationDialog
        .$(".app-dialog__actions button:first-child")
        .click();
      await browser.waitUntil(async () => !(await $("dialog[open]").isExisting()), {
        timeoutMsg: "cancelling the move warning did not close the operation dialog",
      });
      assert.equal(
        await invoke("read_markdown_file", {
          workspaceId,
          relativePath: "guides/inside.md",
        }).then((result) => result.status),
        "ready",
        "cancelling the warning must not move the directory",
      );
    } finally {
      const openDialog = await $("dialog[open]");
      if (await openDialog.isExisting().catch(() => false)) {
        await openDialog
          .$(".app-dialog__actions button:first-child")
          .click()
          .catch(() => undefined);
      }
      await rm(warningImage, { force: true });
    }
  });

  it("edits in both modes, imports an image, saves, and reopens the real file", async () => {
    await appendEditorText(
      '[aria-label="Markdown 排版编辑区"]',
      ` ${VISUAL_MARKER}`,
    );
    await browser.waitUntil(
      async () => (await $('[aria-label^="保存状态："]').getText()) === "未保存",
      { timeoutMsg: "visual edit did not enter the dirty document state" },
    );

    await switchToSource();
    assert.equal(
      (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
        VISUAL_EVIDENCE,
      ),
      true,
      "visual edit was not projected into source mode",
    );
    await appendEditorText(
      '[aria-label="Markdown 源码编辑区"]',
      `\n\n${SOURCE_MARKER}`,
    );
    await browser.waitUntil(
      async () =>
        (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
          SOURCE_EVIDENCE,
        ),
      { timeoutMsg: "source edit did not reach the visible editor value" },
    );
    // WebKit may resolve addValue before its last input event has crossed the React adapter.
    // Capture the committed source only after the event queue has settled, then require the
    // asset insertion to preserve it byte-for-byte.
    await browser.pause(100);
    const sourceBeforeImage = await editorText(
      '[aria-label="Markdown 源码编辑区"]',
    );
    assert.equal(sourceBeforeImage.includes(VISUAL_EVIDENCE), true);
    assert.equal(sourceBeforeImage.includes(SOURCE_EVIDENCE), true);

    const dropResult = await browser.executeAsync((bytes, done) => {
      const surface = document.querySelector(".document-editor-shell__surface");
      if (!(surface instanceof HTMLElement) || typeof DataTransfer !== "function") {
        done("missing-drop-api");
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "t31-image.png", {
          type: "image/png",
        }),
      );
      surface.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      done("dispatched");
    }, PNG_BYTES);
    assert.equal(dropResult, "dispatched");
    await browser.waitUntil(
      async () =>
        (await $(".document-editor-shell__notice").getText()).includes(
          "已插入 1 张图片",
        ),
      { timeout: 10_000, timeoutMsg: "image drop did not complete through IPC" },
    );

    const sourceWithImage = await editorText(
      '[aria-label="Markdown 源码编辑区"]',
    );
    assert.equal(sourceWithImage.includes(sourceBeforeImage), true);
    assert.match(sourceWithImage, /!\[t31-image]\(assets\/t31-image\.png\)/);
    assert.deepEqual(await readdir(join(fixture.root, "assets")), [
      "t31-image.png",
    ]);

    await $('[aria-label="保存当前文档"]').click();
    await browser.waitUntil(
      async () => {
        const content = await readFile(join(fixture.root, "note.md"), "utf8");
        return (
          normalizeLineEndings(content).includes(
            normalizeLineEndings(sourceBeforeImage),
          ) &&
          /!\[t31-image]\(assets\/t31-image\.png\)/.test(content)
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: "manual save did not commit the complete editor state",
      },
    );
    await browser.waitUntil(
      async () => (await $('[aria-label^="保存状态："]').getText()) === "已保存",
      { timeout: 10_000, timeoutMsg: "manual save did not reach the saved state" },
    );
    const persisted = await readFile(join(fixture.root, "note.md"), "utf8");
    assert.equal(
      normalizeLineEndings(persisted).includes(
        normalizeLineEndings(sourceBeforeImage),
      ),
      true,
    );
    assert.match(persisted, /!\[t31-image]\(assets\/t31-image\.png\)/);

    await browser.refresh();
    await openFixtureDocument();
    await switchToSource();
    const reopened = await editorText('[aria-label="Markdown 源码编辑区"]');
    assert.equal(reopened.includes(sourceBeforeImage), true);
    assert.match(reopened, /!\[t31-image]\(assets\/t31-image\.png\)/);
  });

  it("persists and removes a recovery snapshot through the real Rust repository", async () => {
    const recoveryPath = "guides/inside.md";
    const disk = await invoke("read_markdown_file", {
      workspaceId,
      relativePath: recoveryPath,
    });
    assert.equal(disk.status, "ready");
    await invoke("register_active_recovery_session", {
      workspaceId,
      relativePath: recoveryPath,
    });
    const result = await invoke("upsert_recovery_snapshot", {
      workspaceId,
      relativePath: recoveryPath,
      content: `${disk.content}\n\nT31-recovery-probe`,
      baseRevision: disk.revision,
    });
    assert.equal(result.status, "persisted");
    assert.equal(result.snapshot.workspaceId, workspaceId);
    assert.equal(result.snapshot.relativePath, recoveryPath);
    await invoke("release_active_recovery_session", {
      workspaceId,
      relativePath: recoveryPath,
    });
    assert.equal(
      await invoke("delete_recovery_snapshot", {
        snapshotId: result.snapshot.snapshotId,
        workspaceId,
      }),
      true,
    );
  });

  it("keeps local edits safe when the disk changes and persists recovery evidence", async () => {
    await appendEditorText(
      '[aria-label="Markdown 源码编辑区"]',
      `\n\n${LOCAL_CONFLICT_MARKER}`,
    );
    const diskBeforeConflict = await readFile(join(fixture.root, "note.md"), "utf8");
    const diskLineEnding = lineEndingFromMarkdown(diskBeforeConflict);
    await writeFile(
      join(fixture.root, "note.md"),
      `${diskBeforeConflict}${diskLineEnding}${diskLineEnding}${EXTERNAL_MARKER}${diskLineEnding}`,
      "utf8",
    );
    await $('[aria-label="保存当前文档"]').click();
    const conflictButton = await $('[aria-label="处理磁盘冲突"]');
    await conflictButton.waitForDisplayed({ timeout: 10_000 });
    assert.equal(await $('[aria-label^="保存状态："]').getText(), "存在磁盘冲突");
    assert.equal(
      (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
        LOCAL_CONFLICT_MARKER,
      ),
      true,
    );

    await conflictButton.click();
    const dialog = await $("#conflict-title");
    await dialog.waitForDisplayed();
    assert.equal(await dialog.getText(), "磁盘内容已在 Plainroot 之外变化");
    await $('button=保持当前内容').click();
    await browser.waitUntil(
      async () =>
        (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
          LOCAL_CONFLICT_MARKER,
        ),
      { timeoutMsg: "closing the conflict dialog discarded the local content" },
    );
    assert.equal(
      (await readFile(join(fixture.root, "note.md"), "utf8")).includes(
        EXTERNAL_MARKER,
      ),
      true,
    );
    assert.equal(
      (await readFile(join(fixture.root, "note.md"), "utf8")).includes(
        LOCAL_CONFLICT_MARKER,
      ),
      false,
    );
    await browser.waitUntil(
      async () => {
        const snapshots = await invoke("list_recovery_snapshots");
        return snapshots.some(
          (snapshot) =>
            snapshot.workspaceId === workspaceId &&
            snapshot.relativePath === "note.md",
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: "conflicted local content did not produce a recovery snapshot",
      },
    );
  });

  it("loads a persisted recovery snapshot without overwriting the source file first", async () => {
    await browser.refresh();
    const recoveryButton = await $('button*=恢复内容');
    await recoveryButton.waitForDisplayed();
    await recoveryButton.click();
    const recoveryTitle = await $("#recovery-title");
    await recoveryTitle.waitForDisplayed();
    assert.equal(await recoveryTitle.getText(), "检查尚未写入原文件的内容");
    const diskBeforeRestore = await readFile(
      join(fixture.root, "note.md"),
      "utf8",
    );
    await $('button=恢复到编辑区').click();
    await browser.waitUntil(
      async () =>
        (await $(".workbench__status-activity").getText()).includes(
          "恢复副本已载入为未保存内容",
      ),
      { timeout: 10_000, timeoutMsg: "recovery snapshot was not loaded into the editor" },
    );
    assert.equal(
      await readFile(join(fixture.root, "note.md"), "utf8"),
      diskBeforeRestore,
      "loading recovery must not write the source Markdown before the normal autosave debounce",
    );
    await switchToSource();
    assert.equal(
      (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
        LOCAL_CONFLICT_MARKER,
      ),
      true,
    );
  });

  it("keeps the current workspace when a real replacement settlement is rejected", async () => {
    const replacementFixture = await createWorkspaceFixture();
    try {
      const selection = await invoke("prepare_e2e_workspace", {
        root: replacementFixture.root,
      });
      assert.equal(selection.status, "ready");
      const replacementWorkspace = await invoke(
        "authorize_workspace_selection",
        {
          selectionId: selection.proposal.selectionId,
          confirmed: true,
        },
      );
      await appendEditorText(
        '[aria-label="Markdown 源码编辑区"]',
        `\n\n${WINDOW_INTENT_DIRTY_MARKER}`,
      );
      await browser.waitUntil(
        async () =>
          (await $('[aria-label^="保存状态："]').getText()) === "未保存",
        {
          timeout: 500,
          timeoutMsg:
            "the editor did not expose a dirty state before the replacement intent",
        },
      );
      const externalBaseline = await readFile(
        join(fixture.root, "note.md"),
        "utf8",
      );
      const externalLineEnding = lineEndingFromMarkdown(externalBaseline);
      await writeFile(
        join(fixture.root, "note.md"),
        `${externalBaseline}${externalLineEnding}${externalLineEnding}${WINDOW_INTENT_EXTERNAL_MARKER}${externalLineEnding}`,
        "utf8",
      );
      const replacement = await invoke("coordinate_workspace_open", {
        workspaceId: replacementWorkspace.id,
        disposition: "current_window",
      });
      assert.equal(replacement.status, "settlement_required");

      const replaceButton = await $("button=安全替换当前窗口");
      await replaceButton.waitForDisplayed({ timeout: 10_000 });
      const cancellation = await invoke("resolve_window_settlement", {
        intentId: replacement.intentId,
        allow: false,
      });
      assert.equal(cancellation.status, "cancelled");
      const retained = await invoke("get_workspace_workbench_snapshot");
      assert.equal(retained.workspace.id, workspaceId);
      assert.equal(
        (await editorText('[aria-label="Markdown 源码编辑区"]')).includes(
          WINDOW_INTENT_DIRTY_MARKER,
        ),
        true,
        "cancelling replacement must preserve the active in-memory content",
      );
    } finally {
      await replacementFixture.cleanup();
    }
  });
});
