import {
  CollaborationReadModelController,
  type CollaborationReadBridgePort
} from "./CollaborationReadModelController.js";

type HubEntry = {
  controller: CollaborationReadModelController;
  refCount: number;
};

/**
 * One CollaborationReadModelController per read-bridge port.
 * Surfaces subscribe via useSyncExternalStore; they never open observer
 * sockets and never create per-card controllers.
 */
const hubs = new WeakMap<CollaborationReadBridgePort, HubEntry>();

export function acquireCollaborationReadModelController(
  api: CollaborationReadBridgePort
): {
  controller: CollaborationReadModelController;
  release: () => void;
} {
  let entry = hubs.get(api);
  if (!entry) {
    entry = {
      controller: new CollaborationReadModelController({ api }),
      refCount: 0
    };
    hubs.set(api, entry);
  }
  entry.refCount += 1;
  let released = false;
  return {
    controller: entry.controller,
    release: () => {
      if (released) return;
      released = true;
      const current = hubs.get(api);
      if (!current || current.controller !== entry!.controller) return;
      current.refCount -= 1;
      if (current.refCount <= 0) {
        current.controller.dispose();
        hubs.delete(api);
      }
    }
  };
}

/** Test helper: force-drop a hub entry after isolated suite work. */
export function resetCollaborationReadModelHubForTests(
  api: CollaborationReadBridgePort | null | undefined
): void {
  if (!api) return;
  const entry = hubs.get(api);
  if (!entry) return;
  entry.controller.dispose();
  hubs.delete(api);
}
