import type {
  OperatorHostAvailabilityReason,
  OperatorHostView
} from "@planweave-ai/distributed-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { createTranslator } from "../i18n";

type HostAvailabilityCardProps = {
  hosts: OperatorHostView[];
  loading: boolean;
  onRefresh: () => void;
  t: ReturnType<typeof createTranslator>;
};

function availabilityReason(host: OperatorHostView): "ready" | OperatorHostAvailabilityReason {
  if (host.availability.status === "available") return "ready";
  if (host.availability.reason === null) {
    throw new Error("operator_host_availability_reason_missing");
  }
  return host.availability.reason;
}

function profileSummary(host: OperatorHostView, t: ReturnType<typeof createTranslator>): string {
  const profiles = host.readinessObservation?.acpProfiles ?? [];
  return profiles.length === 0
    ? "—"
    : profiles
        .map((profile) => `${profile.profileId}: ${t(`hostAvailabilityProfile_${profile.status}`)}`)
        .join(", ");
}

/** Server-composed Host readiness without exposing target-machine configuration details. */
export function HostAvailabilityCard({ hosts, loading, onRefresh, t }: HostAvailabilityCardProps) {
  return (
    <Card data-testid="host-availability">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{t("hostAvailabilityTitle")}</CardTitle>
            <CardDescription>{t("hostAvailabilityDescription")}</CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="host-availability-refresh"
            disabled={loading}
            onClick={onRefresh}
          >
            {t("hostAdminRefresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {hosts.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="host-availability-empty">
            {t("hostAvailabilityEmpty")}
          </p>
        ) : (
          <ul className="grid gap-2" aria-label={t("hostAvailabilityTitle")}>
            {hosts.map((host) => {
              const reason = availabilityReason(host);
              return (
                <li
                  className="grid gap-1 rounded-md border border-border/80 bg-surface-muted/30 p-3 text-sm"
                  data-testid={`host-availability-${host.id}`}
                  key={host.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-text-strong">{host.displayName}</span>
                    <span
                      className={reason === "ready" ? "text-emerald-600" : "text-destructive"}
                      data-testid={`host-availability-status-${host.id}`}
                    >
                      {t(`hostAvailability_${reason}`)}
                    </span>
                  </div>
                  <div className="text-xs text-text-muted">
                    {t("hostAvailabilityWorkspace")}: {host.workspaceId} ·{" "}
                    {t("hostAvailabilityProfiles")}: {profileSummary(host, t)}
                  </div>
                  {reason !== "ready" ? (
                    <p className="text-xs text-text-muted">
                      {t(`hostAvailabilityAction_${reason}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
