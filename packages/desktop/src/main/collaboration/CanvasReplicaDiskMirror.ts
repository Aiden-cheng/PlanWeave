import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  LocalCanvasCommandMaterializer,
  type LocalCanvasCommandBinding
} from "./LocalCanvasCommandMaterializer.js";
import type { CanvasReplicaCommittedSnapshot, CanvasReplicaScope } from "./CanvasReplicaStore.js";

type CanvasReplicaMaterializerPort = Pick<
  LocalCanvasCommandMaterializer,
  "bind" | "materializeConfirmed"
>;

function sameScope(left: CanvasReplicaScope, right: CanvasReplicaScope): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.localProjectId === right.localProjectId &&
    left.localCanvasId === right.localCanvasId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/**
 * Serializes server-confirmed replica snapshots to the imported local canvas.
 * Optimistic state never crosses this boundary and online command success never waits on disk I/O.
 */
export class CanvasReplicaDiskMirror {
  private binding: {
    scope: CanvasReplicaScope;
    local: Promise<LocalCanvasCommandBinding>;
  } | null = null;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private lastError: unknown = null;

  constructor(
    private readonly materializer: CanvasReplicaMaterializerPort = new LocalCanvasCommandMaterializer()
  ) {}

  async bind(scope: CanvasReplicaScope): Promise<void> {
    const generation = ++this.generation;
    this.lastError = null;
    const previous = this.tail;
    const local = previous.then(() =>
      this.materializer.bind({
        projectId: scope.localProjectId,
        canvasId: scope.localCanvasId,
        authorityProjectId: scope.projectId
      })
    );
    const binding = { scope, local };
    this.binding = binding;
    this.tail = local.then(
      () => undefined,
      (error) => {
        if (generation === this.generation && this.binding === binding) this.lastError = error;
      }
    );
    await this.tail;
  }

  capture(snapshot: CanvasReplicaCommittedSnapshot): void {
    const binding = this.binding;
    if (!binding || !sameScope(binding.scope, snapshot.scope)) return;
    const generation = this.generation;
    const input: { content: CompleteContentVersion; contentDigest: string } = {
      content: snapshot.content,
      contentDigest: snapshot.contentDigest
    };
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || this.binding !== binding) return;
      try {
        await this.materializer.materializeConfirmed(await binding.local, input);
        if (generation === this.generation) this.lastError = null;
      } catch (error) {
        if (generation === this.generation) this.lastError = error;
      }
    });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.lastError) throw this.lastError;
  }

  clear(): void {
    this.generation += 1;
    this.binding = null;
  }
}
