import type { OperatorEnrollmentGrantResponse } from "@planweave-ai/agent-host-protocol/operator-control";
import type {
  OperatorControlProfile,
  OperatorCopyHostBootstrapHandoffInput
} from "../../shared/operatorControl.js";

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `"'"'`)}'`;
}

/** Builds the clipboard-only Host bootstrap script while the enrollment code is still in main. */
export function buildHostBootstrapHandoff(
  profile: OperatorControlProfile,
  input: OperatorCopyHostBootstrapHandoffInput,
  grant: OperatorEnrollmentGrantResponse
): string {
  const coordinatorUrl = new URL(profile.serverBaseUrl);
  const loopback = coordinatorUrl.hostname === "127.0.0.1" || coordinatorUrl.hostname === "[::1]";
  const config = {
    version: "agent-host-config/v1",
    coordinator: {
      url: profile.serverBaseUrl,
      allowInsecureDevelopment: coordinatorUrl.protocol === "http:" && loopback
    },
    dataDirectory: input.bootstrap.dataDirectory,
    workspaceRoot: input.bootstrap.workspaceRoot,
    host: input.bootstrap.host,
    workspaces: [{ id: grant.workspaceId, path: input.bootstrap.workspacePath }],
    agentProfiles: []
  };
  const encodedConfig = Buffer.from(JSON.stringify(config, null, 2), "utf8").toString("base64");
  const configPath = quotePosixShellArgument(input.bootstrap.configPath);
  const enrollmentCode = quotePosixShellArgument(grant.enrollmentCode);

  return [
    `printf %s '${encodedConfig}' | base64 --decode > ${configPath}`,
    `planweave-agent-host config-init --config ${configPath} --preset ${input.bootstrap.acpProfilePreset}`,
    `planweave-agent-host preflight --config ${configPath}`,
    `planweave-agent-host enroll --config ${configPath} --code ${enrollmentCode}`,
    `planweave-agent-host run --config ${configPath}`
  ].join("\n");
}
