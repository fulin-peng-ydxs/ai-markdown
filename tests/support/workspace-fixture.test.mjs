import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { createWorkspaceFixture } from "./workspace-fixture.mjs";

test("workspace fixture creates an isolated copy and cleans it recursively", async () => {
  const first = await createWorkspaceFixture();
  const second = await createWorkspaceFixture();

  try {
    assert.notEqual(first.root, second.root);
    assert.match(await readFile(`${first.root}/note.md`, "utf8"), /Plainroot fixture/);
    await writeFile(`${first.root}/note.md`, "# changed only in first copy\n");
    assert.match(await readFile(`${second.root}/note.md`, "utf8"), /Plainroot fixture/);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }

  await assert.rejects(access(first.root));
  await assert.rejects(access(second.root));
});
