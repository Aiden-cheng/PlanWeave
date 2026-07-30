export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isValidationFailure(error: unknown): error is {
  issues: { path: PropertyKey[]; message: string }[];
} {
  if (!isRecord(error) || !Array.isArray(error.issues)) return false;
  return error.issues.every(
    (issue) =>
      isRecord(issue) &&
      Array.isArray(issue.path) &&
      issue.path.every((segment) => ["string", "number", "symbol"].includes(typeof segment)) &&
      typeof issue.message === "string"
  );
}

export function validationFailureMessage(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "input" : issue.path.map(String).join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
