import { resolve } from "node:path";

const appBinary = resolve("src-tauri/target/release/plainroot");

export const config = {
  runner: "local",
  specs: [resolve("tests/e2e/specs/**/*.e2e.mjs")],
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
  },
};
