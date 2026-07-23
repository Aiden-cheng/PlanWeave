import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type {
  RemoteBlockRuntimeResolverPort,
  RemoteRuntimeLocator
} from "./remoteBlockCoordinatorPorts.js";

function locatorKey(locator: RemoteRuntimeLocator): string {
  return `${locator.projectId}\0${locator.canvasId}`;
}

export class RemoteRuntimePortRegistry implements RemoteBlockRuntimeResolverPort {
  private readonly ports = new Map<string, RemoteBlockRuntimePort>();

  bind(locator: RemoteRuntimeLocator, port: RemoteBlockRuntimePort): () => void {
    const key = locatorKey(locator);
    if (this.ports.has(key)) throw new Error("remote_runtime_locator_already_bound");
    this.ports.set(key, port);
    return () => {
      if (this.ports.get(key) === port) this.ports.delete(key);
    };
  }

  resolve(locator: RemoteRuntimeLocator): RemoteBlockRuntimePort {
    const port = this.ports.get(locatorKey(locator));
    if (!port) {
      throw new Error(`remote_runtime_locator_unresolved:${locator.projectId}:${locator.canvasId}`);
    }
    return port;
  }
}
