import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGlobalPrompt, updateGlobalPrompt } from "../globalPrompt";

const originalPlanweaveHome = process.env.PLANWEAVE_HOME;
const tempRoots: string[] = [];

afterEach(async () => {
  if (originalPlanweaveHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalPlanweaveHome;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("global prompt", () => {
  it("reads an absent prompt as empty and writes to the active PlanWeave Home", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-global-prompt-"));
    tempRoots.push(home);
    process.env.PLANWEAVE_HOME = home;

    await expect(readGlobalPrompt()).resolves.toBe("");
    await expect(updateGlobalPrompt("# Global Prompt\n\nShared policy.\n")).resolves.toBe(
      "# Global Prompt\n\nShared policy.\n"
    );
    await expect(readFile(join(home, "config", "global-prompt.md"), "utf8")).resolves.toBe(
      "# Global Prompt\n\nShared policy.\n"
    );
  });
});
