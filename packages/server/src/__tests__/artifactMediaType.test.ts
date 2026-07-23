import { artifactMediaTypeSchema as sharedArtifactMediaTypeSchema } from "@planweave-ai/distributed-protocol";
import { describe, expect, it } from "vitest";
import { artifactMediaTypeSchema } from "../artifactMediaType.js";

describe("server artifact media type contract", () => {
  it("re-exports the shared authority without a server-specific acceptance set", () => {
    expect(artifactMediaTypeSchema).toBe(sharedArtifactMediaTypeSchema);
    for (const value of [
      "Text/Plain",
      "text/markdown; charset=utf-8",
      'application/x.test%v; title="Plan Weave"',
      "../../secret",
      "text/plain; charset=",
      `application/${"x".repeat(300)}`
    ]) {
      expect(artifactMediaTypeSchema.safeParse(value)).toEqual(
        sharedArtifactMediaTypeSchema.safeParse(value)
      );
    }
  });
});
