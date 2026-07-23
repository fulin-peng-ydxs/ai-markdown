import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
    // Editor suites mount real Milkdown/CodeMirror instances, including a
    // 5 MiB source document. Running those files concurrently makes timing
    // assertions measure worker contention instead of editor behavior.
    fileParallelism: false,
  },
});
