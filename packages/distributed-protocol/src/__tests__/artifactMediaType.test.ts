import { describe, expect, it } from "vitest";
import { ARTIFACT_MEDIA_TYPE_MAX_LENGTH, artifactMediaTypeSchema } from "../artifactMediaType.js";

describe("artifact media type contract", () => {
  it("canonicalizes type, subtype, parameter names, and whitespace", () => {
    expect(artifactMediaTypeSchema.parse("Text/Plain ; Charset=UTF-8; title=ReadMe")).toBe(
      "text/plain; charset=UTF-8; title=ReadMe"
    );
    expect(artifactMediaTypeSchema.parse('APPLICATION/X.Test%V; Name="Case Sensitive"')).toBe(
      'application/x.test%v; name="Case Sensitive"'
    );
  });

  it("accepts the exact 255-byte boundary", () => {
    const value = `application/${"x".repeat(ARTIFACT_MEDIA_TYPE_MAX_LENGTH - 12)}`;
    expect(value).toHaveLength(ARTIFACT_MEDIA_TYPE_MAX_LENGTH);
    expect(artifactMediaTypeSchema.parse(value)).toBe(value);
    expect(() => artifactMediaTypeSchema.parse(`${value}x`)).toThrow();
  });

  it.each([
    "../../secret",
    "text",
    "text/",
    "/plain",
    "text/plain; charset",
    "text/plain; charset=",
    'text/plain; charset="unterminated',
    "text/plain\napplication/json",
    "téxt/plain"
  ])("rejects malformed or non-ASCII value %j", (value) => {
    expect(() => artifactMediaTypeSchema.parse(value)).toThrow();
  });
});
