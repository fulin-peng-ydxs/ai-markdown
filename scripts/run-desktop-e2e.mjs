import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const dataDirectory = await mkdtemp(join(tmpdir(), "plainroot-wdio-data-"));
const wdioEntry = resolve("node_modules", "@wdio", "cli", "bin", "wdio.js");
const child = spawn(
  process.execPath,
  [wdioEntry, "run", "tests/e2e/wdio.conf.mjs"],
  {
    env: { ...process.env, PLAINROOT_E2E_DATA_DIR: dataDirectory },
    stdio: "inherit",
  },
);

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);

let exitCode = 1;
try {
  const [code] = await once(child, "exit");
  exitCode = code ?? 1;
} finally {
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  await rm(dataDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;
