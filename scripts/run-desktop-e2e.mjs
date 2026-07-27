import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { createWorkspaceFixture } from "../tests/support/workspace-fixture.mjs";

const shellDataDirectory = await mkdtemp(join(tmpdir(), "plainroot-wdio-shell-"));
const restartDataDirectory = await mkdtemp(
  join(tmpdir(), "plainroot-wdio-restart-"),
);
const shortcutDataDirectory = await mkdtemp(
  join(tmpdir(), "plainroot-wdio-shortcuts-"),
);
const restartFixture = await createWorkspaceFixture();
const shortcutFixture = await createWorkspaceFixture();
const wdioEntry = resolve("node_modules", "@wdio", "cli", "bin", "wdio.js");
let child = null;

const forwardSignal = (signal) => {
  if (child && !child.killed) child.kill(signal);
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);

async function runDesktopSpec(spec, dataDirectory, extraEnvironment = {}) {
  child = spawn(
    process.execPath,
    [wdioEntry, "run", "tests/e2e/wdio.conf.mjs"],
    {
      env: {
        ...process.env,
        ...(process.platform === "win32"
          ? { PLAINROOT_E2E_FIXED_WINDOW_TITLE: "1" }
          : {}),
        ...extraEnvironment,
        PLAINROOT_E2E_DATA_DIR: dataDirectory,
        PLAINROOT_E2E_SPEC: spec,
      },
      stdio: "inherit",
    },
  );
  const [code] = await once(child, "exit");
  child = null;
  return code ?? 1;
}

let exitCode = 1;
try {
  await writeFile(
    join(restartFixture.root, "restart-ready.md"),
    "# Restart ready\n\nThis tab must survive a real process restart.\n",
    "utf8",
  );
  await writeFile(
    join(restartFixture.root, "restart-missing.md"),
    "# Restart missing\n\nThis tab is removed between desktop processes.\n",
    "utf8",
  );
  for (const relativePath of ["tab-two.md", "tab-three.md"]) {
    await writeFile(
      join(shortcutFixture.root, relativePath),
      `# ${relativePath}\n\nNative tab shortcut fixture.\n`,
      "utf8",
    );
  }
  exitCode = await runDesktopSpec(
    "tests/e2e/specs/desktop-shell.e2e.mjs",
    shellDataDirectory,
  );
  if (exitCode === 0) {
    exitCode = await runDesktopSpec(
      "tests/e2e/specs/native-tab-shortcuts.e2e.mjs",
      shortcutDataDirectory,
      {
        PLAINROOT_E2E_WORKSPACE_ROOT: shortcutFixture.root,
      },
    );
  }
  if (exitCode === 0) {
    exitCode = await runDesktopSpec(
      "tests/e2e/specs/restart-seed.e2e.mjs",
      restartDataDirectory,
      { PLAINROOT_E2E_WORKSPACE_ROOT: restartFixture.root },
    );
  }
  if (exitCode === 0) {
    await rm(join(restartFixture.root, "restart-missing.md"), { force: true });
    exitCode = await runDesktopSpec(
      "tests/e2e/specs/restart-restore.e2e.mjs",
      restartDataDirectory,
      { PLAINROOT_E2E_WORKSPACE_ROOT: restartFixture.root },
    );
  }
} finally {
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  await restartFixture.cleanup();
  await shortcutFixture.cleanup();
  await rm(shellDataDirectory, { recursive: true, force: true });
  await rm(restartDataDirectory, { recursive: true, force: true });
  await rm(shortcutDataDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;
