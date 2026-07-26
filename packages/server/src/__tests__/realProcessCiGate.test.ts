/**
 * Locks the deterministic realProcess multi-process suite into required CI paths.
 * Does not spawn Server/Host; only verifies registration contracts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Deterministic multi-process suite required by release-gate CI tier. */
const DETERMINISTIC_REAL_PROCESS_FILES = [
  "realProcessAcpHarness.test.ts",
  "realProcessRemoteBlockLifecycle.test.ts",
  "realProcessCrashReplayMatrix.test.ts",
  "realProcessAuthorizationMatrix.test.ts"
] as const;

describe("real-process CI registration gate", () => {
  it("keeps realProcess suites on the required distributed integration CI shard", async () => {
    const [workflow, suitesJson, packageJson, integrationDistributedConfig, runDeterministic] =
      await Promise.all([
        readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
        readFile(join(repositoryRoot, "vitest.suites.json"), "utf8"),
        readFile(join(repositoryRoot, "package.json"), "utf8"),
        readFile(join(repositoryRoot, "vitest.integration-distributed.config.ts"), "utf8"),
        readFile(join(repositoryRoot, "packages/server/src/releaseGate/runDeterministic.ts"), "utf8")
      ]);

    const packageScripts = JSON.parse(packageJson) as { scripts: Record<string, string> };
    expect(packageScripts.scripts["test:integration:distributed"]).toMatch(
      /vitest\.integration-distributed\.config\.ts/
    );
    expect(integrationDistributedConfig).toContain("packages/server/src/__tests__");
    expect(integrationDistributedConfig).toContain("packages/agent-host/src/__tests__");

    // Required CI job: dedicated distributed shard with serial workers.
    expect(workflow).toContain("shard: distributed");
    expect(workflow).toContain("label: Server and Agent Host");
    expect(workflow).toContain(
      "pnpm test:integration:${{ matrix.shard }} --maxWorkers=${{ matrix.max_workers }}"
    );
    expect(workflow).toMatch(/shard:\s*distributed[\s\S]*?max_workers:\s*1/);
    expect(workflow).not.toMatch(/shard:\s*distributed[\s\S]*?max_workers:\s*2/);

    const suites = JSON.parse(suitesJson) as {
      groups: Array<{ root: string; integration: string[] }>;
    };
    const serverSuite = suites.groups.find(
      (entry) => entry.root === "packages/server/src/__tests__"
    );
    expect(serverSuite, "server integration suite root missing").toBeDefined();
    // This gate file itself must live on the distributed integration path.
    expect(serverSuite?.integration).toContain("realProcessCiGate.test.ts");
    for (const file of DETERMINISTIC_REAL_PROCESS_FILES) {
      expect(serverSuite?.integration, file).toContain(file);
      expect(runDeterministic).toContain(`packages/server/src/__tests__/${file}`);
    }
  });
});
