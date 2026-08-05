import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { agentEndpointDisplayLabel, type AvailableAgentEndpoint } from "./agentEndpointViewModel";

export const inheritAgentEndpointValue = "__inherit_agent_endpoint";

export function AgentEndpointSelect({
  ariaLabel,
  disabled = false,
  endpoints,
  inheritLabel,
  onValueChange,
  selectedEndpointId,
  unavailableLabel,
  triggerClassName
}: {
  ariaLabel: string;
  disabled?: boolean;
  endpoints: readonly AvailableAgentEndpoint[];
  inheritLabel?: string;
  onValueChange: (endpointId: string) => void;
  selectedEndpointId: string;
  unavailableLabel: string;
  triggerClassName?: string;
}) {
  const selectedKnown =
    selectedEndpointId === inheritAgentEndpointValue ||
    endpoints.some((endpoint) => endpoint.id === selectedEndpointId);

  return (
    <Select disabled={disabled} onValueChange={onValueChange} value={selectedEndpointId}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={triggerClassName}
        onClick={(event) => event.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {inheritLabel ? (
            <SelectItem value={inheritAgentEndpointValue}>{inheritLabel}</SelectItem>
          ) : null}
          {!selectedKnown ? (
            <SelectItem disabled value={selectedEndpointId}>
              {unavailableLabel}
            </SelectItem>
          ) : null}
          {endpoints.map((endpoint) => (
            <SelectItem disabled={!endpoint.available} key={endpoint.id} value={endpoint.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span>{agentEndpointDisplayLabel(endpoint)}</span>
                {!endpoint.available ? (
                  <span className="text-xs text-muted-foreground">
                    {endpoint.unavailableReason ?? unavailableLabel}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
