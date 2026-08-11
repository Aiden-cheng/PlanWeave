import type { ActorRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type {
  AuthoritativeContentHead,
  AuthoritativeContentVersion,
  CompletedContentVersionRef,
  ContentVersionAcknowledgement
} from "@planweave-ai/collaboration-protocol/content/version";
import type { ContentVersionAuthorityDiscoveryResult } from "@planweave-ai/collaboration-protocol/content/authority";
import type { CanvasScopeKey } from "./repository.js";

/**
 * Application-facing authority capabilities. Adapters own persistence and any
 * transaction mechanics needed to bind a content head to an accepted command.
 */
export type ContentAuthorityStore = {
  persistImmutable(input: {
    scope: CanvasScopeKey;
    content: unknown;
    createdBy: ActorRef;
    createdAt?: string;
  }): AuthoritativeContentVersion;
  readVersion(
    scope: CanvasScopeKey,
    content: CompletedContentVersionRef
  ): AuthoritativeContentVersion;
  head(scope: CanvasScopeKey): AuthoritativeContentHead | null;
  publishInitial(input: { scope: CanvasScopeKey; content: unknown; createdBy: ActorRef }): {
    version: AuthoritativeContentVersion;
    head: AuthoritativeContentHead;
  };
  acknowledge(input: {
    scope: CanvasScopeKey;
    deviceSessionId: string;
    content: CompletedContentVersionRef;
    acknowledgedAt?: string;
  }): ContentVersionAcknowledgement;
  discoverAuthority(input: {
    scope: CanvasScopeKey;
    deviceSessionId: string;
    localReplica: CompletedContentVersionRef | null;
    knownRevision: number | null;
    isCanvasOwner: boolean;
  }): ContentVersionAuthorityDiscoveryResult;
};
