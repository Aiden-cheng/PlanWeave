import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  completedContentVersionRefSchema,
  contentVersionAuthorityDiscoveryToDesktopReadModel,
  contentVersionDesktopLayoutMemberPath,
  contentVersionDesktopReadModelSchema,
  type CompleteContentVersion,
  type CompletedContentVersionRef,
  type ContentVersionDesktopReadModel
} from "@planweave-ai/collaboration-contracts";
import {
  capturePackageSnapshot,
  getDesktopLayout,
  getProjectOverview,
  listProjects,
  materializeAuthoritativeCanvasContent,
  resolveTaskCanvasWorkspace
} from "@planweave-ai/runtime";
import { z } from "zod";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

const canvasInputSchema = z.object({ canvasId: z.string().trim().min(1).max(128) }).strict();

type LocalCanvasBinding = { projectRoot: string; canvasId: string; expectedPackageDir: string };

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function unavailable(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "unknown", code, message: code, retryable });
}

/** Main-only authority workflow. Renderer receives only redacted content refs/read models. */
export class ContentVersionFacade {
  private binding: LocalCanvasBinding | null = null;
  private lastModel: ContentVersionDesktopReadModel | null = null;

  constructor(private readonly resolveClient: () => CollaborationClient | null) {}

  async bind(input: unknown): Promise<ContentVersionDesktopReadModel> {
    const { canvasId } = canvasInputSchema.parse(input);
    const client = this.requireClient();
    this.binding = await this.bindLocal(client.projectId, canvasId);
    return this.refresh();
  }

  async read(): Promise<ContentVersionDesktopReadModel | null> {
    return this.lastModel;
  }

  async refresh(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const local = await this.collect(binding);
    const discovered = await client.discoverContentAuthority({
      canvasId: binding.canvasId,
      localReplica: local.ref,
      knownRevision: this.lastModel?.authoritativeHead?.revision ?? null
    });
    this.lastModel = contentVersionDesktopReadModelSchema.parse(
      contentVersionAuthorityDiscoveryToDesktopReadModel(discovered)
    );
    return this.lastModel;
  }

  async publishInitial(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const local = await this.collect(binding);
    const published = await client.publishInitialContent({ canvasId: binding.canvasId, content: local.content });
    if (published.outcome !== "published") {
      throw unavailable(`content_initial_publish_${published.reason}`, published.retryable);
    }
    await client.acknowledgeContentVersion({ canvasId: binding.canvasId, content: published.version.completed });
    return this.refresh();
  }

  async materializeHead(): Promise<ContentVersionDesktopReadModel> {
    const client = this.requireClient();
    const binding = this.requireBinding(client);
    const model = await this.refresh();
    const head = model.authoritativeHead;
    if (!head || !model.canMaterialize) throw unavailable("content_materialization_not_available", false);
    const fetched = await client.fetchContentVersion({ canvasId: binding.canvasId, content: head.content });
    if (fetched.completed.versionId !== head.content.versionId || fetched.content.canonicalDigest !== head.content.canonicalDigest) {
      throw unavailable("content_authoritative_head_mismatch", false);
    }
    await materializeAuthoritativeCanvasContent({
      projectRoot: binding.projectRoot,
      canvasId: binding.canvasId,
      expectedPackageDir: binding.expectedPackageDir,
      content: fetched.content
    });
    await client.acknowledgeContentVersion({ canvasId: binding.canvasId, content: fetched.completed });
    return this.refresh();
  }

  private requireClient(): CollaborationClient {
    const client = this.resolveClient();
    if (!client) throw unavailable("collaboration_content_offline", true);
    return client;
  }

  private requireBinding(client: CollaborationClient): LocalCanvasBinding {
    if (!this.binding || this.binding.canvasId.length === 0) throw unavailable("content_canvas_binding_required", false);
    return this.binding;
  }

  private async bindLocal(projectId: string, canvasId: string): Promise<LocalCanvasBinding> {
    const matches = (await listProjects()).filter((project) => project.projectId === projectId);
    if (matches.length !== 1) throw unavailable("content_local_project_binding_invalid", false);
    const overview = await getProjectOverview(matches[0]!.rootPath);
    if (overview.projectId !== projectId) throw unavailable("content_local_project_binding_invalid", false);
    const workspace = await resolveTaskCanvasWorkspace(overview.rootPath, canvasId);
    return { projectRoot: overview.rootPath, canvasId, expectedPackageDir: workspace.packageDir };
  }

  private async collect(binding: LocalCanvasBinding): Promise<{
    content: CompleteContentVersion;
    ref: CompletedContentVersionRef;
  }> {
    const snapshot = await capturePackageSnapshot({ projectRoot: binding.projectRoot, canvasId: binding.canvasId });
    if (snapshot.resolvedPackageDir !== binding.expectedPackageDir) throw unavailable("content_local_package_binding_invalid", false);
    const workspace = await resolveTaskCanvasWorkspace(binding.projectRoot, binding.canvasId);
    const layout = await getDesktopLayout(workspace);
    const members = [
      ...snapshot.snapshot.files.map((file) => ({
        kind: file.path === "manifest.json" ? "manifest" as const : file.path.includes("/blocks/") ? "block_prompt" as const : "task_prompt" as const,
        path: file.path,
        content: file.content,
        digestSha256: file.digestSha256,
        sizeBytes: file.sizeBytes
      })),
      {
        kind: "desktop_layout" as const,
        path: contentVersionDesktopLayoutMemberPath,
        content: `${JSON.stringify(layout, null, 2)}\n`,
        digestSha256: "",
        sizeBytes: 0
      }
    ].map((member) => member.kind === "desktop_layout"
      ? { ...member, digestSha256: digest(member.content), sizeBytes: Buffer.byteLength(member.content, "utf8") }
      : member
    ).sort((left, right) => left.path.localeCompare(right.path));
    const totalBytes = members.reduce((total, member) => total + member.sizeBytes, 0);
    const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
    const content = completeContentVersionSchema.parse({
      ...provisional,
      canonicalDigest: digest(canonicalContentVersionDigestPayload(provisional))
    });
    return {
      content,
      ref: completedContentVersionRefSchema.parse({
        versionId: `version-${content.canonicalDigest}`,
        canonicalDigest: content.canonicalDigest,
        verification: "complete"
      })
    };
  }
}
