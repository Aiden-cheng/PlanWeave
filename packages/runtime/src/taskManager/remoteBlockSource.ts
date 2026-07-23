import type { RuntimeContext } from "./runtimeContext.js";
import {
  remoteBlockSourceSnapshot,
  remoteDispatchAuthoritativeDependencies
} from "./remoteBlockSourceSnapshot.js";

export { remoteDispatchAuthoritativeDependencies };

export type RemoteBlockSourceEvidence = {
  sourceRevision: string;
  graphFingerprint: string;
};

export function sameRemoteBlockSource(
  left: RemoteBlockSourceEvidence,
  right: RemoteBlockSourceEvidence
): boolean {
  return (
    left.sourceRevision === right.sourceRevision && left.graphFingerprint === right.graphFingerprint
  );
}

/**
 * Fingerprint package inputs plus the dependency generations consumed by a dispatch.
 * Target status is intentionally excluded so preparation/activation do not invalidate it.
 */
export async function remoteBlockSourceEvidence(
  context: RuntimeContext,
  ref: string
): Promise<RemoteBlockSourceEvidence> {
  const snapshot = await remoteBlockSourceSnapshot(context, ref);
  return {
    sourceRevision: snapshot.sourceRevision,
    graphFingerprint: snapshot.graphFingerprint
  };
}
