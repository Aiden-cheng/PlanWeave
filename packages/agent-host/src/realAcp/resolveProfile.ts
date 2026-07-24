import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ResolvedAgentHostAcpProfile } from "../execution/remoteAcpPorts.js";
import type { RealAcpGate, RealAcpPrecondition } from "./gate.js";
import { precondition } from "./gate.js";
import {
  findSupportedHostAcpProfile,
  listSupportedHostAcpProfiles,
  type SupportedHostAcpProfile
} from "./supportedProfiles.js";

export type ResolvedRealAcpHostProfile = {
  supported: SupportedHostAcpProfile;
  hostProfile: ResolvedAgentHostAcpProfile;
  commandPath: string;
  versionOutput: string | null;
};

export type ResolveRealAcpOutcome =
  | { status: "resolved"; profile: ResolvedRealAcpHostProfile }
  | { status: "precondition"; precondition: RealAcpPrecondition };

async function pathExistsExecutable(candidate: string): Promise<string | null> {
  try {
    const resolved = isAbsolute(candidate) ? await realpath(candidate) : candidate;
    await access(resolved, constants.X_OK);
    return isAbsolute(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function which(command: string, pathEnv: string | undefined): Promise<string | null> {
  if (isAbsolute(command)) {
    return pathExistsExecutable(command);
  }
  const directories = (pathEnv ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = join(directory, command);
    const resolved = await pathExistsExecutable(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function collectEnvironment(
  profile: SupportedHostAcpProfile,
  env: Readonly<Record<string, string | undefined>>
): { env: Record<string, string>; missingRequired: string[] } {
  const resolved: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const entry of profile.environment) {
    const value = env[entry.name];
    if (value === undefined || value.length === 0) {
      if (entry.required) missingRequired.push(entry.name);
      continue;
    }
    resolved[entry.name] = value;
  }
  return { env: resolved, missingRequired };
}

export async function resolveRealAcpHostProfile(options: {
  gate: RealAcpGate;
  env?: Readonly<Record<string, string | undefined>>;
  pathEnv?: string;
}): Promise<ResolveRealAcpOutcome> {
  const env = options.env ?? process.env;
  const pathEnv = options.pathEnv ?? env.PATH;
  const gate = options.gate;

  if (!gate.enabled) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "gate_disabled",
        "Real ACP gate is disabled. Set PLANWEAVE_REAL_ACP=1 (soft) or PLANWEAVE_REAL_ACP_REQUIRE=1 (hard)."
      )
    };
  }

  const catalog = listSupportedHostAcpProfiles();
  let selected: SupportedHostAcpProfile | undefined;
  if (gate.preferredProfileId) {
    selected = findSupportedHostAcpProfile(gate.preferredProfileId);
    if (!selected) {
      return {
        status: "precondition",
        precondition: precondition(
          gate.mode,
          "profile_unsupported",
          `Unsupported Host-local ACP profile '${gate.preferredProfileId}'. Supported: ${catalog
            .map((profile) => profile.profileId)
            .join(", ")}.`,
          gate.preferredProfileId
        )
      };
    }
  } else {
    for (const candidate of catalog) {
      const commandPath = await which(candidate.command, pathEnv);
      if (commandPath) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      return {
        status: "precondition",
        precondition: precondition(
          gate.mode,
          "binary_missing",
          `No supported real ACP agent binary found on PATH. Tried: ${catalog
            .map((profile) => profile.command)
            .join(", ")}. Install one supported agent and complete its login outside PlanWeave.`
        )
      };
    }
  }

  const commandPath = await which(selected.command, pathEnv);
  if (!commandPath) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "binary_missing",
        `ACP executable '${selected.command}' for profile '${selected.profileId}' was not found or is not executable.`,
        selected.profileId
      )
    };
  }

  const { env: profileEnv, missingRequired } = collectEnvironment(selected, env);
  if (missingRequired.length > 0) {
    return {
      status: "precondition",
      precondition: precondition(
        gate.mode,
        "credential_missing",
        `Required environment variable(s) missing for '${selected.profileId}': ${missingRequired.join(
          ", "
        )}. Values are never logged.`,
        selected.profileId
      )
    };
  }

  return {
    status: "resolved",
    profile: {
      supported: selected,
      commandPath,
      versionOutput: null,
      hostProfile: {
        agentId: selected.agentId,
        launch: { command: commandPath, args: [...selected.args] },
        env: profileEnv
      }
    }
  };
}
