import { randomUUID } from "node:crypto";
import {
  canvasCommandOperationIdSchema,
  canvasCommandSubmissionIntentSchema,
  opaqueIdentifierSchema,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import {
  collaborationCanvasSessionInputSchema,
  type CollaborationCanvasSessionInput
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { ResolvedCollaborationCanvasBinding } from "./ContentVersionFacade.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CanvasCommandSessionSnapshot } from "./canvasCommandSession.js";
import {
  LocalCanvasCommandMaterializer,
  type LocalCanvasCommandBinding
} from "./LocalCanvasCommandMaterializer.js";

export const collaborationCanvasCommandSubmitInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    intent: canvasCommandSubmissionIntentSchema
  })
  .strict();
export type CollaborationCanvasCommandSubmitInput = z.infer<
  typeof collaborationCanvasCommandSubmitInputSchema
>;

export const collaborationCanvasReconnectInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    afterRevision: z.number().int().nonnegative().optional(),
    afterContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CollaborationCanvasReconnectInput = z.infer<
  typeof collaborationCanvasReconnectInputSchema
>;

/** Public result of a canvas command submit (no secrets). */
export type CollaborationCanvasCommandSubmitResult = {
  outcome: CanvasCommandOutcome;
  session: CanvasCommandSessionSnapshot | null;
};

/** Public result of canvas reconnect (no secrets). */
export type CollaborationCanvasReconnectResult = {
  response: CanvasReconnectResponse;
  entriesToApply: CanvasJournalEntry[];
  snapshotRequired: boolean;
  session: CanvasCommandSessionSnapshot | null;
};

export type CollaborationCanvasCommandSessionView = CanvasCommandSessionSnapshot | null;

type CanvasCommandClientPort = Pick<
  CollaborationClient,
  | "projectId"
  | "submitCanvasCommand"
  | "reconnectCanvasCommands"
  | "fetchContentVersion"
  | "bindCanvasCommandSession"
  | "canvasCommandSession"
>;

type CanvasCommandMaterializerPort = Pick<
  LocalCanvasCommandMaterializer,
  "bind" | "currentDigest" | "materializeAccepted" | "materializeReconnect"
>;

function requireClient(client: CanvasCommandClientPort | null): CanvasCommandClientPort {
  if (!client) {
    throw new CollaborationClientError({
      kind: "aborted",
      code: "collaboration_session_not_connected",
      message: "Collaboration session is not connected."
    });
  }
  return client;
}

/**
 * Service-facing seam for durable canvas commands.
 * Keeps command/read-model boundaries out of the monolithic service body.
 */
