import assert from "node:assert/strict";
import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createWorkspaceFixture } from "../../support/workspace-fixture.mjs";

const VISUAL_MARKER = "T31-visual-edit";
const SOURCE_MARKER = "T31-source-edit";
const VISUAL_EVIDENCE = "T31-visual-";
const SOURCE_EVIDENCE = "T31-source-";
const EXTERNAL_MARKER = "T31-external-conflict";
const LOCAL_CONFLICT_MARKER = "T31-local-conflict";
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
});
