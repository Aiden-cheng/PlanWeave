/**
 * Deterministic JSON canonicalization for content-addressed wire payloads.
 *
 * Rules (narrow subset of JSON Canonicalization Scheme / RFC 8785 style):
 * - Objects: keys sorted by UTF-16 code unit order, no whitespace
 * - Arrays: element order preserved
 * - Strings: JSON.stringify escaping
 * - Numbers: finite only; serialized via JSON.stringify
 * - null / boolean: standard JSON tokens
 * - Rejects undefined, functions, symbols, bigint, non-finite numbers, and non-plain objects
 */

function assertFiniteNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("canonical JSON rejects non-finite numbers");
  }
}

/**
 * Return a deterministic JSON string for a JSON-compatible value.
 * Semantically identical plain objects always produce the same string.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  const valueType = typeof value;
  if (valueType === "boolean") {
    return value ? "true" : "false";
  }
  if (valueType === "number") {
    assertFiniteNumber(value as number);
    return JSON.stringify(value);
  }
  if (valueType === "string") {
    return JSON.stringify(value);
  }
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`canonical JSON rejects ${valueType}`);
  }
  if (valueType === "bigint") {
    throw new TypeError("canonical JSON rejects bigint");
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  if (valueType === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON rejects non-plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = record[key];
      parts.push(`${JSON.stringify(key)}:${canonicalizeJson(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("canonical JSON rejects unsupported value");
}
