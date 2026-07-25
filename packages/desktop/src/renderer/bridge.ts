import type {
  DesktopBridgeApi,
  DesktopCanvasReference,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";

export const bridge: DesktopBridgeApi | null =
  typeof window !== "undefined" && "planweave" in window ? window.planweave : null;
export const settingsBridge: PlanWeaveDesktopSettingsApi | null =
  typeof window !== "undefined" && "planweaveDesktopSettings" in window
    ? (window.planweaveDesktopSettings ?? null)
    : null;
export const collaborationBridge: PlanWeaveCollaborationApi | null =
  typeof window !== "undefined" && "planweaveCollaboration" in window
    ? (window.planweaveCollaboration ?? null)
    : null;

export function desktopCanvasReference(
  project: DesktopProjectSummary,
  canvasId?: string | null
): DesktopCanvasReference {
  return {
    projectRoot: project.rootPath,
    canvasId
  };
}
