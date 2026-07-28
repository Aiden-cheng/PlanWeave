import {
  assertDeploymentViewRedacted,
  connectivityValidationViewSchema,
  deploymentCopyHandoffViewSchema,
  deploymentOriginHeader,
  desktopDeploymentActionRequestSchema,
  deploymentActionScopeSchema,
  deploymentGuidanceViewSchema,
  deploymentConnectionProfileSchema,
  type DeploymentConnectionProfile,
  type DeploymentGuidanceView,
  type ConnectivityValidationView
} from "@planweave-ai/collaboration-contracts";

const composePreview =
  "PLANWEAVE_SERVER_CONFIG_PATH=./server.json PLANWEAVE_SERVER_TLS_DIRECTORY=./tls PLANWEAVE_SERVER_PROJECTS_ROOT=./projects docker compose -f packages/server/compose.yaml up --detach --wait";

type DeploymentActionScope = {
  workspace: { workspaceId: string };
  profile: DeploymentConnectionProfile;
};

export type DeploymentActionsOptions = {
  request?: typeof fetch;
  writeClipboard?: (value: string) => void;
  now?: () => Date;
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function requirements(profile: DeploymentConnectionProfile) {
  return {
    durableState: "required" as const,
    healthcheck: { required: true as const },
    publicIngress:
      profile.endpoint.topology === "public_https"
        ? { tls: "direct" as const, port: 443 as const }
        : null
  };
}

function handoff(profile: DeploymentConnectionProfile) {
  if (profile.endpoint.topology === "loopback_http") {
    return {
      state: "not_applicable" as const,
      copyAction: null,
      preview: null,
      configInputPath: null,
      tlsDirectory: null,
      projectsRoot: null,
      projectsMountTarget: null,
      trustedProjectRootPattern: null
    };
  }
  return {
    state: "supported" as const,
    copyAction: "copy_supported_compose_handoff" as const,
    preview: composePreview,
    configInputPath: "./server.json" as const,
    tlsDirectory: "./tls" as const,
    projectsRoot: "./projects" as const,
    projectsMountTarget: "/var/lib/planweave/projects" as const,
    trustedProjectRootPattern: "/var/lib/planweave/projects/<project-id>" as const
  };
}

function assertGuidanceCapability(profile: DeploymentConnectionProfile): void {
  if (!profile.capabilities.includes("deployment_guidance")) {
    throw new Error("deployment_guidance_not_supported");
  }
}

const tlsFailureCodes = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

function isKnownTlsFailure(error: unknown): boolean {
  const candidates = [
    error,
    error && typeof error === "object" && "cause" in error ? error.cause : null
  ];
  return candidates.some((candidate) =>
    Boolean(
      candidate &&
        typeof candidate === "object" &&
        "code" in candidate &&
        typeof candidate.code === "string" &&
        tlsFailureCodes.has(candidate.code)
    )
  );
}

function scopeFromAction(
  input: unknown,
  expectedAction:
    | "request_deployment_guidance"
    | "copy_supported_compose_handoff"
    | "validate_connectivity"
): DeploymentActionScope {
  const action = desktopDeploymentActionRequestSchema.parse(input);
  if (action.action !== expectedAction) throw new Error("deployment_action_mismatch");
  return deploymentActionScopeSchema.parse({
    workspace: action.workspace,
    profile: action.profile
  });
}

/** Main-owned deployment actions. The renderer supplies only a validated, closed profile scope. */
export class DeploymentActions {
  private readonly request: typeof fetch;
  private readonly writeClipboard?: (value: string) => void;
  private readonly now: () => Date;

  constructor(options: DeploymentActionsOptions = {}) {
    this.request = options.request ?? fetch;
    this.writeClipboard = options.writeClipboard;
    this.now = options.now ?? (() => new Date());
  }

  guidance(input: unknown): DeploymentGuidanceView {
    const scope = scopeFromAction(input, "request_deployment_guidance");
    assertGuidanceCapability(scope.profile);
    const view = deploymentGuidanceViewSchema.parse({
      schemaVersion: "deployment-connection/v1",
      workspace: scope.workspace,
      profileId: scope.profile.profileId,
      state: "ready",
      requirements: requirements(scope.profile),
      handoff: handoff(scope.profile),
      generatedAt: nowIso(this.now),
      unavailableReason: null
    });
    assertDeploymentViewRedacted(view);
    return view;
  }

  copyComposeHandoff(input: unknown): { state: "copied"; copiedAt: string } {
    const scope = scopeFromAction(input, "copy_supported_compose_handoff");
    assertGuidanceCapability(scope.profile);
    const generated = handoff(scope.profile);
    if (generated.copyAction === null || generated.preview === null) {
      throw new Error("deployment_compose_handoff_not_supported");
    }
    if (!this.writeClipboard) throw new Error("deployment_clipboard_unavailable");
    this.writeClipboard(generated.preview);
    return deploymentCopyHandoffViewSchema.parse({ state: "copied", copiedAt: nowIso(this.now) });
  }

  async validateConnectivity(input: unknown): Promise<ConnectivityValidationView> {
    const parsed = desktopDeploymentActionRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("deployment_connection_invalid_configuration");
    }
    if (parsed.data.action !== "validate_connectivity") {
      throw new Error("deployment_action_mismatch");
    }
    const scope = deploymentActionScopeSchema.parse({
      workspace: parsed.data.workspace,
      profile: parsed.data.profile
    });
    const profile = deploymentConnectionProfileSchema.parse(scope.profile);
    const checkedAt = nowIso(this.now);
    const base = {
      schemaVersion: "deployment-connection/v1" as const,
      workspace: scope.workspace,
      profileId: profile.profileId,
      endpoint: profile.endpoint,
      checkedAt
    };
    if (!profile.capabilities.includes("connectivity_validation")) {
      return connectivityValidationViewSchema.parse({
        ...base,
        status: "invalid_configuration",
        failureCode: "connectivity_validation_not_supported"
      });
    }
    const origin = deploymentOriginHeader(profile.endpoint);
    if (!origin) {
      return connectivityValidationViewSchema.parse({
        ...base,
        status: "invalid_origin",
        failureCode: "allowed_client_origin_missing"
      });
    }
    try {
      const response = await this.request(new URL("/readyz", profile.endpoint.serverOrigin), {
        headers: { Origin: origin },
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        return connectivityValidationViewSchema.parse({
          ...base,
          status: "unreachable",
          failureCode: "http_not_ready"
        });
      }
      const view = connectivityValidationViewSchema.parse({
        ...base,
        status: "reachable",
        failureCode: null
      });
      assertDeploymentViewRedacted(view);
      return view;
    } catch (error) {
      const view = connectivityValidationViewSchema.parse({
        ...base,
        status: isKnownTlsFailure(error) ? "invalid_tls" : "unreachable",
        failureCode: isKnownTlsFailure(error) ? "tls_certificate_invalid" : "connection_failed"
      });
      assertDeploymentViewRedacted(view);
      return view;
    }
  }
}
