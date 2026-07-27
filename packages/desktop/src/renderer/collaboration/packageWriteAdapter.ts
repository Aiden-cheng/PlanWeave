import type { CanvasCommandIntent } from "@planweave-ai/collaboration-contracts";
import type { SharedCanvasCommandsResult } from "../hooks/useSharedCanvasCommands";

/**
 * Shared-mode package write gate.
 * When `enabled`, durable graph/package mutations must submit typed canvas command
 * intents and refresh from authoritative state — never call local package writers.
 */
export type SharedPackageWriteGate = SharedCanvasCommandsResult | null | undefined;

export type DurablePackageWriteResult = "shared" | "local" | "failed";

/**
 * Route one durable mutation: shared command path when connected, else local bridge write.
 * Guarantees the local writer is not invoked while `sharedCanvas.enabled` is true.
 */
export async function runDurablePackageWrite(options: {
  sharedCanvas: SharedPackageWriteGate;
  intent: CanvasCommandIntent;
  onError?: (message: string | null) => void;
  localWrite: () => Promise<void>;
}): Promise<DurablePackageWriteResult> {
  if (options.sharedCanvas?.enabled) {
    const result = await options.sharedCanvas.submit({ intent: options.intent });
    if (!result.ok) {
      options.onError?.(result.error);
      return "failed";
    }
    return "shared";
  }
  await options.localWrite();
  return "local";
}

/**
 * For mutations that lack a canvas command intent: refuse local package writes while shared.
 * Callers must not fall through to bridge package writers when this returns "shared_blocked".
 */
export async function runLocalOnlyWhenOffline(options: {
  sharedCanvas: SharedPackageWriteGate;
  onError?: (message: string | null) => void;
  unsupportedMessage: string;
  localWrite: () => Promise<void>;
}): Promise<"local" | "shared_blocked" | "failed"> {
  if (options.sharedCanvas?.enabled) {
    options.onError?.(options.unsupportedMessage);
    return "shared_blocked";
  }
  try {
    await options.localWrite();
    return "local";
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

/** Submit a shared intent only; returns false when shared mode is off or submit fails. */
export async function submitSharedPackageIntent(
  sharedCanvas: SharedPackageWriteGate,
  intent: CanvasCommandIntent,
  onError?: (message: string | null) => void
): Promise<boolean> {
  if (!sharedCanvas?.enabled) {
    return false;
  }
  const result = await sharedCanvas.submit({ intent });
  if (!result.ok) {
    onError?.(result.error);
    return false;
  }
  return true;
}
