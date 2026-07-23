import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AgentEndpointSelect,
  inheritAgentEndpointValue
} from "../collaboration/AgentEndpointSelect";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";

type ExecutorSaveStatus = "idle" | "saving" | "saved" | "error";

export function TaskWorkspaceExecutorSelect({
  className,
  compact = false,
  endpoints,
  inheritLabel,
  label,
  labels,
  onSave,
  selectedEndpointId,
  selectedUnknownLabel,
  unavailableLabel
}: {
  className?: string;
  compact?: boolean;
  endpoints: readonly AvailableAgentEndpoint[];
  inheritLabel?: string;
  label: string;
  labels: { saved: string; saving: string };
  onSave: (endpointId: string | null) => Promise<void>;
  selectedEndpointId: string | null;
  selectedUnknownLabel?: string;
  unavailableLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ExecutorSaveStatus>("idle");
  const selectedValue = selectedEndpointId ?? inheritAgentEndpointValue;
  const [displayedValue, setDisplayedValue] = useState(selectedValue);

  useEffect(() => {
    setDisplayedValue(selectedValue);
    setError(null);
    setStatus("idle");
  }, [selectedValue]);

  const save = async (value: string) => {
    setDisplayedValue(value);
    setError(null);
    setStatus("saving");
    try {
      await onSave(value === inheritAgentEndpointValue ? null : value);
      setStatus("saved");
    } catch (caught: unknown) {
      setDisplayedValue(selectedValue);
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
    }
  };

  return (
    <div
      className={cn("min-w-0", className)}
      data-testid={`task-workspace-executor-select:${label}`}
    >
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        {label}
      </div>
      <AgentEndpointSelect
        ariaLabel={label}
        disabled={status === "saving"}
        endpoints={endpoints}
        inheritLabel={inheritLabel}
        onValueChange={(value) => void save(value)}
        selectedEndpointId={displayedValue}
        selectedUnknownLabel={selectedUnknownLabel}
        triggerClassName={cn("w-full", compact && "h-8 text-xs")}
        unavailableLabel={unavailableLabel}
      />
      {status === "saving" ? (
        <p className="mt-1 text-xs text-text-muted" role="status">
          {labels.saving}
        </p>
      ) : status === "saved" ? (
        <p className="mt-1 text-xs text-primary" role="status">
          {labels.saved}
        </p>
      ) : error ? (
        <p className="mt-1 max-w-72 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
