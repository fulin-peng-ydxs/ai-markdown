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

async function focusNativeTabShortcutWindow() {
  if (process.platform === "darwin") {
    await execFileAsync("osascript", [
      "-e",
      `on run argv
        set expectedTitle to item 1 of argv
        repeat 50 times
          tell application "System Events"
            repeat with candidate in (application processes whose background only is false)
              repeat with candidateWindow in windows of candidate
                if name of candidateWindow contains expectedTitle then
                  set frontmost of candidate to true
                  perform action "AXRaise" of candidateWindow
                  return
                end if
              end repeat
            end repeat
          end tell
          delay 0.1
        end repeat
        error "Plainroot shortcut fixture window was not found"
      end run`,
      workspaceName,
    ]);
    return;
  }

  if (process.platform === "win32") {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PlainrootNativeFocus {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

$expectedTitle = [IO.Path]::GetFileName($env:PLAINROOT_E2E_WORKSPACE_ROOT)
$process = $null
$discoveryDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $process = Get-Process plainroot -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$expectedTitle*"
  } | Select-Object -First 1
  if ($null -eq $process) { Start-Sleep -Milliseconds 100 }
} while ($null -eq $process -and [DateTime]::UtcNow -lt $discoveryDeadline)
if ($null -eq $process) { throw "Plainroot native window was not found" }

$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  if ([PlainrootNativeFocus]::GetForegroundWindow() -ne $process.MainWindowHandle) {
    [void][PlainrootNativeFocus]::SetForegroundWindow($process.MainWindowHandle)
  }
  if ([PlainrootNativeFocus]::GetForegroundWindow() -eq $process.MainWindowHandle) {
    exit 0
  }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw "Plainroot shortcut window did not become foreground"
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

async function sendNativeTabShortcut(direction) {
  if (process.platform === "darwin") {
    const keyCode = direction === "next" ? 124 : 123;
    const menuItemTitle = direction === "next" ? "下一个页签" : "上一个页签";
    await execFileAsync("osascript", [
      "-e",
      `on run argv
        set expectedTitle to item 1 of argv
        set expectedMenuItem to item 2 of argv
        set targetFound to false
        repeat 50 times
          tell application "System Events"
            repeat with candidate in (application processes whose background only is false)
              repeat with candidateWindow in windows of candidate
                if name of candidateWindow contains expectedTitle then
                  set frontmost of candidate to true
                  perform action "AXRaise" of candidateWindow
                  set targetFound to true
                  exit repeat
                end if
              end repeat
              if targetFound then exit repeat
            end repeat
          end tell
          if targetFound then exit repeat
          delay 0.1
        end repeat
        if not targetFound then error "Plainroot shortcut fixture window was not found"
        tell application "System Events"
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
        end tell
      end run`,
      workspaceName,
      menuItemTitle,
    ]);
    return;
  }

  if (process.platform === "win32") {
    const virtualKey = direction === "next" ? "0x22" : "0x21";
    const script = `
Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PlainrootNativeInput {
  private const uint INPUT_KEYBOARD = 1;
  private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const ushort VK_CONTROL = 0x11;

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(
    uint inputCount,
    INPUT[] inputs,
    int inputSize
  );

  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT {
    public uint type;
    public INPUTUNION data;
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct INPUTUNION {
    [FieldOffset(0)]
    public KEYBDINPUT keyboard;

    // Keep the native INPUT union at its Win32 size on both x86 and x64.
    [FieldOffset(0)]
    public MOUSEINPUT mouse;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT {
    public int x;
    public int y;
    public uint mouseData;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  private static INPUT Key(ushort virtualKey, uint flags) {
    return new INPUT {
      type = INPUT_KEYBOARD,
      data = new INPUTUNION {
        keyboard = new KEYBDINPUT {
          virtualKey = virtualKey,
          flags = flags
        }
      }
    };
  }

  public static void SendCtrlPage(ushort pageVirtualKey) {
    INPUT[] inputs = {
      Key(VK_CONTROL, 0),
      Key(pageVirtualKey, KEYEVENTF_EXTENDEDKEY),
      Key(pageVirtualKey, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
      Key(VK_CONTROL, KEYEVENTF_KEYUP)
    };
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != (uint)inputs.Length) {
      throw new Win32Exception(
        Marshal.GetLastWin32Error(),
        "Plainroot native shortcut input was only partially delivered"
      );
    }
  }
}
"@

$expectedTitle = [IO.Path]::GetFileName($env:PLAINROOT_E2E_WORKSPACE_ROOT)
$process = $null
$discoveryDeadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $process = Get-Process plainroot -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$expectedTitle*"
  } | Select-Object -First 1
  if ($null -eq $process) { Start-Sleep -Milliseconds 100 }
} while ($null -eq $process -and [DateTime]::UtcNow -lt $discoveryDeadline)
if ($null -eq $process) { throw "Plainroot native window was not found" }

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  if ([PlainrootNativeInput]::GetForegroundWindow() -ne $process.MainWindowHandle) {
    [void][PlainrootNativeInput]::SetForegroundWindow($process.MainWindowHandle)
  }
  if ([PlainrootNativeInput]::GetForegroundWindow() -eq $process.MainWindowHandle) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $ready) {
  throw "Plainroot shortcut window did not become foreground"
}
[PlainrootNativeInput]::SendCtrlPage(${virtualKey})
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

async function waitForNativeTabShortcutReadiness() {
  await browser.waitUntil(
    async () => invoke("e2e_tab_shortcuts_ready"),
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg:
        "the native next/previous tab menu items did not become enabled",
    },
  );
}

async function activeTabName() {
  return browser.execute(() => {
    const activeTab = document.querySelector(
      '[role="tablist"][aria-label="打开的文档"] [role="tab"][aria-selected="true"] strong',
    );
    return activeTab?.textContent?.trim() ?? null;
  });
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
      async () => (await activeTabName()) === "note.md",
      { timeout: 10_000 },
    );

    // Menu readiness and native foreground focus are observable preconditions.
    // Each host OS key event below must still succeed on its first attempt.
    await focusNativeTabShortcutWindow();
    await waitForNativeTabShortcutReadiness();
    await sendNativeTabShortcut("next");
    await browser.waitUntil(
      async () => (await activeTabName()) === "tab-two.md",
      {
        timeout: 10_000,
        timeoutMsg:
          "the platform-native next-tab accelerator did not activate the next tab",
      },
    );
    await focusNativeTabShortcutWindow();
    await waitForNativeTabShortcutReadiness();
    await sendNativeTabShortcut("previous");
    await browser.waitUntil(
      async () => (await activeTabName()) === "note.md",
      {
        timeout: 10_000,
        timeoutMsg:
          "the platform-native previous-tab accelerator did not activate the previous tab",
      },
    );
  });
});
