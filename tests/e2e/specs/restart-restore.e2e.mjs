import assert from "node:assert/strict";

describe("Plainroot restart restore", () => {
  it("restores usable tabs and isolates a file removed between processes", async () => {
    const launcher = await $('main[aria-label="Plainroot 启动页"]');
    await launcher.waitForDisplayed();
    const restoreTitle = await $("#restore-title");
    await restoreTitle.waitForDisplayed({ timeout: 10_000 });
    assert.equal(await restoreTitle.getText(), "恢复工作区窗口");
    await $("button=恢复可用窗口").click();

    const workbench = await $('main[aria-label="Plainroot Markdown 工作台"]');
    await workbench.waitForDisplayed({ timeout: 10_000 });
    const tabList = await $('[role="tablist"][aria-label="打开的文档"]');
    await tabList.waitForDisplayed();
    assert.equal(
      await tabList.$$('[role="tab"]').length,
      2,
      "the two readable tabs must survive while the missing tab is isolated",
    );
    const issueTitle = await $("h2=有 1 个页签未恢复");
    await issueTitle.waitForDisplayed({ timeout: 10_000 });
    assert.equal(
      (await $(".workbench__document-warning").getText()).includes(
        "restart-missing.md",
      ),
      true,
      "the removed file must be isolated as a visible restore issue",
    );
    assert.notEqual(
      await tabList.$('[role="tab"][aria-selected="true"] strong').getText(),
      "restart-missing.md",
      "a missing preferred tab must fall back to a readable tab",
    );
    await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();

    await tabList
      .$('button[role="tab"][title^="restart-ready.md ·"]')
      .click();
    await browser.waitUntil(
      async () =>
        (
          await $('[aria-label="Markdown 排版编辑区"]').getText()
        ).includes("Restart ready"),
      {
        timeout: 10_000,
        timeoutMsg: "a readable restored tab did not load lazily after activation",
      },
    );
  });
});
