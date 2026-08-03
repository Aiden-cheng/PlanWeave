import type {
  ActorRef,
  CanvasCommandAccepted,
  CanvasCommandIntent,
  CompletedContentVersionRef,
  PackageSnapshotDigestManifest
} from "@planweave-ai/collaboration-protocol";
import type { CanvasScopeKey } from "./repository.js";

export type AuthoritativeCanvasAcceptedCommit = {
  scope: CanvasScopeKey;
  operationId: string;
  intent: CanvasCommandIntent;
  intentDigest: string;
  actor: ActorRef;
  previousRevision: number;
  expectedContentDigest?: string;
  revision: number;
  contentDigest: string;
  digestManifest?: PackageSnapshotDigestManifest;
  sizeBytes?: number;
  packageSnapshotId?: string;
};

/** Coordinates an immutable content head with an accepted canvas command. */
export type AuthoritativeCanvasCommitPort = {
  commit(input: {
    content: {
      scope: CanvasScopeKey;
      expectedRevision: number;
      version: CompletedContentVersionRef;
    };
    accepted: AuthoritativeCanvasAcceptedCommit;
  }): CanvasCommandAccepted;
};
