import {
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  getDirtyPromptRefs,
  refreshChangedDesktopPackagePrompts,
  refreshPackageFileChanges
} from "@planweave-ai/runtime";
import { resolveDesktopCanvasReference } from "./runtimeBridgeCanvasReference.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";

export const runtimeBridgePackageSyncHandlers = {
  createPackageFileSnapshot: async (_event, ref) =>
    createDesktopPackageFileSnapshot(await resolveDesktopCanvasReference(ref)),
  detectPackageFileChanges: async (_event, ref, snapshotId) =>
    detectDesktopPackageFileChanges(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshChangedPackagePrompts: async (_event, ref, snapshotId) =>
    refreshChangedDesktopPackagePrompts(await resolveDesktopCanvasReference(ref), snapshotId),
  refreshPackageFileChanges: async (_event, ref, options) =>
    refreshPackageFileChanges(await resolveDesktopCanvasReference(ref), options),
  getDirtyPromptRefs: async (_event, ref) =>
    getDirtyPromptRefs(await resolveDesktopCanvasReference(ref))
} satisfies Partial<RuntimeBridgeHandlerMap>;
