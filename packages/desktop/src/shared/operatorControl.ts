import {
  operatorEnrollmentGrantRequestSchema,
  operatorHostPageSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema,
  type OperatorHostPage,
  type OperatorHostView
} from "@planweave-ai/distributed-protocol/operator-control";
import { z } from "zod";

const operatorProfileIdSchema = z.string().trim().min(1).max(128);

/** Non-secret Desktop profile. Credentials are held by Electron main only. */
export const operatorControlProfileSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    displayName: z.string().trim().min(1).max(128),
    serverBaseUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.username === "" &&
            url.password === "" &&
            url.pathname === "/" &&
            url.search === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      }, "serverBaseUrl must be an http(s) origin without credentials or a path"),
    allowInsecureTransport: z.boolean().default(false),
    operatorId: operatorProfileIdSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.serverBaseUrl);
    if (url.protocol === "https:") return;
    if (!value.allowInsecureTransport) {
      context.addIssue({
        code: "custom",
        message: "HTTPS is required unless allowInsecureTransport is true",
        path: ["serverBaseUrl"]
      });
      return;
    }
    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1";
    if (!loopback) {
      context.addIssue({
        code: "custom",
        message: "Insecure HTTP is only allowed for loopback hosts",
        path: ["serverBaseUrl"]
      });
    }
  });

export type OperatorControlProfile = z.infer<typeof operatorControlProfileSchema>;

export const operatorProfileIdInputSchema = z
  .object({ profileId: operatorProfileIdSchema })
  .strict();
export type OperatorProfileIdInput = z.infer<typeof operatorProfileIdInputSchema>;

export const operatorImportCredentialInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    operatorId: operatorProfileIdSchema.optional()
  })
  .strict();
export type OperatorImportCredentialInput = z.infer<typeof operatorImportCredentialInputSchema>;

export const operatorListHostsInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    query: operatorPageQuerySchema.optional()
  })
  .strict();
export type OperatorListHostsInput = z.input<typeof operatorListHostsInputSchema>;

export const operatorCreateEnrollmentGrantInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    request: operatorEnrollmentGrantRequestSchema
  })
  .strict();
export type OperatorCreateEnrollmentGrantInput = z.input<
  typeof operatorCreateEnrollmentGrantInputSchema
>;

const hostBootstrapAbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => /^(?:\/|[A-Za-z]:[\\/])/.test(value), "path must be absolute");

const hostBootstrapRelativeWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/^(?:\/|[A-Za-z]:[\\/])/.test(value) &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "workspacePath must be a safe relative path"
  );

export const operatorHostBootstrapConfigSchema = z
  .object({
    configPath: hostBootstrapAbsolutePathSchema,
    dataDirectory: hostBootstrapAbsolutePathSchema,
    workspaceRoot: hostBootstrapAbsolutePathSchema,
    workspacePath: hostBootstrapRelativeWorkspacePathSchema,
    acpProfilePreset: z.literal("codex-acp"),
    host: z
      .object({
        displayName: z.string().trim().min(1).max(128),
        capacity: z.number().int().min(1).max(128),
        capabilities: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/))
          .min(1)
          .max(128)
      })
      .strict()
  })
  .strict();
export type OperatorHostBootstrapConfig = z.infer<typeof operatorHostBootstrapConfigSchema>;

export const operatorCopyHostBootstrapHandoffInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    request: operatorEnrollmentGrantRequestSchema,
    bootstrap: operatorHostBootstrapConfigSchema
  })
  .strict();
export type OperatorCopyHostBootstrapHandoffInput = z.input<
  typeof operatorCopyHostBootstrapHandoffInputSchema
>;

export const operatorCopyMemberSetupCodeInputSchema = z
  .object({ profileId: operatorProfileIdSchema })
  .strict();
export type OperatorCopyMemberSetupCodeInput = z.infer<
  typeof operatorCopyMemberSetupCodeInputSchema
>;

/** Renderer-safe result of a main-owned one-time clipboard handoff. */
const operatorClipboardHandoffViewSchema = z
  .object({
    state: z.literal("ready"),
    workspaceId: operatorProfileIdSchema,
    expiresAt: z.iso.datetime(),
    copiedAt: z.iso.datetime()
  })
  .strict();
export const operatorHostBootstrapHandoffViewSchema = operatorClipboardHandoffViewSchema;
export type OperatorHostBootstrapHandoffView = z.infer<
  typeof operatorHostBootstrapHandoffViewSchema
>;

export const operatorMemberSetupCodeHandoffViewSchema = operatorClipboardHandoffViewSchema;
export type OperatorMemberSetupCodeHandoffView = z.infer<
  typeof operatorMemberSetupCodeHandoffViewSchema
>;

export const operatorRevokeHostInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    hostId: operatorProfileIdSchema
  })
  .strict();
