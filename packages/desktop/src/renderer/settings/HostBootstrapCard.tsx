import { useEffect, useMemo, useRef, useState } from "react";
import type { OperatorEnrollmentGrantResponse } from "@planweave-ai/distributed-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import type { OperatorProfileView } from "../../shared/operatorControl";

type HostBootstrapCardProps = {
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  createGrant: () => Promise<OperatorEnrollmentGrantResponse | null>;
  dismissGrant: () => void;
  grant: OperatorEnrollmentGrantResponse | null;
  t: ReturnType<typeof createTranslator>;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

function isAbsolutePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value.trim());
}

export function HostBootstrapCard({
  activeProfile,
  busy,
  createGrant,
  dismissGrant,
  grant,
  t
}: HostBootstrapCardProps) {
  const locale = t("hostAdminLocale");
  const [configPath, setConfigPath] = useState("/etc/planweave/agent-host.json");
  const [dataDirectory, setDataDirectory] = useState("/var/lib/planweave-agent-host");
  const [workspaceRoot, setWorkspaceRoot] = useState("/var/lib/planweave-agent-host/workspaces");
  const [hostDisplayName, setHostDisplayName] = useState(
    activeProfile?.displayName ?? "Agent Host"
  );
  const [capacity, setCapacity] = useState("1");
  const [capabilities, setCapabilities] = useState("linux.x64");
  const [copied, setCopied] = useState<string | null>(null);
  const grantSecretRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (grant && grantSecretRef.current) {
      grantSecretRef.current.focus();
      grantSecretRef.current.select();
    }
  }, [grant]);

  useEffect(() => {
    if (activeProfile && !grant) setHostDisplayName(activeProfile.displayName);
  }, [activeProfile, grant]);

  const coordinator = useMemo(() => {
    if (!activeProfile) return null;
    const url = new URL(activeProfile.serverBaseUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback) return null;
    return {
      url: activeProfile.serverBaseUrl,
      allowInsecureDevelopment: url.protocol === "http:" && loopback
    };
  }, [activeProfile]);

  const capabilityValues = useMemo(
    () =>
      capabilities
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [capabilities]
  );
  const parsedCapacity = Number(capacity);
  const configValidationError =
    !activeProfile || !coordinator
      ? "hostAdminBootstrapSecureCoordinator"
      : !isAbsolutePath(configPath) ||
          !isAbsolutePath(dataDirectory) ||
          !isAbsolutePath(workspaceRoot)
        ? "hostAdminBootstrapAbsolutePaths"
        : !hostDisplayName.trim()
          ? "hostAdminBootstrapHostName"
          : !Number.isInteger(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 128
            ? "hostAdminBootstrapCapacity"
            : capabilityValues.some((value) => !/^[a-z0-9][a-z0-9._:-]*$/.test(value))
              ? "hostAdminBootstrapCapabilities"
              : null;

  const bootstrapConfig = useMemo(() => {
    if (!grant || !activeProfile || !coordinator || configValidationError) return null;
    return JSON.stringify(
      {
        version: "agent-host-config/v1",
        coordinator,
        dataDirectory: dataDirectory.trim(),
        workspaceRoot: workspaceRoot.trim(),
        host: {
          displayName: hostDisplayName.trim(),
          capacity: parsedCapacity,
          capabilities: capabilityValues
        },
        workspaces: [],
        agentProfiles: []
      },
      null,
      2
    );
  }, [
    activeProfile,
    capabilityValues,
    configValidationError,
    coordinator,
    dataDirectory,
    grant,
    hostDisplayName,
    parsedCapacity,
    workspaceRoot
  ]);

  const bootstrapCommand = useMemo(() => {
    if (!grant || !bootstrapConfig) return null;
    const config = JSON.stringify(configPath.trim());
    const code = JSON.stringify(grant.enrollmentCode);
    return [
      `planweave-agent-host preflight --config ${config}`,
      `planweave-agent-host enroll --config ${config} --code ${code}`,
      `planweave-agent-host run --config ${config}`
    ].join("\n");
  }, [bootstrapConfig, configPath, grant]);

  const copyText = async (kind: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Card data-testid="host-admin-bootstrap">
      <CardHeader>
        <CardTitle>{t("hostAdminBootstrapTitle")}</CardTitle>
        <CardDescription>{t("hostAdminBootstrapDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-text-muted">{t("hostAdminBootstrapBoundary")}</p>
        <div className="grid gap-3 rounded-md border border-border/70 p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="host-admin-config-path">{t("hostAdminConfigPath")}</Label>
            <Input
              id="host-admin-config-path"
              data-testid="host-admin-config-path"
              value={configPath}
              onChange={(event) => setConfigPath(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-data-directory">{t("hostAdminDataDirectory")}</Label>
              <Input
                id="host-admin-data-directory"
                data-testid="host-admin-data-directory"
                value={dataDirectory}
                onChange={(event) => setDataDirectory(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-workspace-root">{t("hostAdminWorkspaceRoot")}</Label>
              <Input
                id="host-admin-workspace-root"
                data-testid="host-admin-workspace-root"
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-host-name">{t("hostAdminHostDisplayName")}</Label>
              <Input
                id="host-admin-host-name"
                data-testid="host-admin-host-name"
                value={hostDisplayName}
                onChange={(event) => setHostDisplayName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-capacity">{t("hostAdminHostCapacity")}</Label>
              <Input
                id="host-admin-capacity"
                data-testid="host-admin-capacity"
                type="number"
                min={1}
                max={128}
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-capabilities">{t("hostAdminHostCapabilities")}</Label>
              <Input
                id="host-admin-capabilities"
                data-testid="host-admin-capabilities"
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
                placeholder="linux.x64,codex"
              />
            </div>
          </div>
          <p className="text-xs text-text-muted">{t("hostAdminBootstrapListsEmpty")}</p>
          {configValidationError ? (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="host-admin-bootstrap-validation"
            >
              {t(configValidationError)}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          className="w-fit"
          data-testid="host-admin-create-grant"
          disabled={busy || !activeProfile?.hasOperatorCredential || Boolean(configValidationError)}
          onClick={() => void createGrant()}
        >
          {t("hostAdminCreateGrant")}
        </Button>
        {grant && bootstrapConfig && bootstrapCommand ? (
          <div
            className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
            data-testid="host-admin-grant-once"
            role="alertdialog"
            aria-labelledby="host-admin-grant-title"
          >
            <div id="host-admin-grant-title" className="font-medium text-text-strong">
              {t("hostAdminGrantOnceTitle")}
            </div>
            <p className="text-xs text-text-muted">
              {t("hostAdminGrantOnceWarning").replace(
                "{expiry}",
                formatDate(grant.expiresAt, locale)
              )}
            </p>
            <Label htmlFor="host-admin-grant-secret">{t("hostAdminEnrollmentSecret")}</Label>
            <Input
              ref={grantSecretRef}
              id="host-admin-grant-secret"
              data-testid="host-admin-enrollment-secret"
              readOnly
              value={grant.enrollmentCode}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                data-testid="host-admin-copy-grant"
                onClick={() => void copyText("grant", grant.enrollmentCode)}
              >
                {copied === "grant" ? t("hostAdminCopied") : t("hostAdminCopy")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="host-admin-close-grant"
                onClick={dismissGrant}
              >
                {t("hostAdminCloseGrant")}
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-bootstrap-config">{t("hostAdminBootstrapConfig")}</Label>
              <textarea
                id="host-admin-bootstrap-config"
                data-testid="host-admin-bootstrap-config"
                readOnly
                value={bootstrapConfig}
                rows={6}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                data-testid="host-admin-copy-config"
                onClick={() => void copyText("config", bootstrapConfig)}
              >
                {copied === "config" ? t("hostAdminCopied") : t("hostAdminCopyConfig")}
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-bootstrap-command">{t("hostAdminBootstrapCommand")}</Label>
              <textarea
                id="host-admin-bootstrap-command"
                data-testid="host-admin-bootstrap-command"
                readOnly
                value={bootstrapCommand}
                rows={2}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                data-testid="host-admin-copy-command"
                onClick={() => void copyText("command", bootstrapCommand)}
              >
                {copied === "command" ? t("hostAdminCopied") : t("hostAdminCopyCommand")}
              </Button>
            </div>
            <p className="text-xs text-text-muted">{t("hostAdminBootstrapHeartbeatNote")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
