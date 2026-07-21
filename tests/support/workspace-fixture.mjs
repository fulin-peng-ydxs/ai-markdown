import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(supportDirectory, "..", "fixtures", "workspaces");

export async function createWorkspaceFixture(name = "basic") {
  const source = join(fixtureDirectory, name);
  const root = await mkdtemp(join(tmpdir(), "plainroot-e2e-workspace-"));
  await cp(source, root, { recursive: true });

  let removed = false;
  return {
    root,
    async cleanup() {
      if (removed) return;
      removed = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}
