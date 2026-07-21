import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findLicenseProblems,
  LICENSE_FILE_REVIEW,
  readPackage,
} from "./check-licenses.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

test("license policy blocks copyleft, missing, and manual-review entries", () => {
  const problems = findLicenseProblems([
    { name: "versioned", version: "1", license: "GPL-3.0-only" },
    { name: "bare", version: "1", license: "GPL" },
    { name: "agpl", version: "1", license: "AGPL" },
    { name: "missing", version: "1", license: null },
    { name: "file-only", version: "1", license: LICENSE_FILE_REVIEW },
    { name: "copyleft-only-choices", version: "1", license: "AGPL-3.0 OR GPL-3.0" },
    { name: "dual-license-choice", version: "1", license: "(MIT OR GPL-3.0-or-later)" },
    { name: "permissive", version: "1", license: "MIT OR Apache-2.0" },
    { name: "weak-copyleft-or-mit", version: "1", license: "LGPL-2.1 OR MIT" },
  ]);

  assert.deepEqual(
    problems.map(({ name }) => name),
    ["versioned", "bare", "agpl", "missing", "file-only", "copyleft-only-choices"],
  );
});

test("license policy CLI exits with code 1 for an invalid fixture", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(scriptsDirectory, "check-licenses.mjs"),
      "--policy-fixture",
      join(scriptsDirectory, "fixtures", "license-policy-invalid.json"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.problems, 4);
  assert.deepEqual(
    report.problems.map(({ name }) => name),
    [
      "versioned-copyleft",
      "bare-copyleft",
      "missing-license",
      "license-file-only",
    ],
  );
});

test("reviewed package metadata fails closed when its evidence disappears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plainroot-license-review-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "css-value", version: "0.0.1" }),
    );
    assert.equal(readPackage(directory).license, null);

    await writeFile(join(directory, "Readme.md"), "## License\n\n(The MIT License)\n");
    assert.deepEqual(readPackage(directory), {
      name: "css-value",
      version: "0.0.1",
      license: "MIT",
      licenseSource: "reviewed:Readme.md",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
