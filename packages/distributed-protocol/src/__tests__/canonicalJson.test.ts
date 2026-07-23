import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "../canonicalJson.js";

describe("canonicalizeJson", () => {
  it("sorts object keys and omits whitespace", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ nested: { z: true, a: false }, list: [3, 1] })).toBe(
      '{"list":[3,1],"nested":{"a":false,"z":true}}'
    );
  });

  it("preserves array order and encodes Unicode via JSON string rules", () => {
    expect(canonicalizeJson(["b", "a", "中文", "emoji-😀"])).toBe('["b","a","中文","emoji-😀"]');
    expect(canonicalizeJson({ キー: "値" })).toBe('{"キー":"値"}');
  });

  it("produces identical output for semantically identical key order variants", () => {
    const left = canonicalizeJson({ z: [{ b: 1, a: 2 }], m: null, a: "x" });
    const right = canonicalizeJson({ a: "x", m: null, z: [{ a: 2, b: 1 }] });
    expect(left).toBe(right);
  });

  it("rejects non-finite numbers and non-JSON types", () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalizeJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalizeJson(() => 1)).toThrow(/function/);
    expect(() => canonicalizeJson(1n)).toThrow(/bigint/);
  });

  it("uses deterministic JSON number serialization", () => {
    expect(canonicalizeJson([-0, 1.5, 1e30, Number.MAX_SAFE_INTEGER])).toBe(
      "[0,1.5,1e+30,9007199254740991]"
    );
  });

  it("rejects undefined object values and non-plain objects", () => {
    expect(() => canonicalizeJson({ a: 1, b: undefined })).toThrow(/undefined/);
    expect(() => canonicalizeJson(new Date(0))).toThrow(/non-plain/);
  });

  it("serializes null and booleans as JSON tokens", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(false)).toBe("false");
  });
});
