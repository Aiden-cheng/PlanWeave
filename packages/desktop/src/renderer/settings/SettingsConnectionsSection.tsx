import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, ServerIcon, UsersIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import { collaborationBridge } from "../bridge";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { useHostAdministrationController } from "../hooks/useHostAdministrationController";
import type { createTranslator } from "../i18n";
import { SettingsServerSection, type SettingsServerSectionProps } from "./SettingsServerSection";

const HostAdministrationSection = lazy(() =>
  import("./HostAdministrationSection").then((module) => ({
    default: module.HostAdministrationSection
  }))
);

type ConnectionsTab = "overview" | "devices" | "advanced";

type SettingsConnectionsSectionProps = Omit<SettingsServerSectionProps, "t" | "showHeader"> & {
  diagnosticsEnabled?: boolean;
  t: ReturnType<typeof createTranslator>;
};

function StatusDot({ state }: { state: "ready" | "pending" | "error" | "idle" }) {
  const className =
    state === "ready"
      ? "bg-emerald-500"
      : state === "pending"
        ? "bg-amber-500"
        : state === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/45";
  return <span aria-hidden="true" className={`size-2 rounded-full ${className}`} />;
}

function ConnectionLayer({
  description,
  icon: Icon,
  label,
  state,
  status,
  testId
}: {
  description: string;
  icon: typeof ServerIcon;
  label: string;
  state: "ready" | "pending" | "error" | "idle";
  status: string;
  testId: string;
}) {
  return (
    <div
      className="min-w-0 flex-1 rounded-xl border border-border/80 bg-surface-raised px-4 py-4 shadow-sm"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <Icon className="size-4 text-text-muted" />
        {label}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <StatusDot state={state} />
        <span className="truncate text-sm text-text-strong">{status}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">{description}</p>
    </div>
  );
}

