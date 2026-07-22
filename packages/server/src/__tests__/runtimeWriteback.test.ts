import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { claimDispatchedBlock, getExecutionStatus } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { createPlanPackageDispatchWriteback } from "../runtimeWriteback.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const projectRoot = workspace.root;
  const dataDirectory = join(projectRoot, "server-data");
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  servers.push(server);
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
  const writeback = createPlanPackageDispatchWriteback({
    artifacts,
    resolvePackageRef: (packageRef) => {
      if (packageRef !== "local:fixture") throw new Error("unknown package reference");
      return projectRoot;
    }
  });
  return { projectRoot, artifacts, writeback };
}

describe("Plan Package dispatch writeback", () => {
  it("submits a verified remote Markdown report through the runtime authority", async () => {
    const { projectRoot, artifacts, writeback } = await setup();
    await expect(claimDispatchedBlock({ projectRoot, ref: "T-001#B-001" })).resolves.toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    const report = Buffer.from("# Remote result\n\nThe implementation is complete.\n");
    const sha256 = createHash("sha256").update(report).digest("hex");
    const artifact = await artifacts.put({
      expectedSha256: sha256,
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown; charset=utf-8",
      chunks: (async function* () {
        yield report;
      })()
    });

    await writeback.complete({
      dispatchId: "dispatch-runtime-1",
      projectId: "project-runtime",
      blockRef: "T-001#B-001",
      packageRef: "local:fixture",
      result: {
        summary: "Remote execution completed.",
        reportArtifactRef: artifact.ref,
        artifactRefs: []
      }
    });

    await expect(getExecutionStatus({ projectRoot })).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({ ref: "T-001#B-001", status: "completed" })
      ])
    });
  });

  it("writes a remote execution failure back as a blocked runtime state", async () => {
    const { projectRoot, writeback } = await setup();
    await claimDispatchedBlock({ projectRoot, ref: "T-001#B-001" });
    await writeback.fail({
      dispatchId: "dispatch-runtime-2",
      projectId: "project-runtime",
      blockRef: "T-001#B-001",
      packageRef: "local:fixture",
      failure: {
        code: "lease_expired",
        message: "The remote host stopped responding.",
        retryable: true
      }
    });

    await expect(getExecutionStatus({ projectRoot })).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          reason: "[lease_expired] The remote host stopped responding."
        })
      ])
    });
  });
});
