export const agentEndpointRunEnCatalog = {
  claimBusBlockedError:
    "Claim bus stopped before the next unit ({reason}). Resolve the block condition, then run again. [{code}]",
  claimBusIdleError:
    "No claimable work remains, but this scope is not complete ({reason}). Wait for status sync or fix remaining blocks, then re-run. [{code}]",
  claimBusCancelledError: "Claim-bus run was cancelled. Start again when ready. [{code}]",
  claimBusRouteMissingError:
    "No local/remote route for block {block}. Re-select an Agent Endpoint for that block, then run again. [{code}]",
  localAgentUnitFailedError:
    "Local agent unit for {block} ended as {phase}. Inspect the Auto Run failure for that block, fix it, then re-run. [{code}]",
  localAgentRunNotStartedError:
    "Local Auto Run did not start for {block}. Check the Desktop Auto Run control, then try again. [{code}]",
  agentEndpointPreferenceMismatchError:
    "Endpoint binding for {block} no longer matches the package executor ({detail}). Re-select the Agent Endpoint in Desktop. [{code}]",
  agentEndpointSelectionMissingError:
    "No endpoint selection for {block}. Choose an Agent Endpoint, then run again. [{code}]",
  agentEndpointUnavailableError:
    "Endpoint “{endpoint}” is unavailable for {block} ({reason}). Fix availability or re-select the endpoint, then run again. [{code}]",
  agentEndpointUnknownError:
    "Saved remote endpoint for {block} is unknown ({endpoint}). Re-select an Agent Endpoint in Desktop. [{code}]",
  remoteAgentBlockFailedError:
    "Remote run for {block} ended as {state}. Check Host/operation details, then retry. [{code}]",
  remoteAgentFailureError:
    "{message} Fix the Host/remote failure for this block, then retry. [{code}]",
  collaborationRuntimeStatusUnavailableError:
    "Collaboration runtime status is unavailable. Reconnect or wait for projection sync, then re-run. [{code}]",
  collaborationRuntimeTaskStatusUnavailableError:
    "Collaboration status for task {task} is missing. Refresh the canvas or reconnect, then re-run. [{code}]"
} as const;
