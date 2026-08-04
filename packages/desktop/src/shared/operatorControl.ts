import {
  operatorEnrollmentGrantRequestSchema,
  operatorHostPageSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema,
  type OperatorHostPage,
  type OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";
import {
  deploymentEndpointSchema,
  isPrivateDeploymentHostname
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";

const operatorProfileIdSchema = z.string().trim().min(1).max(128);

const operatorControlProfileFields = {
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
} as const;

function refineOperatorTransport(
  value: { serverBaseUrl: string; allowInsecureTransport: boolean },
  context: z.RefinementCtx
): void {
  const url = new URL(value.serverBaseUrl);
  if (url.protocol !== "https:" && !value.allowInsecureTransport) {
    context.addIssue({
      code: "custom",
      message: "HTTPS is required unless allowInsecureTransport is true",
      path: ["serverBaseUrl"]
    });
  }
  if (url.protocol === "http:" && !isPrivateDeploymentHostname(url.hostname.toLowerCase())) {
    context.addIssue({
      code: "custom",
      message: "Insecure HTTP is only allowed for loopback or private-network hosts",
      path: ["serverBaseUrl"]
    });
  }
}

/** Non-secret Main-owned profile. Credentials are held by Electron main only. */
export const operatorControlProfileSchema = z
  .object({ ...operatorControlProfileFields, endpoint: deploymentEndpointSchema.optional() })
  .strict()
  .superRefine(refineOperatorTransport)
  .superRefine((value, context) => {
    if (
      value.endpoint &&
      new URL(value.endpoint.serverOrigin).origin !== new URL(value.serverBaseUrl).origin
    ) {
      context.addIssue({
        code: "custom",
        message: "operator_endpoint_origin_mismatch",
        path: ["endpoint"]
      });
    }
  });

export type OperatorControlProfile = z.infer<typeof operatorControlProfileSchema>;
export const operatorControlProfileInputSchema = z
  .object(operatorControlProfileFields)
  .strict()
  .superRefine(refineOperatorTransport);
export type OperatorControlProfileInput = z.infer<typeof operatorControlProfileInputSchema>;

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

export const operatorCopyHostBootstrapHandoffInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    request: operatorEnrollmentGrantRequestSchema
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
    copiedAt: z.iso.datetime(),
    commandPreview: z.literal("planweave agent-host enroll <handoff>").optional()
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

const localAgentHostProfileIdSchema = z.string().trim().min(1).max(128);
export const operatorLocalAgentHostProfileViewSchema = z
  .object({
    profileId: localAgentHostProfileIdSchema,
    agentId: localAgentHostProfileIdSchema,
    displayName: z.string().trim().min(1).max(128),
    detected: z.boolean(),
    exposed: z.boolean(),
    ready: z.boolean()
  })
  .strict();
export type OperatorLocalAgentHostProfileView = z.infer<
  typeof operatorLocalAgentHostProfileViewSchema
>;

export const operatorLocalAgentHostStatusSchema = z
  .object({
    supported: z.boolean(),
    state: z.enum(["not_registered", "ready", "background_setup_required"]),
    workspaceId: operatorProfileIdSchema.optional(),
    background: z.enum(["running", "stopped", "not_installed", "setup_required"]).optional(),
    agents: z.array(operatorLocalAgentHostProfileViewSchema).max(32)
  })
  .strict();
export type OperatorLocalAgentHostStatus = z.infer<typeof operatorLocalAgentHostStatusSchema>;

export const operatorGetLocalAgentHostStatusInputSchema = z
  .object({ profileId: operatorProfileIdSchema.optional() })
  .strict();
export type OperatorGetLocalAgentHostStatusInput = z.infer<
  typeof operatorGetLocalAgentHostStatusInputSchema
>;

const exposedLocalAgentProfilesSchema = z
  .array(localAgentHostProfileIdSchema)
  .min(1)
  .max(32)
  .superRefine((value, context) => {
    if (new Set(value).size !== value.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate local Agent Host profile",
        path: []
      });
    }
  });

export const operatorRegisterLocalAgentHostInputSchema = z
  .object({
    profileId: operatorProfileIdSchema,
    request: operatorEnrollmentGrantRequestSchema,
    exposedProfileIds: exposedLocalAgentProfilesSchema
  })
  .strict();
export type OperatorRegisterLocalAgentHostInput = z.infer<
  typeof operatorRegisterLocalAgentHostInputSchema
>;

export const operatorEnrollLocalAgentHostFromClipboardInputSchema = z
  .object({ exposedProfileIds: exposedLocalAgentProfilesSchema })
  .strict();
export type OperatorEnrollLocalAgentHostFromClipboardInput = z.infer<
  typeof operatorEnrollLocalAgentHostFromClipboardInputSchema
>;

export type OperatorCredentialStorage = "available" | "unavailable";
export type OperatorCredentialPersistence = "persisted" | "session-only" | "missing";

export type OperatorProfileView = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
  endpoint?: z.infer<typeof deploymentEndpointSchema>;
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
  "command",
  "endpoint"
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
  upsertOperatorProfile: (input: OperatorControlProfileInput) => Promise<OperatorControlStatus>;
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
  getOperatorLocalAgentHostStatus: (
    input: OperatorGetLocalAgentHostStatusInput
  ) => Promise<OperatorLocalAgentHostStatus>;
  registerOperatorLocalAgentHost: (
    input: OperatorRegisterLocalAgentHostInput
  ) => Promise<OperatorLocalAgentHostStatus>;
  enrollOperatorLocalAgentHostFromClipboard: (
    input: OperatorEnrollLocalAgentHostFromClipboardInput
  ) => Promise<OperatorLocalAgentHostStatus>;
  onOperatorControlStatusChanged: (callback: (status: OperatorControlStatus) => void) => () => void;
};

export {
  operatorEnrollmentGrantRequestSchema,
  operatorHostPageSchema,
  operatorHostViewSchema,
  operatorPageQuerySchema
};
