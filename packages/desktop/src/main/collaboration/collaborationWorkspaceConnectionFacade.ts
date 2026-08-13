import type {
  ActiveWorkspaceConnectionView,
  WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import {
  assertNoSmuggledCollaborationSecrets,
  collaborationProfileIdInputSchema,
  collaborationRedeemSetupCodeInputSchema,
  collaborationWorkspacePickerQuerySchema,
  type CollaborationSessionPhase,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import { collaborationErrorFromUnknown } from "./collaborationErrors.js";
import { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";

type SessionError = { code: string; message: string } | null;

export type CollaborationWorkspaceConnectionFacadeOptions = {
  connection: CollaborationWorkspaceConnection;
  publishStatus: () => Promise<CollaborationStatus>;
  setSession: (
    phase: CollaborationSessionPhase,
    detail: string | null,
    error?: SessionError
  ) => void;
};

function assertRedeemInputBoundary(input: unknown): void {
  if (!input || typeof input !== "object") {
    throw new Error("redeemCollaborationSetupCode requires an object payload.");
  }
  const record = input as Record<string, unknown>;
  for (const key of [
    "deviceToken",
    "encryptedDeviceToken",
    "operatorToken",
    "hostCredentialToken",
    "hostEnrollmentCode",
    "enrollmentCode",
    "projectRoot",
    "authorization",
    "Authorization",
    "credentialPath",
    "credentialsPath"
  ] as const) {
    if (key in record && record[key] !== undefined) {
      throw new Error(
        `Collaboration IPC rejected redeemCollaborationSetupCode: field "${key}" is not allowed.`
      );
    }
  }
}

/**
 * Main-process command seam for the single local-or-Workspace connection.
 * It owns setup-code parsing and connection lifecycle, while CollaborationService
 * continues to serialize commands and publish the wider read model.
 */
export class CollaborationWorkspaceConnectionFacade {
  private readonly connection: CollaborationWorkspaceConnection;
  private readonly publishStatus: () => Promise<CollaborationStatus>;
  private readonly setSession: CollaborationWorkspaceConnectionFacadeOptions["setSession"];

  constructor(options: CollaborationWorkspaceConnectionFacadeOptions) {
    this.connection = options.connection;
    this.publishStatus = options.publishStatus;
    this.setSession = options.setSession;
  }

  async redeemSetupCode(input: unknown): Promise<CollaborationStatus> {
    assertRedeemInputBoundary(input);
    const parsed = collaborationRedeemSetupCodeInputSchema.parse(input);
    try {
      await this.connection.redeemDeviceSetupCode({
        serverBaseUrl: parsed.serverBaseUrl,
        allowInsecureTransport: parsed.allowInsecureTransport,
        setupCode: parsed.setupCode,
        displayName: parsed.displayName,
        deviceLabel: parsed.deviceLabel
      });
      this.setSession("ready", "setup_code_redeemed", null);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "setup_code_redeem_failed", {
        code: mapped.code,
        message: mapped.message
      });
      throw mapped;
    }
    return this.publishStatus();
  }

  getActiveWorkspaceConnection(): Promise<ActiveWorkspaceConnectionView> {
    return this.connection.buildView();
  }

  listWorkspacePicker(input: unknown = {}): Promise<WorkspacePickerPage> {
    assertNoSmuggledCollaborationSecrets(input, "listWorkspacePicker");
    const query = collaborationWorkspacePickerQuerySchema.parse(input ?? {});
    return this.connection.buildPickerPage(query.cursor, query.limit);
  }

  async selectWorkspaceConnection(input: unknown): Promise<CollaborationStatus> {
    assertNoSmuggledCollaborationSecrets(input, "selectWorkspaceConnection");
    if (!input || typeof input !== "object") {
      throw new Error("selectWorkspaceConnection requires profileId or workspaceId.");
    }
    const record = input as Record<string, unknown>;
    try {
      if (typeof record.workspaceId === "string" && record.workspaceId.trim()) {
        await this.connection.selectWorkspaceByWorkspaceId(record.workspaceId.trim());
      } else {
        const { profileId } = collaborationProfileIdInputSchema.parse(input);
        await this.connection.selectWorkspace(profileId);
      }
      this.setSession("ready", "workspace_selected", null);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "workspace_select_failed", {
        code: mapped.code,
        message: mapped.message
      });
      throw mapped;
    }
    return this.publishStatus();
  }

  async connectWorkspaceConnection(): Promise<CollaborationStatus> {
    try {
      await this.connection.connectActiveProfile();
      this.setSession("ready", "workspace_connected", null);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "workspace_connect_failed", {
        code: mapped.code,
        message: mapped.message
      });
      throw mapped;
    }
    return this.publishStatus();
  }

  async disconnectWorkspaceConnection(): Promise<CollaborationStatus> {
    await this.connection.disconnectToLocalOnly();
    this.setSession("idle", "workspace_local_only", null);
    return this.publishStatus();
  }

  async retryWorkspaceConnection(): Promise<CollaborationStatus> {
    try {
      await this.connection.retry();
      this.setSession("ready", "workspace_retry_ok", null);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "workspace_retry_failed", {
        code: mapped.code,
        message: mapped.message
      });
      if (mapped.code === "collaboration_credential_missing") {
        return this.publishStatus();
      }
      throw mapped;
    }
    return this.publishStatus();
  }
}
