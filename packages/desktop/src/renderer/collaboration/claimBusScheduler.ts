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

export type ScopeCompletionCheckOptions = {
  /**
   * Force a fresh collaboration runtime-status projection read before judging.
   * Used after claim-none / at_capacity so a lagging projection cannot false-idle a finished scope.
   */
  refresh?: boolean;
};

export type ScopeCompletionPort = {
  isSatisfied: (options?: ScopeCompletionCheckOptions) => Promise<boolean>;
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

type InFlightExecution = {
  settled: Promise<{ execution: InFlightExecution; error?: unknown }>;
};

function startInFlight(execute: () => Promise<void>): InFlightExecution {
  const execution = {} as InFlightExecution;
  execution.settled = execute().then(
    () => ({ execution }),
    (error: unknown) => ({ execution, error })
  );
  return execution;
}

async function settleNext(inFlight: Set<InFlightExecution>): Promise<void> {
  if (inFlight.size === 0) return;
  const outcome = await Promise.race([...inFlight].map((execution) => execution.settled));
  inFlight.delete(outcome.execution);
  if (outcome.error !== undefined) throw outcome.error;
}

/**
 * Claim-bus work-unit loop: dry-run claim order only, then route each unit.
 * Does not scan dispatchable projection or reimplement readiness.
 */
export async function runClaimBusScope(input: ClaimBusScopeInput): Promise<void> {
  const inFlight = new Set<InFlightExecution>();
  const start = (execute: () => Promise<void>) => {
    inFlight.add(startInFlight(execute));
  };

  while (!input.signal?.aborted) {
    if (inFlight.size === 0 && (await input.completion.isSatisfied())) {
      return;
    }

    const unit = await input.preview.previewNext(input.scope);

    if (unit.kind === "none") {
      if (inFlight.size > 0) {
        await settleNext(inFlight);
        continue;
      }
      // Projection may lag the just-finished unit; refresh before idle vs complete.
      if (await input.completion.isSatisfied({ refresh: true })) {
        return;
      }
      throw new Error(`claim_bus_idle:${unit.reason ?? "unknown"}`);
    }

    if (unit.kind === "blocked") {
      throw new Error(`claim_bus_blocked:${unit.reason}`);
    }

    if (unit.kind === "feedback") {
      start(() => input.feedback.execute(unit, input.signal));
      await settleNext(inFlight);
      continue;
    }

    if (unit.kind === "batch") {
      // Parallel dry-run may report retained in_progress holders as batch+at_capacity
      // (same as runAutoRunStep idle). Never re-dispatch those refs.
      if (unit.reason === "at_capacity") {
        if (inFlight.size > 0) {
          await settleNext(inFlight);
          continue;
        }
        if (await input.completion.isSatisfied({ refresh: true })) {
          return;
        }
        throw new Error("claim_bus_idle:at_capacity");
      }
      if (input.signal?.aborted) {
        throw new Error("claim_bus_cancelled");
      }
      for (const ref of unit.refs) {
        start(() => executeBlockRef(ref, input));
      }
      await settleNext(inFlight);
      continue;
    }

    start(() => executeBlockRef(unit.ref, input));
    await settleNext(inFlight);
  }

  throw new Error("claim_bus_cancelled");
}
