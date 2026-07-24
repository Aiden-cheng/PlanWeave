import { z } from "zod";
import { agentHostProtocolVersion, agentHostProtocolVersionSchema } from "./version.js";

/**
 * Shared compatibility policy for PlanWeave distributed components.
 *
 * Wire protocol is a single supported literal (`agentHostProtocolVersion`).
 * Server and Agent Host package versions must share the same major before
 * operators ship a supported matrix; incompatible majors are rejected closed
 * at the release gate and must not be dispatched as a mixed fleet.
 *
 * ACP Agent compatibility is protocol-level: the Host negotiates ACP protocol
 * version via `@agentclientprotocol/sdk` and fails closed on mismatch (no CLI
 * fallback). Verified adapter pins are informational; newer patches are ok
 * when negotiation succeeds.
 */

export const packageVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Invalid semantic package version.");

export type PackageVersion = z.infer<typeof packageVersionSchema>;

export type PackageRole = "server" | "agent-host" | "distributed-protocol";

export type CompatibilityBounds = {
  /** Sole supported Agent Host ↔ Server wire protocol version. */
  agentHostProtocolVersion: typeof agentHostProtocolVersion;
  /**
   * Package majors that may be mixed only when equal.
   * Patch/minor drift within the same major is allowed for hotfix rollback.
   */
  packageMajorMustMatch: readonly PackageRole[];
  /**
   * Downgrade/rollback within the same major is permitted after state backup.
   * Crossing a package major requires a coordinated cutover and is not a
   * silent in-place rollback.
   */
  gracefulPackageDowngrade: "same-major-only";
  /**
   * Rollback must never wipe Server/Host SQLite state or silently re-dispatch
   * interrupted Blocks. Operators resume/retry through explicit lifecycle
   * actions only.
   */
  rollbackConstraints: {
    resetDatabases: false;
    silentRerunInterruptedBlocks: false;
    requireStateBackupBeforeUpgrade: true;
    requireCredentialRevocationOnHostReplace: true;
  };
};

export const PLANWEAVE_COMPATIBILITY_BOUNDS: CompatibilityBounds = {
  agentHostProtocolVersion,
  packageMajorMustMatch: ["server", "agent-host", "distributed-protocol"],
  gracefulPackageDowngrade: "same-major-only",
  rollbackConstraints: {
    resetDatabases: false,
    silentRerunInterruptedBlocks: false,
    requireStateBackupBeforeUpgrade: true,
    requireCredentialRevocationOnHostReplace: true
  }
};

export type CompatibilityCheckResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function parsePackageMajor(version: string): number {
  const parsed = packageVersionSchema.parse(version);
  const major = Number(parsed.split(".", 1)[0]);
  if (!Number.isSafeInteger(major) || major < 0) {
    throw new Error(`package_version_major_invalid:${version}`);
  }
  return major;
}

/**
 * Reject wire protocol versions that are not the sole supported literal.
 * Call before enqueueing or accepting execute_block / host.hello paths that
 * already parse through Zod; this helper is for explicit gate/error codes.
 */
export function assertAgentHostProtocolCompatible(
  protocolVersion: unknown
): CompatibilityCheckResult {
  const result = agentHostProtocolVersionSchema.safeParse(protocolVersion);
  if (result.success) return { ok: true };
  return {
    ok: false,
    code: "protocol_version_incompatible",
    message: `Unsupported Agent Host protocol version (supported=${agentHostProtocolVersion}).`
  };
}

/**
 * Server / Agent Host / protocol package majors must match before a supported
 * release matrix is declared. Different majors are fail-closed for dispatch
 * readiness even if wire protocol still happens to parse.
 */
export function assertMatchingPackageMajors(versions: {
  server: string;
  agentHost: string;
  protocol?: string;
}): CompatibilityCheckResult {
  let serverMajor: number;
  let hostMajor: number;
  try {
    serverMajor = parsePackageMajor(versions.server);
    hostMajor = parsePackageMajor(versions.agentHost);
  } catch (error) {
    return {
      ok: false,
      code: "package_version_invalid",
      message: error instanceof Error ? error.message : "Invalid package version."
    };
  }
  if (serverMajor !== hostMajor) {
    return {
      ok: false,
      code: "package_major_mismatch",
      message: `Server major ${serverMajor} is incompatible with Agent Host major ${hostMajor}.`
    };
  }
  if (versions.protocol !== undefined) {
    let protocolMajor: number;
    try {
      protocolMajor = parsePackageMajor(versions.protocol);
    } catch (error) {
      return {
        ok: false,
        code: "package_version_invalid",
        message: error instanceof Error ? error.message : "Invalid protocol package version."
      };
    }
    if (protocolMajor !== serverMajor) {
      return {
        ok: false,
        code: "package_major_mismatch",
        message: `distributed-protocol major ${protocolMajor} is incompatible with Server major ${serverMajor}.`
      };
    }
  }
  return { ok: true };
}

/**
 * Same-major package downgrade is the only graceful rollback path.
 * Cross-major rollback requires a planned cutover, not an in-place restart.
 */
export function assertGracefulPackageDowngrade(options: {
  fromVersion: string;
  toVersion: string;
}): CompatibilityCheckResult {
  let fromMajor: number;
  let toMajor: number;
  try {
    fromMajor = parsePackageMajor(options.fromVersion);
    toMajor = parsePackageMajor(options.toVersion);
  } catch (error) {
    return {
      ok: false,
      code: "package_version_invalid",
      message: error instanceof Error ? error.message : "Invalid package version."
    };
  }
  if (fromMajor !== toMajor) {
    return {
      ok: false,
      code: "package_downgrade_major_forbidden",
      message: `Graceful downgrade only within major ${fromMajor}; target major ${toMajor} requires coordinated cutover.`
    };
  }
  return { ok: true };
}