export class CollaborationCanvasCommandFacade {
  private binding: {
    local: LocalCanvasCommandBinding;
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null = null;

  constructor(
    private readonly resolveClient: () => CanvasCommandClientPort | null,
    private readonly resolveCanvasBinding: (
      input: CollaborationCanvasSessionInput
    ) => Promise<ResolvedCollaborationCanvasBinding | null>,
    private readonly materializer: CanvasCommandMaterializerPort =
      new LocalCanvasCommandMaterializer(),
    private readonly recoverAuthoritativeContent?: (input: {
      localProjectId: string;
      localCanvasId: string;
    }) => Promise<void>
  ) {}

  async submit(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    const parsed = collaborationCanvasCommandSubmitInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const localBinding = this.requireLocalBinding(client, parsed.canvasId);
    const operationId = canvasCommandOperationIdSchema.parse(
      `op-${randomUUID().replace(/-/g, "").slice(0, 24)}`
    );
    const outcome = await client.submitCanvasCommand(
      {
        canvasId: parsed.canvasId,
        operationId,
        intent: parsed.intent as CanvasCommandIntent,
        expectedRevision: undefined
      },
      undefined,
      {
        beforeAccepted: (accepted, intent) =>
          this.materializer.materializeAccepted(localBinding, accepted, intent)
      }
    );
    return {
      outcome,
      session: client.canvasCommandSession()
    };
  }

  async reconnect(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    const parsed = collaborationCanvasReconnectInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    let localBinding = this.requireLocalBinding(client, parsed.canvasId);
    const reconnect = (binding: LocalCanvasCommandBinding) =>
      client.reconnectCanvasCommands(
        {
          canvasId: parsed.canvasId,
          afterRevision: parsed.afterRevision,
          afterContentDigest: parsed.afterContentDigest ?? binding.expectedContentDigest
        },
        undefined,
        {
          beforeReconnect: async (materialization) => {
            const snapshotContent =
              materialization.response.type === "canvas.reconnect.snapshot" &&
              (await this.materializer.currentDigest(binding)) !==
                materialization.response.snapshot.metadata.contentDigest
                ? (
                    await client.fetchContentVersion({
                      scope: materialization.response.snapshot.metadata.scope,
                      content: materialization.response.snapshot.content
                    })
                  ).content
                : undefined;
            await this.materializer.materializeReconnect(binding, {
              ...materialization,
              ...(snapshotContent === undefined ? {} : { snapshotContent })
            });
          }
        }
      );
    let result;
    try {
      result = await reconnect(localBinding);
    } catch (error) {
      if (
        !(error instanceof CollaborationClientError) ||
        error.code !== "collaboration_canvas_snapshot_materialization_required" ||
        !this.recoverAuthoritativeContent
      ) {
        throw error;
      }
      await this.recoverAuthoritativeContent({
        localProjectId: localBinding.projectId,
        localCanvasId: localBinding.canvasId
      });
      const current = this.binding;
      if (
        !current ||
        current.remoteCanvasId !== parsed.canvasId ||
        current.remoteProjectId !== client.projectId
      ) {
        throw new CollaborationClientError({
          kind: "aborted",
          code: "collaboration_canvas_local_binding_required",
          message: "collaboration_canvas_local_binding_required",
          retryable: false
        });
      }
      localBinding = await this.materializer.bind({
        projectId: localBinding.projectId,
        canvasId: localBinding.canvasId,
        authorityProjectId: current.remoteProjectId
      });
      this.binding = { ...current, local: localBinding };
      result = await reconnect(localBinding);
    }
    return {
      response: result.response,
      entriesToApply: result.entriesToApply,
      snapshotRequired: result.snapshotRequired,
      session: result.session
    };
  }

  async bind(input: unknown): Promise<CollaborationCanvasCommandSessionView> {
    const parsed = collaborationCanvasSessionInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const resolved = await this.resolveCanvasBinding(parsed);
    if (
      !resolved ||
      resolved.localProjectId !== parsed.localProjectId ||
      resolved.localCanvasId !== parsed.canvasId ||
      resolved.remoteProjectId !== client.projectId
    ) {
      this.binding = null;
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_scope_unmapped",
        message: "collaboration_canvas_scope_unmapped",
        retryable: false
      });
    }
    const local = await this.materializer.bind({
      projectId: resolved.localProjectId,
      canvasId: resolved.localCanvasId,
      authorityProjectId: resolved.remoteProjectId
    });
    this.binding = {
      local,
      remoteProjectId: resolved.remoteProjectId,
      remoteCanvasId: resolved.remoteCanvasId
    };
    client.bindCanvasCommandSession(resolved.remoteCanvasId);
    return client.canvasCommandSession();
  }

  session(): CollaborationCanvasCommandSessionView {
    const client = this.resolveClient();
    return client?.canvasCommandSession() ?? null;
  }

  private requireLocalBinding(
    client: CanvasCommandClientPort,
    canvasId: string
  ): LocalCanvasCommandBinding {
    const binding = this.binding;
    if (
      !binding ||
      binding.remoteCanvasId !== canvasId ||
      binding.remoteProjectId !== client.projectId
    ) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_local_binding_required",
        message: "collaboration_canvas_local_binding_required",
        retryable: false
      });
    }
    return binding.local;
  }
}