export type OperatorRevokeHostInput = z.infer<typeof operatorRevokeHostInputSchema>;

export type OperatorCredentialStorage = "available" | "unavailable";
export type OperatorCredentialPersistence = "persisted" | "session-only" | "missing";

export type OperatorProfileView = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
  operatorId: string | null;
  hasOperatorCredential: boolean;
  operatorCredentialPersistence: OperatorCredentialPersistence;
  updatedAt: string;
};

export type OperatorControlStatus = {
  profiles: OperatorProfileView[];
  activeProfileId: string | null;
  credentialStorage: OperatorCredentialStorage;
  nonPersistenceWarning: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
};

export type OperatorControlErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "protocol"
  | "payload_too_large"
  | "offline"
  | "timeout"
  | "unknown";

export class OperatorControlError extends Error {
  readonly kind: OperatorControlErrorKind;
  readonly code: string;
  readonly httpStatus?: number;

  constructor(input: {
    kind: OperatorControlErrorKind;
    code: string;
    message?: string;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(input.message ?? input.code);
    this.name = "OperatorControlError";
    this.kind = input.kind;
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

const forbiddenSecretKeys = [
  "operatorToken",
  "setupCode",
  "enrollmentCode",
  "hostEnrollmentCode",
  "encryptedOperatorToken",
  "authorization",
  "Authorization",
  "credentialPath",
  "credentialsPath",
  "headers",
  "url",
  "path",
  "command"
] as const;

const OPERATOR_IPC_MAX_DEPTH = 16;
const OPERATOR_IPC_MAX_NODES = 256;

function operatorIpcValidationError(context: string, detail: string): OperatorControlError {
  return new OperatorControlError({
    kind: "validation",
    code: "operator_ipc_payload_forbidden",
    message: `Operator IPC rejected ${context}: ${detail}`
  });
}

/** Reject secrets and transport escapes crossing the renderer IPC boundary. */
export function assertNoSmuggledOperatorSecrets(value: unknown, context: string): void {
  const stack: Array<{ candidate: unknown; depth: number }> = [{ candidate: value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.candidate || typeof current.candidate !== "object") continue;
    if (current.depth > OPERATOR_IPC_MAX_DEPTH) {
      throw operatorIpcValidationError(context, "payload nesting is too deep.");
    }
    if (seen.has(current.candidate)) {
      throw operatorIpcValidationError(context, "cyclic payloads are not allowed.");
    }
    seen.add(current.candidate);
    visited += 1;
    if (visited > OPERATOR_IPC_MAX_NODES) {
      throw operatorIpcValidationError(context, "payload contains too many values.");
    }
    const entries = Array.isArray(current.candidate)
      ? current.candidate.map((nested, index) => [String(index), nested] as const)
      : Object.entries(current.candidate);
    if (visited + entries.length > OPERATOR_IPC_MAX_NODES) {
      throw operatorIpcValidationError(context, "payload contains too many values.");
    }
    for (const [key, nested] of entries) {
      if ((forbiddenSecretKeys as readonly string[]).includes(key) && nested !== undefined) {
        throw operatorIpcValidationError(context, `field "${key}" is not allowed.`);
      }
      stack.push({ candidate: nested, depth: current.depth + 1 });
    }
  }
}

export {
  operatorControlInvokeChannels,
  operatorControlStatusChangedChannel
} from "./operatorControlIpc.js";

export type PlanWeaveOperatorControlApi = {
  getOperatorControlStatus: () => Promise<OperatorControlStatus>;
  upsertOperatorProfile: (input: OperatorControlProfile) => Promise<OperatorControlStatus>;
  removeOperatorProfile: (input: OperatorProfileIdInput) => Promise<OperatorControlStatus>;
  setActiveOperatorProfile: (input: OperatorProfileIdInput) => Promise<OperatorControlStatus>;
  clearActiveOperatorProfile: () => Promise<OperatorControlStatus>;
  importOperatorCredential: (
    input: OperatorImportCredentialInput
  ) => Promise<OperatorControlStatus>;
  clearOperatorCredential: (input: OperatorProfileIdInput) => Promise<OperatorControlStatus>;
  listOperatorHosts: (input: OperatorListHostsInput) => Promise<OperatorHostPage>;
  copyOperatorHostBootstrapHandoff: (
    input: OperatorCopyHostBootstrapHandoffInput
  ) => Promise<OperatorHostBootstrapHandoffView>;
  copyOperatorMemberSetupCode: (
    input: OperatorCopyMemberSetupCodeInput
  ) => Promise<OperatorMemberSetupCodeHandoffView>;
  revokeOperatorHost: (input: OperatorRevokeHostInput) => Promise<OperatorHostView>;
  onOperatorControlStatusChanged: (callback: (status: OperatorControlStatus) => void) => () => void;
};

export {
  operatorEnrollmentGrantRequestSchema,
  operatorHostPageSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema
};
