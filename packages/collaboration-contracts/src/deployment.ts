import { capabilitiesSchema, opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { collaborationServerOriginSchema, isLoopbackHostname } from "./connection.js";
import { timestampSchema, workspaceScopeRefSchema } from "./primitives.js";

export const deploymentConnectionSchemaVersion = "deployment-connection/v1" as const;
export const deploymentConnectionSchemaVersionSchema = z.literal(deploymentConnectionSchemaVersion);
export type DeploymentConnectionSchemaVersion = z.infer<
  typeof deploymentConnectionSchemaVersionSchema
>;

export const deploymentTargetDraftSchemaVersion = "deployment-target-draft/v1" as const;
export const deploymentTargetDraftSchemaVersionSchema = z.literal(
  deploymentTargetDraftSchemaVersion
);
export type DeploymentTargetDraftSchemaVersion = z.infer<
  typeof deploymentTargetDraftSchemaVersionSchema
>;

/** The three supported server exposure topologies. */
export const deploymentTopologySchema = z.enum(["loopback_http", "lan_https", "public_https"]);
export type DeploymentTopology = z.infer<typeof deploymentTopologySchema>;

export const deploymentTlsTrustSchema = z.enum(["not_applicable", "system_ca", "configured_ca"]);
export type DeploymentTlsTrust = z.infer<typeof deploymentTlsTrustSchema>;

const allowedClientOriginsSchema = z
  .array(collaborationServerOriginSchema)
  .min(1)
  .max(32)
  .superRefine((origins, context) => {
    if (new Set(origins).size !== origins.length) {
      context.addIssue({ code: "custom", message: "duplicate_allowed_client_origin" });
    }
  });

export const deploymentConnectionCapabilitySchema = z.enum([
  "workspace_connection",
  "deployment_guidance",
  "connectivity_validation",
  "agent_host_availability"
]);
export type DeploymentConnectionCapability = z.infer<typeof deploymentConnectionCapabilitySchema>;

export const deploymentConnectionCapabilitiesSchema = z
  .array(deploymentConnectionCapabilitySchema)
  .min(1)
  .max(16)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "duplicate_deployment_connection_capability" });
    }
  });
export type DeploymentConnectionCapabilities = z.infer<
  typeof deploymentConnectionCapabilitiesSchema
>;

function originPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function validateTopologyOrigin(
  value: {
    topology: DeploymentTopology;
    serverOrigin: string;
    allowedClientOrigins: string[];
    tlsTrust: DeploymentTlsTrust;
  },
  context: z.RefinementCtx
): void {
  const url = new URL(value.serverOrigin);
  const loopback = isLoopbackHostname(url.hostname);
  if (value.topology === "loopback_http") {
    if (
      url.protocol !== "http:" ||
      !loopback ||
      value.tlsTrust !== "not_applicable" ||
      value.allowedClientOrigins.some((origin) => {
        const client = new URL(origin);
        return client.protocol !== "http:" || !isLoopbackHostname(client.hostname);
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "loopback_http_requires_loopback_http_origins_without_tls",
        path: ["serverOrigin"]
      });
    }
    return;
  }
  if (
    url.protocol !== "https:" ||
    loopback ||
    value.tlsTrust === "not_applicable" ||
    value.allowedClientOrigins.some((origin) => {
      const client = new URL(origin);
      return client.protocol !== "https:" || isLoopbackHostname(client.hostname);
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "network_topology_requires_trusted_non_loopback_https_origins",
      path: ["serverOrigin"]
    });
  }
  if (value.topology === "public_https" && originPort(url) !== 443) {
    context.addIssue({
      code: "custom",
      message: "public_https_requires_direct_tls_port_443",
      path: ["serverOrigin"]
    });
  }
}

/**
 * Provider-neutral server exposure endpoint. LAN and public endpoints require
 * trusted HTTPS/WSS; the websocket origin is derived from this HTTP origin.
 */
export const deploymentEndpointSchema = z
  .object({
    topology: deploymentTopologySchema,
    serverOrigin: collaborationServerOriginSchema,
    allowedClientOrigins: allowedClientOriginsSchema,
    tlsTrust: deploymentTlsTrustSchema
  })
  .strict()
  .superRefine(validateTopologyOrigin);
export type DeploymentEndpoint = z.infer<typeof deploymentEndpointSchema>;

