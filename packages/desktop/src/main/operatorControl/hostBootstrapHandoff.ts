import type { OperatorEnrollmentGrantResponse } from "@planweave-ai/agent-host-protocol/operator-control";
import {
  serializeAgentHostSetupHandoff,
  type DeploymentEndpoint
} from "@planweave-ai/agent-host-protocol";
import type {
  OperatorControlProfile,
  OperatorCopyHostBootstrapHandoffInput
} from "../../shared/operatorControl.js";

/** Builds one portable command while the one-time code remains owned by Electron main. */
export function buildHostBootstrapHandoff(
  profile: OperatorControlProfile,
  _input: OperatorCopyHostBootstrapHandoffInput,
  grant: OperatorEnrollmentGrantResponse
): string {
  if (!profile.endpoint) throw new Error("operator_deployment_endpoint_required");
  const endpoint: DeploymentEndpoint = profile.endpoint;
  const handoff = serializeAgentHostSetupHandoff({
    version: "agent-host-setup/v1",
    endpoint,
    workspaceId: grant.workspaceId,
    enrollmentCode: grant.enrollmentCode,
    expiresAt: grant.expiresAt,
    display: {
      workspaceName: `Workspace ${grant.workspaceId}`,
      serverName: profile.displayName
    }
  });
  return `planweave-agent-host enroll ${handoff}`;
}
