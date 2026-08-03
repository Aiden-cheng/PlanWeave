import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DispatchInputArtifact } from "@planweave-ai/agent-host-protocol";
import type { AgentHostArtifactTransfer } from "./agentHostExecutor.js";

const MAX_INPUT_ARTIFACT_TOTAL_BYTES = 64 * 1_024 * 1_024;

export type PreparedInputArtifacts = {
  prompt: string;
  cleanup(): Promise<void>;
};

export async function prepareInputArtifacts(options: {
  cwd: string;
  prompt: string;
  inputs: readonly DispatchInputArtifact[];
  artifacts: AgentHostArtifactTransfer;
}): Promise<PreparedInputArtifacts> {
  if (options.inputs.length === 0) {
    return { prompt: options.prompt, cleanup: async () => undefined };
  }
  const downloads: Array<{ input: DispatchInputArtifact; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const input of options.inputs) {
    const downloaded = await options.artifacts.download(input);
    totalBytes += downloaded.bytes.byteLength;
    if (totalBytes > MAX_INPUT_ARTIFACT_TOTAL_BYTES) {
      throw new Error("artifact_download_total_size_exceeded");
    }
    downloads.push({ input, bytes: downloaded.bytes });
  }

  const directory = await mkdtemp(join(options.cwd, ".planweave-agent-host-inputs-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(directory, { recursive: true, force: false });
  };
  try {
    for (const { input, bytes } of downloads) {
      await writeFile(join(directory, input.logicalName), bytes, { flag: "wx", mode: 0o400 });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  const relativeDirectory = basename(directory);
  const manifest = downloads
    .map(({ input }) => `- ${input.logicalName}: ${relativeDirectory}/${input.logicalName}`)
    .join("\n");
  return {
    prompt: `${options.prompt}\n\nPLANWEAVE HOST INPUT ARTIFACTS\nThe verified, read-only dispatch inputs are available at these workspace-relative paths:\n${manifest}`,
    cleanup
  };
}