export function deploymentWebSocketOrigin(endpoint: DeploymentEndpoint): string {
  const url = new URL(endpoint.serverOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Main-owned Origin header derived from the validated endpoint, never renderer headers. */
export function deploymentOriginHeader(endpoint: DeploymentEndpoint): string | null {
  const origin = new URL(endpoint.serverOrigin).origin;
  return endpoint.allowedClientOrigins.some((allowed) => new URL(allowed).origin === origin)
    ? origin
    : null;
}

/**
 * A non-persistent target used to review and validate a Server before any
 * Workspace authentication exists. It is never an authenticated connection.
 */
export const deploymentTargetDraftSchema = z
  .object({
    schemaVersion: deploymentTargetDraftSchemaVersionSchema,
    displayName: z.string().trim().min(1).max(128),
    endpoint: deploymentEndpointSchema,
    capabilities: deploymentConnectionCapabilitiesSchema
  })
  .strict();
export type DeploymentTargetDraft = z.infer<typeof deploymentTargetDraftSchema>;

/**
 * Single Desktop connection profile for both self-hosted and future hosted
 * endpoints. Workspace authority and capabilities remain opaque and portable.
 */
export const deploymentConnectionProfileSchema = z
  .object({
    schemaVersion: deploymentConnectionSchemaVersionSchema,
    profileId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    workspace: workspaceScopeRefSchema,
    endpoint: deploymentEndpointSchema,
    capabilities: deploymentConnectionCapabilitiesSchema
  })
  .strict();
export type DeploymentConnectionProfile = z.infer<typeof deploymentConnectionProfileSchema>;

export const deploymentOperationalRequirementsSchema = z
  .object({
    durableState: z.literal("required"),
    healthcheck: z.object({ required: z.literal(true) }).strict(),
    publicIngress: z
      .object({ tls: z.literal("direct"), port: z.literal(443) })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.publicIngress === null) return;
    if (value.publicIngress.tls !== "direct" || value.publicIngress.port !== 443) {
      context.addIssue({ code: "custom", message: "public_ingress_requires_direct_tls_port_443" });
    }
  });
export type DeploymentOperationalRequirements = z.infer<
  typeof deploymentOperationalRequirementsSchema
>;

/** Fixed, reviewable handoff only. Desktop never accepts a command from renderer. */
export const deploymentComposeHandoffSchema = z
  .object({
    state: z.enum(["supported", "not_applicable"]),
    copyAction: z.literal("copy_supported_compose_handoff").nullable(),
    preview: z
      .literal(
        "PLANWEAVE_SERVER_CONFIG_PATH=./server.json PLANWEAVE_SERVER_TLS_DIRECTORY=./tls PLANWEAVE_SERVER_PROJECTS_ROOT=./projects docker compose -f packages/server/compose.yaml up --detach --wait"
      )
      .nullable(),
    configInputPath: z.literal("./server.json").nullable(),
    tlsDirectory: z.literal("./tls").nullable(),
    projectsRoot: z.literal("./projects").nullable(),
    projectsMountTarget: z.literal("/var/lib/planweave/projects").nullable(),
    trustedProjectRootPattern: z.literal("/var/lib/planweave/projects/<project-id>").nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const supported = value.state === "supported";
    if (
      supported !==
      (value.copyAction !== null &&
        value.preview !== null &&
        value.configInputPath !== null &&
        value.tlsDirectory !== null &&
        value.projectsRoot !== null &&
        value.projectsMountTarget !== null &&
        value.trustedProjectRootPattern !== null)
    ) {
      context.addIssue({ code: "custom", message: "compose_handoff_state_mismatch" });
    }
  });
export type DeploymentComposeHandoff = z.infer<typeof deploymentComposeHandoffSchema>;

export const deploymentCopyHandoffViewSchema = z
  .object({ state: z.literal("copied"), copiedAt: timestampSchema })
  .strict();
export type DeploymentCopyHandoffView = z.infer<typeof deploymentCopyHandoffViewSchema>;

export const deploymentActionScopeSchema = z
  .object({ workspace: workspaceScopeRefSchema, profile: deploymentConnectionProfileSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.workspace.workspaceId !== value.profile.workspace.workspaceId) {
      context.addIssue({ code: "custom", message: "deployment_action_workspace_mismatch" });
    }
  });

/**
 * Renderer actions are closed and reviewable. They never accept a command,
 * SSH target, secret, or provider/provisioning instruction.
 */
export const desktopDeploymentActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      target: deploymentTargetDraftSchema,
      action: z.literal("request_deployment_guidance")
    })
    .strict(),
  z
    .object({
      target: deploymentTargetDraftSchema,
      action: z.literal("copy_supported_compose_handoff")
    })
    .strict(),
  z
    .object({ target: deploymentTargetDraftSchema, action: z.literal("validate_connectivity") })
    .strict(),
  deploymentActionScopeSchema.extend({ action: z.literal("query_agent_host_availability") })
]);
export type DesktopDeploymentActionRequest = z.infer<typeof desktopDeploymentActionRequestSchema>;

