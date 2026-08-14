import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("CI workflow configuration", () => {
  it("preserves failed test reports after an earlier step fails", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const testSteps = ["unit", "integration", "performance", "platform"] as const;

    for (const step of testSteps) {
      expect(workflow).toContain(`if: always() && steps.${step}-tests.outcome == 'failure'`);
      expect(workflow).toContain(
        `if: always() && steps.${step}-tests.outcome == 'failure' && steps.redact-${step}.outcome == 'success'`
      );
    }
  });
});
