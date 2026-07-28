import {
  applyAuthorizedCanvasCommand,
  getProjectOverview,
  listProjects,
  readAuthorizedCanvasContentDigest,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import type {
  CanvasCommandAccepted,
  CanvasCommandIntent,
  CanvasJournalEntry,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-contracts";
import { CollaborationClientError } from "./collaborationErrors.js";

export type LocalCanvasCommandBinding = {
  projectId: string;
  projectRoot: string;
  canvasId: string;
  expectedPackageDir: string;
  expectedContentDigest: string;
};

function materializationError(code: string, retryable = true): CollaborationClientError {
  return new CollaborationClientError({
    kind: "unknown",
    code,
    message: code,
    retryable
  });
}

/**
 * Applies server-ordered typed canvas intents to the explicitly bound local canvas.
 * No server path, file payload, or client merge decision crosses this boundary.
 */
export class LocalCanvasCommandMaterializer {
  async bind(input: { projectId: string; canvasId: string }): Promise<LocalCanvasCommandBinding> {
    let registeredProjects;
    try {
      registeredProjects = (await listProjects()).filter(
        (candidate) => candidate.projectId === input.projectId
      );
    } catch {
      throw materializationError("collaboration_canvas_local_project_registry_unavailable", false);
    }
    if (registeredProjects.length !== 1) {
      throw materializationError(
        registeredProjects.length === 0
          ? "collaboration_canvas_local_project_not_registered"
          : "collaboration_canvas_local_project_ambiguous",
        false
      );
    }
    const registeredProject = registeredProjects[0]!;
    let project;
    try {
      project = await getProjectOverview(registeredProject.rootPath);
    } catch {
      throw materializationError("collaboration_canvas_local_project_unavailable", false);
    }
    if (project.projectId !== input.projectId || project.rootPath !== registeredProject.rootPath) {
      throw materializationError("collaboration_canvas_project_binding_mismatch", false);
    }

    let workspace;
    try {
      workspace = await resolveTaskCanvasWorkspace(project.rootPath, input.canvasId);
    } catch {
      throw materializationError("collaboration_canvas_not_declared_locally", false);
    }

    const binding: LocalCanvasCommandBinding = {
      projectId: input.projectId,
      projectRoot: project.rootPath,
      canvasId: input.canvasId,
      expectedPackageDir: workspace.packageDir,
      expectedContentDigest: ""
    };
    binding.expectedContentDigest = await this.readDigest(binding);
    return binding;
  }

  async materializeAccepted(
    binding: LocalCanvasCommandBinding,
    outcome: CanvasCommandAccepted,
    intent: CanvasCommandIntent
  ): Promise<void> {
    if (await this.isAlreadyAt(binding, outcome.contentDigest)) return;
    await this.apply(binding, intent, outcome.contentDigest);
  }

  async materializeReconnect(
    binding: LocalCanvasCommandBinding,
    input: {
      response: CanvasReconnectResponse;
      entriesToApply: CanvasJournalEntry[];
      snapshotRequired: boolean;
    }
  ): Promise<void> {
    if (input.response.type === "canvas.reconnect.error") return;
    if (input.snapshotRequired || input.response.type === "canvas.reconnect.snapshot") {
      throw materializationError("collaboration_canvas_snapshot_materialization_required");
    }

    const currentDigest = await this.readDigest(binding);
    if (currentDigest === input.response.headContentDigest) {
      binding.expectedContentDigest = currentDigest;
      return;
    }
    if (currentDigest !== binding.expectedContentDigest) {
      throw materializationError("collaboration_canvas_local_digest_diverged");
    }

    let start = 0;
    for (let index = 0; index < input.entriesToApply.length; index += 1) {
      if (input.entriesToApply[index]!.contentDigest === currentDigest) {
        start = index + 1;
      }
    }
    for (const entry of input.entriesToApply.slice(start)) {
      await this.apply(binding, entry.intent, entry.contentDigest);
    }
    if (binding.expectedContentDigest !== input.response.headContentDigest) {
      throw materializationError("collaboration_canvas_delta_materialization_incomplete");
    }
  }

  private async isAlreadyAt(binding: LocalCanvasCommandBinding, authoritativeDigest: string) {
    const currentDigest = await this.readDigest(binding);
    if (currentDigest === authoritativeDigest) {
      binding.expectedContentDigest = currentDigest;
      return true;
    }
    if (currentDigest !== binding.expectedContentDigest) {
      throw materializationError("collaboration_canvas_local_digest_diverged");
    }
    return false;
  }

  private async apply(
    binding: LocalCanvasCommandBinding,
    intent: CanvasCommandIntent,
    authoritativeDigest: string
  ): Promise<void> {
    const result = await applyAuthorizedCanvasCommand({
      projectRoot: binding.projectRoot,
      canvasId: binding.canvasId,
      expectedPackageDir: binding.expectedPackageDir,
      intent
    });
    if (!result.ok) {
      throw materializationError("collaboration_canvas_intent_materialization_failed");
    }
    if (result.contentDigest !== authoritativeDigest) {
      throw materializationError("collaboration_canvas_materialized_digest_mismatch");
    }
    binding.expectedContentDigest = result.contentDigest;
  }

  private async readDigest(binding: LocalCanvasCommandBinding): Promise<string> {
    const result = await readAuthorizedCanvasContentDigest({
      projectRoot: binding.projectRoot,
      canvasId: binding.canvasId,
      expectedPackageDir: binding.expectedPackageDir
    });
    if (!result.ok) {
      throw materializationError("collaboration_canvas_local_digest_unavailable");
    }
    return result.contentDigest;
  }
}
