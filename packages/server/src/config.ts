import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  opaqueIdentifierSchema
} from "@planweave-ai/distributed-protocol";
import {
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS
} from "@planweave-ai/runtime";
import { z } from "zod";
import { operatorCredentialSchema } from "./operatorAuth.js";
import { trustedRuntimeProjectSchema } from "./runtimeProjectRegistry.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const DEFAULT_OPERATOR_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_OPERATOR_SESSION_TTL_MS = 60 * 60 * 1_000;
const MAX_OPERATOR_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute, "Path must be absolute.");
const bindHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => isIP(value) !== 0, {
    message: "Bind host must be an IPv4 or IPv6 literal."
  });

const serverLimitsSchema = z
  .object({
    busyTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
    leaseDurationMs: z.number().int().min(1_000).max(86_400_000).default(30_000),
    hostOfflineAfterMs: z.number().int().min(1_000).max(86_400_000).default(90_000),
    heartbeatIntervalMs: z.number().int().min(1_000).max(3_600_000).default(15_000),
    maxArtifactBytes: z
      .number()
      .int()
      .positive()
      .max(OUTPUT_MAX_ARTIFACT_BYTES)
      .default(OUTPUT_MAX_ARTIFACT_BYTES),
    maxWebSocketPayloadBytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024)
      .default(256 * 1024),
    eventRetentionMaxEvents: z
      .number()
      .int()
      .positive()
      .max(RUNNER_EVENT_RETENTION_MAX_EVENTS)
      .default(RUNNER_EVENT_RETENTION_MAX_EVENTS),
    eventRetentionMaxBytes: z
      .number()
      .int()
      .positive()
      .max(RUNNER_EVENT_RETENTION_MAX_BYTES)
      .default(RUNNER_EVENT_RETENTION_MAX_BYTES),
    shutdownTimeoutMs: z.number().int().min(100).max(60_000).default(5_000)
  })
  .strict();

const serverConfigInputSchema = z
  .object({
    version: z.literal("server-config/v1"),
    bind: z
      .object({
        host: bindHostSchema.default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(7_443)
      })
      .strict()
      .default({ host: "127.0.0.1", port: 7_443 }),
    publicUrl: z.url(),
    tls: z
      .object({ certificatePath: absolutePathSchema, privateKeyPath: absolutePathSchema })
      .strict()
      .optional(),
    allowInsecureDevelopment: z.boolean().default(false),
    dataDirectory: absolutePathSchema,
    trustedProjects: z.array(trustedRuntimeProjectSchema).min(1).max(256),
    operatorCredentials: z.array(operatorCredentialSchema).min(1).max(1_024),
    operatorSessionTtlMs: z
      .number()
      .int()
      .min(MIN_OPERATOR_SESSION_TTL_MS)
      .max(MAX_OPERATOR_SESSION_TTL_MS)
      .default(DEFAULT_OPERATOR_SESSION_TTL_MS),
    limits: serverLimitsSchema.default({
      busyTimeoutMs: 5_000,
      leaseDurationMs: 30_000,
      hostOfflineAfterMs: 90_000,
      heartbeatIntervalMs: 15_000,
      maxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
      maxWebSocketPayloadBytes: 256 * 1024,
      eventRetentionMaxEvents: RUNNER_EVENT_RETENTION_MAX_EVENTS,
      eventRetentionMaxBytes: RUNNER_EVENT_RETENTION_MAX_BYTES,
      shutdownTimeoutMs: 5_000
    })
  })
  .strict();

export const serverConfigSchema = serverConfigInputSchema
  .extend({ databasePath: absolutePathSchema })
  .strict()
  .superRefine((config, context) => {
    const publicUrl = new URL(config.publicUrl);
    if (
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== "/" ||
      publicUrl.search ||
      publicUrl.hash
    ) {
      context.addIssue({ code: "custom", message: "server_public_url_must_be_origin" });
    }
    if (config.allowInsecureDevelopment) {
      if (
        !["127.0.0.1", "::1"].includes(config.bind.host) ||
        publicUrl.protocol !== "http:" ||
        !literalLoopback(publicUrl.hostname) ||
        config.tls
      ) {
        context.addIssue({
          code: "custom",
          message: "server_insecure_development_requires_literal_loopback"
        });
      }
    } else {
      if (publicUrl.protocol !== "https:" || !config.tls) {
        context.addIssue({ code: "custom", message: "server_tls_configuration_required" });
      }
      const publicPort = Number(publicUrl.port || "443");
      if (publicPort !== config.bind.port) {
        context.addIssue({ code: "custom", message: "server_public_url_port_mismatch" });
      }
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.hostOfflineAfterMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_offline" });
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.leaseDurationMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_lease" });
    }
    const projectScopes = new Set(
      config.trustedProjects.map((project) => `${project.workspaceId}\0${project.projectId}`)
    );
    if (projectScopes.size !== config.trustedProjects.length) {
      context.addIssue({ code: "custom", message: "server_trusted_project_duplicate" });
    }
    if (config.databasePath !== join(config.dataDirectory, "planweave-server.sqlite")) {
      context.addIssue({ code: "custom", message: "server_database_path_mismatch" });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ServerStorageConfig = Pick<ServerConfig, "dataDirectory" | "databasePath"> & {
  busyTimeoutMs: number;
};

function literalLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseServerConfig(input: unknown): ServerConfig {
  const parsed = serverConfigInputSchema.parse(input);
  const publicUrl = new URL(parsed.publicUrl);
  return serverConfigSchema.parse({
    ...parsed,
    publicUrl: publicUrl.origin,
    databasePath: join(parsed.dataDirectory, "planweave-server.sqlite")
  });
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
  if (!isAbsolute(path)) throw new Error("server_config_path_must_be_absolute");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("server_config_too_large");
  try {
    return parseServerConfig(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("server_")) throw error;
    throw new Error("server_config_invalid", { cause: error });
  }
}

export function resolveServerConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configIndex = argv.indexOf("--config");
  if (configIndex >= 0) {
    const path = argv[configIndex + 1];
    if (!path || argv.length !== 2) throw new Error("server_cli_usage");
    return absolutePathSchema.parse(path);
  }
  if (argv.length !== 0) throw new Error("server_cli_usage");
  const path = env.PLANWEAVE_SERVER_CONFIG;
  if (!path) throw new Error("server_config_path_required");
  return absolutePathSchema.parse(path);
}

export const serverConfigSummarySchema = z
  .object({
    version: z.literal("server-config/v1"),
    bindHost: bindHostSchema,
    bindPort: z.number().int().min(1).max(65_535),
    publicUrl: z.url(),
    transport: z.enum(["https", "loopback-development"]),
    projectIds: z.array(opaqueIdentifierSchema).max(256)
  })
  .strict();

export function serverConfigSummary(config: ServerConfig) {
  return serverConfigSummarySchema.parse({
    version: config.version,
    bindHost: config.bind.host,
    bindPort: config.bind.port,
    publicUrl: config.publicUrl,
    transport: config.allowInsecureDevelopment ? "loopback-development" : "https",
    projectIds: config.trustedProjects.map((project) => project.projectId)
  });
}
