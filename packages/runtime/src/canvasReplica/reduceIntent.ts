import {
  canvasCommandIntentSchema,
  type CanvasCommandIntent
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import type { PlanPackageGraphMutationSideEffect } from "../graph/mutation.js";
import { parseCanvasReplicaDocument, type CanvasReplicaDocument } from "./document.js";

function applySideEffect(
  prompts: Map<string, string>,
  sideEffect: PlanPackageGraphMutationSideEffect
): void {
  if (sideEffect.kind === "writePrompt") {
    prompts.set(sideEffect.packagePath, sideEffect.markdown);
    return;
  }
  if (sideEffect.kind === "removePrompt") {
    prompts.delete(sideEffect.packagePath);
    return;
  }
  const prefix = `${sideEffect.packagePath}/`;
  for (const path of prompts.keys()) {
    if (path.startsWith(prefix)) prompts.delete(path);
  }
}

/** Pure, deterministic application of one accepted collaboration intent. */
export function applyCanvasReplicaIntent(
  input: CanvasReplicaDocument,
  rawIntent: CanvasCommandIntent
): CanvasReplicaDocument {
  const document = parseCanvasReplicaDocument(input);
  const intent = canvasCommandIntentSchema.parse(rawIntent);
  const application = buildCanvasCommandApplication(document.manifest, document.layout, intent);
  const prompts = new Map(Object.entries(document.promptMarkdownByPath));
  for (const sideEffect of application.graphMutation.sideEffects) {
    applySideEffect(prompts, sideEffect);
  }
  return parseCanvasReplicaDocument({
    schemaVersion: document.schemaVersion,
    manifest: application.graphMutation.nextManifest,
    promptMarkdownByPath: Object.fromEntries(prompts),
    layout: application.nextLayout
  });
}
