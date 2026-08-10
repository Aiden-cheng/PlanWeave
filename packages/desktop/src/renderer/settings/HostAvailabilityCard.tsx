import type {
  OperatorHostAvailabilityReason,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type HostAvailabilityCardProps = {
  busy: boolean;
  hosts: OperatorHostView[];
  loading: boolean;
  onRefresh: () => void;
  onRevoke: (host: OperatorHostView) => void;
  t: ReturnType<typeof createTranslator>;
};

function availabilityReason(host: OperatorHostView): "ready" | OperatorHostAvailabilityReason {
  if (host.availability.status === "available") return "ready";
  if (host.availability.reason === null) {
    throw new Error("operator_host_availability_reason_missing");
  }
  return host.availability.reason;
}

function agentNames(host: OperatorHostView): string[] {
  return [
    ...new Set(
      (host.readinessObservation?.acpProfiles ?? [])
        .filter((profile) => profile.status === "ready")
        .map((profile) => profile.displayName)
    )
  ];
}

export function HostAvailabilityCard({
  busy,
  hosts,
  loading,
  onRefresh,
  onRevoke,
  t
}: HostAvailabilityCardProps) {
  const activeHosts = hosts.filter((host) => !host.revokedAt);

  return (
    <section className="border-b border-border/70 py-8" data-testid="host-availability">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
            {t("hostAvailabilityTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">
            {t("hostAvailabilityDescription")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="host-availability-refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("hostAdminRefresh")}
        </Button>
      </div>
      <div className="mt-5">
        {activeHosts.length === 0 ? (
          <div className="py-6" data-testid="host-availability-empty">
            <p className="text-sm font-medium text-text-strong">{t("hostAvailabilityEmpty")}</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-text-muted">
              {t("hostAvailabilityEmptyHint")}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60" aria-label={t("hostAvailabilityTitle")}>
            {activeHosts.map((host) => {
              const reason = availabilityReason(host);
              const agents = agentNames(host);
              return (
                <li className="py-4" data-testid={`host-availability-${host.id}`} key={host.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-2 rounded-full ${
                            reason === "ready" ? "bg-emerald-500" : "bg-text-muted/50"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium text-text-strong">
                          {host.displayName}
                        </span>
                        <span
                          className={
                            reason === "ready"
                              ? "text-xs font-medium text-emerald-600"
                              : "text-xs text-text-muted"
                          }
                          data-testid={`host-availability-status-${host.id}`}
                        >
                          {t(`hostAvailability_${reason}`)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                        {agents.length > 0 ? (
                          agents.map((agent) => (
                            <span className="text-xs text-text-strong" key={agent}>
                              {agent}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-text-muted">
                            {t("hostAvailabilityNoAgents")}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-text-muted hover:text-destructive"
                      data-testid={`host-admin-revoke-${host.id}`}
                      disabled={busy}
                      onClick={() => onRevoke(host)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      {t("hostAdminRevoke")}
                    </Button>
                  </div>
                  {reason !== "ready" ? (
                    <p className="mt-3 text-xs leading-5 text-text-muted">
                      {t(`hostAvailabilityAction_${reason}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
