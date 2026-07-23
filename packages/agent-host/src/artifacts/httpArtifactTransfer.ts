import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactMediaTypeSchema } from "@planweave-ai/distributed-protocol";
import type {
  AgentHostArtifactInput,
  AgentHostArtifactTransfer,
  AgentHostExecuteCommand
} from "../execution/agentHostExecutor.js";
import { parseAgentHostArtifactRef, type ArtifactRef } from "../protocol.js";

export type HttpArtifactTransferOptions = {
  baseUrl: URL;
  hostId: string;
  token: string;
};

const uploadResponseSchema = z.object({ ref: z.unknown() });
const artifactOperationKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export class HttpArtifactClient {
  constructor(private readonly options: HttpArtifactTransferOptions) {}

  forExecution(command: AgentHostExecuteCommand): AgentHostArtifactTransfer {
    return {
      upload: (input) => this.upload(command, input)
    };
  }

  private async upload(
    command: AgentHostExecuteCommand,
    input: AgentHostArtifactInput
  ): Promise<ArtifactRef> {
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const operationKey = artifactOperationKeySchema.parse(input.operationKey);
    const mediaType = artifactMediaTypeSchema.parse(input.mediaType);
    const operationId = `artifact-upload:${createHash("sha256")
      .update(
        JSON.stringify([
          this.options.hostId,
          command.dispatchId,
          command.leaseId,
          command.executionAttemptId,
          input.purpose,
          operationKey,
          sha256,
          bytes.byteLength,
          mediaType
        ])
      )
      .digest("hex")}`;
    const url = new URL(this.options.baseUrl.origin);
    url.pathname =
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}` +
      `/dispatches/${encodeURIComponent(command.dispatchId)}` +
      `/leases/${encodeURIComponent(command.leaseId)}` +
      `/attempts/${encodeURIComponent(command.executionAttemptId)}/artifacts/${sha256}`;

    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            "content-type": mediaType,
            "content-length": String(bytes.byteLength),
            "x-planweave-artifact-operation-id": operationId,
            "x-planweave-artifact-purpose": input.purpose
          },
          body: bytes
        });
        break;
      } catch (error) {
        if (attempt === 1) {
          throw new Error("artifact_upload_failed:transport", { cause: error });
        }
      }
    }
    if (!response) throw new Error("artifact_upload_failed:transport");
    if (!response.ok) throw new Error(`artifact_upload_failed:${response.status}`);
    const ref = parseAgentHostArtifactRef(uploadResponseSchema.parse(await response.json()).ref);
    if (ref !== `artifact:sha256:${sha256}`) throw new Error("artifact_upload_ref_mismatch");
    return ref;
  }
}