function ConnectionsOverview({
  onSelectTab,
  t
}: {
  onSelectTab: (tab: ConnectionsTab) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const { status, loading: workspaceLoading, error: workspaceError } = useCollaborationStatus();
  const hostController = useHostAdministrationController();
  const [exposure, setExposure] = useState<DesktopServerExposureView | null>(null);

  useEffect(() => {
    if (
      !collaborationBridge ||
      typeof collaborationBridge.getDesktopServerExposure !== "function"
    ) {
      return;
    }
    let cancelled = false;
    void collaborationBridge.getDesktopServerExposure().then(
      (next) => {
        if (!cancelled) setExposure(next);
      },
      () => {
        if (!cancelled) setExposure(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const activeWorkspaceProfile = status?.activeProfileId
    ? (status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null)
    : null;
  const remoteServerConnected = isCollaborationSessionConnected(status) && activeWorkspaceProfile;
  const serverState =
    exposure?.lifecycle === "ready" || remoteServerConnected
      ? "ready"
      : exposure?.lifecycle === "preparing"
        ? "pending"
        : exposure?.lifecycle === "error"
          ? "error"
          : "idle";
  const serverStatus = remoteServerConnected
    ? activeWorkspaceProfile.serverBaseUrl
    : exposure?.lifecycle === "ready"
      ? (exposure.advertisedOrigin ?? t("settingsConnectionsServerReady"))
      : exposure?.lifecycle === "preparing"
        ? t("settingsConnectionsServerPreparing")
        : exposure?.lifecycle === "error"
          ? t("settingsConnectionsServerError")
          : t("settingsConnectionsServerStopped");

  const workspaceConnection = status?.workspaceConnection;
  const workspaceConnected = isCollaborationSessionConnected(status);
  const workspaceState = workspaceError
    ? "error"
    : workspaceLoading || workspaceConnection?.status === "reconnecting"
      ? "pending"
      : workspaceConnected
        ? "ready"
        : "idle";
  const workspaceStatus = workspaceError
    ? t("settingsConnectionsWorkspaceError")
    : workspaceLoading || workspaceConnection?.status === "reconnecting"
      ? t("settingsConnectionsWorkspaceConnecting")
      : workspaceConnected
        ? (workspaceConnection?.workspaceDisplayName ?? t("settingsConnectionsWorkspaceConnected"))
        : workspaceConnection?.status === "local_only"
          ? t("settingsConnectionsWorkspaceLocal")
          : t("settingsConnectionsWorkspaceDisconnected");

  const activeHosts = useMemo(
    () => hostController.hosts.filter((host) => !host.revokedAt),
    [hostController.hosts]
  );
  const onlineHosts = activeHosts.filter((host) => host.online).length;
  const devicesState =
    hostController.error || hostController.loadState === "unavailable"
      ? "error"
      : hostController.loadState === "loading" || hostController.hostsLoading
        ? "pending"
        : onlineHosts > 0
          ? "ready"
          : "idle";
  const devicesStatus =
    hostController.error || hostController.loadState === "unavailable"
      ? t("settingsConnectionsDevicesUnavailable")
      : hostController.loadState === "loading" || hostController.hostsLoading
        ? t("settingsConnectionsDevicesLoading")
        : t("settingsConnectionsDevicesOnline")
            .replace("{online}", String(onlineHosts))
            .replace("{total}", String(activeHosts.length));

  return (
    <div className="flex flex-col gap-6" data-testid="settings-connections-overview">
      <div>
        <h2 className="text-base font-semibold text-text-strong">
          {t("settingsConnectionsOverviewTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">
          {t("settingsConnectionsOverviewDescription")}
        </p>
      </div>

      <div
        className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center"
        data-testid="settings-connections-rail"
      >
        <ConnectionLayer
          description={t("settingsConnectionsServerDescription")}
          icon={ServerIcon}
          label={t("settingsConnectionsServer")}
          state={serverState}
          status={serverStatus}
          testId="settings-connections-server-state"
        />
        <ArrowRightIcon className="mx-1 hidden size-4 shrink-0 text-text-muted/60 lg:block" />
        <ConnectionLayer
          description={t("settingsConnectionsWorkspaceDescription")}
          icon={UsersIcon}
          label={t("settingsConnectionsWorkspace")}
          state={workspaceState}
          status={workspaceStatus}
          testId="settings-connections-workspace-state"
        />
        <ArrowRightIcon className="mx-1 hidden size-4 shrink-0 text-text-muted/60 lg:block" />
        <ConnectionLayer
          description={t("settingsConnectionsDevicesDescription")}
          icon={WaypointsIcon}
          label={t("settingsConnectionsDevices")}
          state={devicesState}
          status={devicesStatus}
          testId="settings-connections-devices-state"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border/70 px-4 py-3">
          <Badge variant="secondary">{t("settingsConnectionsMemberScopeLabel")}</Badge>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            {t("settingsConnectionsMemberScope")}
          </p>
        </div>
        <div className="rounded-lg border border-border/70 px-4 py-3">
          <Badge variant="secondary">{t("settingsConnectionsOwnerFleetScopeLabel")}</Badge>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            {t("settingsConnectionsOwnerFleetScope")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onSelectTab("devices")}>
          {t("settingsConnectionsManageDevices")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onSelectTab("advanced")}>
          {t("settingsConnectionsManageAdvanced")}
        </Button>
      </div>
    </div>
  );
}

export function SettingsConnectionsSection({
  diagnosticsEnabled = false,
  t,
  ...serverProps
}: SettingsConnectionsSectionProps) {
  const [tab, setTab] = useState<ConnectionsTab>("overview");

  const selectTab = (value: string) => {
    if (value === "overview" || value === "devices" || value === "advanced") {
      setTab(value);
    }
  };

  return (
    <section className="flex flex-col gap-6" data-testid="settings-connections-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-strong">
          {t("settingsConnections")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
          {t("settingsConnectionsHint")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList variant="line" aria-label={t("settingsConnections")}>
          <TabsTrigger value="overview" data-testid="settings-connections-tab-overview">
            {t("settingsConnectionsOverview")}
          </TabsTrigger>
          <TabsTrigger value="devices" data-testid="settings-connections-tab-devices">
            {t("settingsConnectionsDevices")}
          </TabsTrigger>
          <TabsTrigger value="advanced" data-testid="settings-connections-tab-advanced">
            {t("settingsConnectionsAdvanced")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <ConnectionsOverview onSelectTab={setTab} t={t} />
        </TabsContent>
        <TabsContent value="devices" className="pt-4">
          <Suspense
            fallback={
              <div className="text-sm text-text-muted" data-testid="host-admin-loading">
                {t("hostAdminLoading")}
              </div>
            }
          >
            <HostAdministrationSection
              diagnosticsEnabled={diagnosticsEnabled}
              showDeploymentConnection={false}
              showHeader={false}
              t={t}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="advanced" className="pt-4">
          <SettingsServerSection {...serverProps} showHeader={false} t={t} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
