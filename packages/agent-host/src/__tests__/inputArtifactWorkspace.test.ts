import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareInputArtifacts } from "../execution/inputArtifactWorkspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("prepareInputArtifacts", () => {
  it("materializes verified inputs at relative paths and removes only its own directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "planweave-input-workspace-"));
    directories.push(workspace);
    const sentinel = join(workspace, "operator-owned.txt");
    await writeFile(sentinel, "keep", "utf8");
    const download = vi.fn(async () => ({
      bytes: Buffer.from("input contents", "utf8"),
      mediaType: "text/plain" as const
    }));
    const prepared = await prepareInputArtifacts({
      cwd: workspace,
      prompt: "Run the block.",
      inputs: [
        {
          artifactRef: `artifact:sha256:${"a".repeat(64)}`,
          logicalName: "requirements.txt",
          mediaType: "text/plain"
        }
      ],
      artifacts: { download, upload: vi.fn() }
    });
    const relativePath = prepared.prompt.match(
      /\.planweave-agent-host-inputs-[^/]+\/requirements\.txt/
    )?.[0];
    expect(relativePath).toBeDefined();
    expect(prepared.prompt).not.toContain(workspace);
    expect(await readFile(join(workspace, relativePath ?? "missing"), "utf8")).toBe(
      "input contents"
    );

    await prepared.cleanup();
    await prepared.cleanup();
    await expect(access(join(workspace, relativePath ?? "missing"))).rejects.toThrow();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("cleans its temporary directory when materialization conflicts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "planweave-input-conflict-"));
    directories.push(workspace);
    const download = vi.fn(async () => ({
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream" as const
    }));
    await expect(
      prepareInputArtifacts({
        cwd: workspace,
        prompt: "Run.",
        inputs: [
          { artifactRef: `artifact:sha256:${"a".repeat(64)}`, logicalName: "same" },
          { artifactRef: `artifact:sha256:${"b".repeat(64)}`, logicalName: "same" }
        ],
        artifacts: { download, upload: vi.fn() }
      })
    ).rejects.toThrow();
    await expect(readdir(workspace)).resolves.toEqual([]);
  });
});
