import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const appBinary = resolve(
  "src-tauri/target/release",
  process.platform === "win32" ? "plainroot.exe" : "plainroot",
);
const selectedSpec =
  process.env.PLAINROOT_E2E_SPEC ??
  "tests/e2e/specs/desktop-shell.e2e.mjs";

export const config = {
  runner: "local",
  specs: [resolve(selectedSpec)],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: appBinary,
        driverProvider: "embedded",
        windowLabel: "plainroot-window-1",
        startTimeout: 60_000,
        statusPollTimeout: 5_000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
    // Keep test assertions deterministic. Driver connection startup retains its one retry,
    // but a product-flow failure must not mutate the fixture and then pass on a second attempt.
    retries: 0,
  },
  afterTest: async (test, _context, { error }) => {
    if (!error) return;
    const outputDirectory = resolve("artifacts/e2e");
    mkdirSync(outputDirectory, { recursive: true });
    const safeTitle = test.title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    await browser.saveScreenshot(resolve(outputDirectory, `${safeTitle}.png`));
  },
};
