import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import type { AgentHostConfig } from "../config/schema.js";
import { writePrivateJsonFile } from "../config/privateConfigWriter.js";
import {
  findSupportedHostAcpProfile,
  listSupportedHostAcpProfiles
} from "../realAcp/supportedProfiles.js";

const exposureDocumentSchema = z
  .object({
    version: z.literal("agent-host-exposure/v1"),
    profileIds: z.array(opaqueIdentifierSchema).max(128)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.profileIds).size !== value.profileIds.length) {
      context.addIssue({ code: "custom", message: "duplicate_exposed_agent_profile" });
    }
  });

function exposurePath(config: AgentHostConfig): string {
  return join(config.dataDirectory, "agent-exposure.json");
}

export async function readExposedAgentProfileIds(config: AgentHostConfig): Promise<string[]> {
  let input: string;
  try {
    input = await readFile(exposurePath(config), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const profileIds = config.agentProfiles.map((profile) => profile.id);
      await writeExposedAgentProfileIds(config, profileIds);
      return profileIds;
    }
    throw new Error("agent_host_exposure_config_invalid", { cause: error });
  }
  try {
    return exposureDocumentSchema.parse(JSON.parse(input)).profileIds;
  } catch (error) {
    throw new Error("agent_host_exposure_config_invalid", { cause: error });
  }
}

export async function writeExposedAgentProfileIds(
  config: AgentHostConfig,
  profileIds: readonly string[]
): Promise<void> {
  await writePrivateJsonFile(
    exposurePath(config),
    exposureDocumentSchema.parse({ version: "agent-host-exposure/v1", profileIds })
  );
}

export type AgentExposureStatus = {
  profileId: string;
  agentId: string;
  displayName: string;
  detected: boolean;
  exposed: boolean;
  ready: boolean;
};

export async function listAgentExposure(
  config: AgentHostConfig,
  resolveCommand: (command: string) => Promise<string>
): Promise<AgentExposureStatus[]> {
  const exposed = new Set(await readExposedAgentProfileIds(config));
  return Promise.all(
    listSupportedHostAcpProfiles().map(async (profile) => {
      let detected = false;
      try {
        await resolveCommand(profile.command);
        detected = true;
      } catch (error) {
        if (!(error instanceof Error && error.message === "agent_host_preset_binary_missing"))
          throw error;
      }
      const configured = config.agentProfiles.some(
        (candidate) => candidate.id === profile.profileId
      );
      return {
        profileId: profile.profileId,
        agentId: profile.agentId,
        displayName: profile.displayName,
        detected,
        exposed: exposed.has(profile.profileId),
        ready: detected && configured && exposed.has(profile.profileId)
      };
    })
  );
}

export function requireSupportedAgentProfile(profileId: string) {
  const profile = findSupportedHostAcpProfile(profileId);
  if (!profile) throw new Error("agent_host_agent_profile_unsupported");
  return profile;
}

export function parseAgentExposureProfileId(profileId: string): string {
  return opaqueIdentifierSchema.parse(profileId);
}
