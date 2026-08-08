import type { ClaimResult, DesktopAutoRunScope } from "@planweave-ai/runtime";

export type ClaimPreviewPort = {
  previewNext: (scope: DesktopAutoRunScope) => Promise<ClaimResult>;
};

export type BlockExecutionPort = {
  execute: (ref: string, signal?: AbortSignal) => Promise<void>;
};

export type FeedbackExecutionPort = {
  execute: (
    claim: Extract<ClaimResult, { kind: "feedback" }>,
    signal?: AbortSignal
  ) => Promise<void>;
};

export type ScopeCompletionPort = {
  isSatisfied: () => Promise<boolean>;
};

export type EndpointRoutingPort = {
  routeForBlock: (ref: string) => "local" | "remote";
};

export type ClaimBusScopeInput = {
  scope: DesktopAutoRunScope;
  preview: ClaimPreviewPort;
  route: EndpointRoutingPort;
  localBlock: BlockExecutionPort;
  remoteBlock: BlockExecutionPort;
  feedback: FeedbackExecutionPort;
  completion: ScopeCompletionPort;
  signal?: AbortSignal;
};

async function executeBlockRef(ref: string, input: ClaimBusScopeInput): Promise<void> {
  const mode = input.route.routeForBlock(ref);
  if (mode === "remote") {
    await input.remoteBlock.execute(ref, input.signal);
    return;
  }
  if (mode === "local") {
    await input.localBlock.execute(ref, input.signal);
    return;
  }
  throw new Error(`claim_bus_route_missing:${ref}`);
}

/**
 * Claim-bus work-unit loop: dry-run claim order only, then route each unit.
 * Does not scan dispatchable projection or reimplement readiness.
 */
export async function runClaimBusScope(input: ClaimBusScopeInput): Promise<void> {
  while (!input.signal?.aborted) {
    if (await input.completion.isSatisfied()) {
      return;
    }

    const unit = await input.preview.previewNext(input.scope);

    if (unit.kind === "none") {
      if (await input.completion.isSatisfied()) {
        return;
      }
      throw new Error(`claim_bus_idle:${unit.reason ?? "unknown"}`);
    }

    if (unit.kind === "blocked") {
      throw new Error(`claim_bus_blocked:${unit.reason}`);
    }

    if (unit.kind === "feedback") {
      await input.feedback.execute(unit, input.signal);
      continue;
    }

    if (unit.kind === "batch") {
      // Parallel dry-run may report retained in_progress holders as batch+at_capacity
      // (same as runAutoRunStep idle). Never re-dispatch those refs.
      if (unit.reason === "at_capacity") {
        if (await input.completion.isSatisfied()) {
          return;
        }
        throw new Error("claim_bus_idle:at_capacity");
      }
      for (const ref of unit.refs) {
        if (input.signal?.aborted) {
          throw new Error("claim_bus_cancelled");
        }
        await executeBlockRef(ref, input);
      }
      continue;
    }

    await executeBlockRef(unit.ref, input);
  }

  throw new Error("claim_bus_cancelled");
}
