import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type {
  RemoteBlockRuntimeResolverPort,
  RemoteRuntimeLocator
} from "./remoteBlockCoordinatorPorts.js";

function locatorKey(locator: RemoteRuntimeLocator): string {
  return `${locator.projectId}\0${locator.canvasId}`;
}

export class RemoteRuntimePortRegistry implements RemoteBlockRuntimeResolverPort {
  private readonly ports = new Map<
    string,
    { runtime: RemoteBlockRuntimePort; artifacts?: RemoteBlockArtifactSource }
  >();

  bind(
    locator: RemoteRuntimeLocator,
    runtime: RemoteBlockRuntimePort,
    artifacts?: RemoteBlockArtifactSource
  ): () => void {
    const key = locatorKey(locator);
    if (this.ports.has(key)) throw new Error("remote_runtime_locator_already_bound");
    const binding = { runtime, artifacts };
    this.ports.set(key, binding);
    return () => {
      if (this.ports.get(key) === binding) this.ports.delete(key);
    };
  }

  resolve(locator: RemoteRuntimeLocator): RemoteBlockRuntimePort {
    const binding = this.ports.get(locatorKey(locator));
    if (!binding) {
      throw new Error(`remote_runtime_locator_unresolved:${locator.projectId}:${locator.canvasId}`);
    }
    return binding.runtime;
  }

  resolveArtifactSource(locator: RemoteRuntimeLocator): RemoteBlockArtifactSource {
    const binding = this.ports.get(locatorKey(locator));
    if (!binding) {
      throw new Error(`remote_runtime_locator_unresolved:${locator.projectId}:${locator.canvasId}`);
    }
    if (!binding.artifacts) {
      throw new Error(
        `remote_runtime_artifact_source_unresolved:${locator.projectId}:${locator.canvasId}`
      );
    }
    return binding.artifacts;
  }
}
