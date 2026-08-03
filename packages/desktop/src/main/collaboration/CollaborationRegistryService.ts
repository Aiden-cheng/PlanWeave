import {
  canvasAccessPageSchema,
  createPackageSnapshotResultSchema,
  packageSnapshotSchema,
  projectAccessPageSchema,
  registryClientCommandSchema,
  restorePackageSnapshotResultSchema,
  type CanvasAccessPage,
  type CreatePackageSnapshotResult,
  type PackageSnapshot,
  type ProjectAccessPage,
  type RestorePackageSnapshotResult
} from "@planweave-ai/collaboration-protocol";
import { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError, collaborationErrorFromUnknown } from "./collaborationErrors.js";

type RegistryClientResolver = () => CollaborationClient | null;

function commandInput(operation: string, input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { operation, ...(input as Record<string, unknown>) };
  }
  return { operation, invalidInput: input };
}

/** Main-process registry orchestration; it never exposes the raw client or transport. */
export class CollaborationRegistryService {
  constructor(private readonly resolveClient: RegistryClientResolver) {}

  private activeClient(): CollaborationClient {
    const client = this.resolveClient();
    if (!client) {
      throw new CollaborationClientError({
        kind: "offline",
        code: "collaboration_session_inactive",
        message: "No active collaboration session. Connect a profile before loading registry data.",
        retryable: false
      });
    }
    return client;
  }

  private async run<T>(operation: (client: CollaborationClient) => Promise<T>): Promise<T> {
    try {
      return await operation(this.activeClient());
    } catch (error) {
      throw collaborationErrorFromUnknown(error);
    }
  }

  async listAuthorizedProjects(input: unknown = {}): Promise<ProjectAccessPage> {
    const command = registryClientCommandSchema.parse(
      commandInput("list_authorized_projects", input)
    );
    if (command.operation !== "list_authorized_projects")
      throw new Error("registry_operation_invalid");
    const { operation: _operation, ...request } = command;
    return this.run(async (client) =>
      projectAccessPageSchema.parse(await client.registry().listProjects(request))
    );
  }

  async listAuthorizedCanvases(input: unknown): Promise<CanvasAccessPage> {
    const command = registryClientCommandSchema.parse(
      commandInput("list_authorized_canvases", input)
    );
    if (command.operation !== "list_authorized_canvases")
      throw new Error("registry_operation_invalid");
    const { operation: _operation, ...request } = command;
    return this.run(async (client) =>
      canvasAccessPageSchema.parse(await client.registry().listCanvases(request))
    );
  }

  async readSnapshot(input: unknown): Promise<PackageSnapshot> {
    const command = registryClientCommandSchema.parse(commandInput("read_snapshot", input));
    if (command.operation !== "read_snapshot") throw new Error("registry_operation_invalid");
    const { operation: _operation, ...request } = command;
    return this.run(async (client) =>
      packageSnapshotSchema.parse(await client.registry().readSnapshot(request))
    );
  }

  async createSnapshot(input: unknown): Promise<CreatePackageSnapshotResult> {
    const command = registryClientCommandSchema.parse(commandInput("create_snapshot", input));
    if (command.operation !== "create_snapshot") throw new Error("registry_operation_invalid");
    const { operation: _operation, ...request } = command;
    return this.run(async (client) =>
      createPackageSnapshotResultSchema.parse(await client.registry().createSnapshot(request))
    );
  }

  async restoreSnapshot(input: unknown): Promise<RestorePackageSnapshotResult> {
    const command = registryClientCommandSchema.parse(commandInput("restore_snapshot", input));
    if (command.operation !== "restore_snapshot") throw new Error("registry_operation_invalid");
    const { operation: _operation, ...request } = command;
    return this.run(async (client) =>
      restorePackageSnapshotResultSchema.parse(await client.registry().restoreSnapshot(request))
    );
  }
}

export type { RegistryClientResolver };
