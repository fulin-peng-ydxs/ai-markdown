import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = process.env.PLAINROOT_E2E_WORKSPACE_ROOT;
const workspaceName = workspaceRoot ? basename(workspaceRoot) : "";

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

async function sendNativeTabShortcut(direction) {
  if (process.platform === "darwin") {
    const keyCode = direction === "next" ? 124 : 123;
    const menuItemTitle = direction === "next" ? "下一个页签" : "上一个页签";
    await execFileAsync("osascript", [
      "-e",
      `on run argv
        set expectedTitle to item 1 of argv
        set expectedMenuItem to item 2 of argv
        tell application "System Events"
          repeat with candidate in (application processes whose name is "plainroot")
            repeat with candidateWindow in windows of candidate
              if name of candidateWindow contains expectedTitle then
                set frontmost of candidate to true
                perform action "AXRaise" of candidateWindow
                repeat 50 times
                  if frontmost of candidate then
                    try
                      set targetItem to menu item expectedMenuItem of menu "页签" of menu bar item "页签" of menu bar 1 of candidate
                      if enabled of targetItem then exit repeat
                    end try
                  end if
                  delay 0.1
                end repeat
                if not frontmost of candidate then error "Plainroot shortcut fixture process did not become frontmost"
                set targetItem to menu item expectedMenuItem of menu "页签" of menu bar item "页签" of menu bar 1 of candidate
                if not enabled of targetItem then error "Plainroot shortcut menu item did not become enabled"
                key code ${keyCode} using {command down, option down}
                return
              end if
            end repeat
          end repeat
        end tell
        error "Plainroot shortcut fixture window was not found"
      end run`,
      workspaceName,
      menuItemTitle,
    ]);
    return;
  }

  if (process.platform === "win32") {
    const keys = direction === "next" ? "^{TAB}" : "^+{TAB}";
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PlainrootNativeInput {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$expectedTitle = [IO.Path]::GetFileName($env:PLAINROOT_E2E_WORKSPACE_ROOT)
$process = Get-Process plainroot | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$expectedTitle*"
} | Select-Object -First 1
if ($null -eq $process) { throw "Plainroot native window was not found" }
if (-not [PlainrootNativeInput]::SetForegroundWindow($process.MainWindowHandle)) {
  throw "Plainroot native window could not be focused"
}
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("${keys}")
`;
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return;
  }

  throw new Error(`native tab shortcut is not supported on ${process.platform}`);
}

describe("Plainroot native tab shortcuts", () => {
  it("routes platform-native next and previous accelerators to the focused window", async () => {
    assert.ok(workspaceRoot, "shortcut fixture root is required");
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

    for (const relativePath of ["note.md", "tab-two.md", "tab-three.md"]) {
      const entry = await $(
        `[role="treeitem"][data-tree-path="${relativePath}"]`,
      );
      await entry.waitForDisplayed({ timeout: 10_000 });
      await entry.click();
      await $('[aria-label="Markdown 排版编辑区"]').waitForDisplayed();
    }
    const tabList = await $('[role="tablist"][aria-label="打开的文档"]');
    await tabList
      .$('button[role="tab"][title^="note.md ·"]')
      .click();
    await browser.waitUntil(
      async () =>
        (await tabList
          .$('[role="tab"][aria-selected="true"] strong')
          .getText()) === "note.md",
      { timeout: 10_000 },
    );

    // This is one focus-settlement boundary, not a retry. Each host OS key event
    // below must succeed on its first attempt.
    await browser.pause(1_000);
    await sendNativeTabShortcut("next");
    await browser.waitUntil(
      async () =>
        (await tabList
          .$('[role="tab"][aria-selected="true"] strong')
          .getText()) === "tab-two.md",
      {
        timeout: 10_000,
        timeoutMsg:
          "the platform-native next-tab accelerator did not activate the next tab",
      },
    );
    await browser.pause(500);
    await sendNativeTabShortcut("previous");
    await browser.waitUntil(
      async () =>
        (await tabList
          .$('[role="tab"][aria-selected="true"] strong')
          .getText()) === "note.md",
      {
        timeout: 10_000,
        timeoutMsg:
          "the platform-native previous-tab accelerator did not activate the previous tab",
      },
    );
  });
});
