import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

const platform = process.argv[2];
if (!platform) throw new Error("usage: node scripts/collect-ci-artifact.mjs <platform>");

const binaryName = process.platform === "win32" ? "plainroot.exe" : "plainroot";
const source = resolve("src-tauri", "target", "release", binaryName);
const outputDirectory = resolve("artifacts", platform);
const output = join(outputDirectory, binaryName);
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, output);

const bytes = await readFile(output);
const digest = createHash("sha256").update(bytes).digest("hex");
await writeFile(
  join(outputDirectory, "sha256sums.txt"),
  `${digest}  ${basename(output)}\n`,
  "utf8",
);