export const deploymentGuidanceViewSchema = z
  .object({
    schemaVersion: deploymentTargetDraftSchemaVersionSchema,
    target: deploymentTargetDraftSchema,
    state: z.enum(["ready", "unavailable"]),
    requirements: deploymentOperationalRequirementsSchema,
    handoff: deploymentComposeHandoffSchema,
    generatedAt: timestampSchema,
    unavailableReason: z.enum(["not_supported", "not_authorized"]).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "ready") !== (value.unavailableReason === null)) {
      context.addIssue({ code: "custom", message: "deployment_guidance_state_reason_mismatch" });
    }
  });
export type DeploymentGuidanceView = z.infer<typeof deploymentGuidanceViewSchema>;

export const connectivityValidationViewSchema = z
  .object({
    schemaVersion: deploymentTargetDraftSchemaVersionSchema,
    target: deploymentTargetDraftSchema,
    endpoint: deploymentEndpointSchema,
    status: z.enum([
      "reachable",
      "unreachable",
      "invalid_tls",
      "invalid_origin",
      "invalid_configuration"
    ]),
    checkedAt: timestampSchema,
    failureCode: z
      .enum([
        "connection_failed",
        "http_not_ready",
        "tls_certificate_invalid",
        "allowed_client_origin_missing",
        "origin_rejected",
        "connectivity_validation_not_supported",
        "invalid_profile"
      ])
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const expectedCodes = {
      reachable: [null],
      unreachable: ["connection_failed", "http_not_ready"],
      invalid_tls: ["tls_certificate_invalid"],
      invalid_origin: ["allowed_client_origin_missing", "origin_rejected"],
      invalid_configuration: ["connectivity_validation_not_supported", "invalid_profile"]
    } as const;
    if (!expectedCodes[value.status].includes(value.failureCode as never)) {
      context.addIssue({ code: "custom", message: "connectivity_status_failure_mismatch" });
    }
  });
export type ConnectivityValidationView = z.infer<typeof connectivityValidationViewSchema>;

export const agentHostAvailabilityViewSchema = z
  .object({
    schemaVersion: deploymentConnectionSchemaVersionSchema,
    workspace: workspaceScopeRefSchema,
    hostId: opaqueIdentifierSchema,
    status: z.enum(["available", "unavailable"]),
    capabilities: capabilitiesSchema,
    workspaceMapping: z.object({ status: z.enum(["ready", "missing", "invalid"]) }).strict(),
    acpProfiles: z
      .array(
        z
          .object({
            profileId: opaqueIdentifierSchema,
            status: z.enum(["ready", "missing", "invalid"]),
            capabilities: capabilitiesSchema
          })
          .strict()
      )
      .min(1)
      .max(128),
    observedAt: timestampSchema,
    reason: z
      .enum([
        "offline",
        "at_capacity",
        "revoked",
        "capability_mismatch",
        "workspace_mapping_missing",
        "workspace_mapping_invalid",
        "acp_profile_missing",
        "acp_profile_invalid"
      ])
      .nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "available") !== (value.reason === null)) {
      context.addIssue({ code: "custom", message: "agent_host_availability_reason_mismatch" });
    }
    if (
      value.status === "available" &&
      (value.workspaceMapping.status !== "ready" ||
        !value.acpProfiles.some((profile) => profile.status === "ready"))
    ) {
      context.addIssue({
        code: "custom",
        message: "available_agent_host_requires_workspace_and_acp"
      });
    }
  });
export type AgentHostAvailabilityView = z.infer<typeof agentHostAvailabilityViewSchema>;

/** Ensures renderer-facing deployment views contain no credentials or execution material. */
export function assertDeploymentViewRedacted(value: unknown): void {
  const forbiddenKey =
    /^(?:credential(?:Sha256|Hash|Token)|token(?:Sha256|Hash|Token)?|secret|password|command|args|environment|env|ssh|shell|provider|billing|subscription|volume|sqlite|docker)$/i;
  const forbiddenValue =
    /\b(?:pw_setup_|pw_hdev_|pw_inv_|pw_enroll_|pw_host_|pw_operator_)[A-Za-z0-9_-]{10,}\b/;
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return forbiddenValue.test(current);
    if (Array.isArray(current)) return current.some(visit);
    if (!current || typeof current !== "object") return false;
    return Object.entries(current).some(([key, nested]) => forbiddenKey.test(key) || visit(nested));
  };
  if (visit(value)) throw new Error("deployment_view_not_redacted");
}
