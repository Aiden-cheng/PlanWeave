import { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { DesktopCanvasReference } from "@planweave-ai/runtime";

export async function resolveDesktopCanvasReference(ref: DesktopCanvasReference) {
  return resolveTaskCanvasWorkspace(ref.projectRoot, ref.canvasId);
}
