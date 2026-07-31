import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type {
  PeopleDeviceRow,
  PeopleHostRow,
  PeopleInvitationRow,
  PeopleMemberRow,
  PeoplePanelMode,
  PeoplePresenceSummary
} from "../collaboration/peopleViewModels";
import type { CollaborationInvitationCreateView } from "../../shared/collaboration.js";
import { serializeCollaborationInvitationHandoff } from "./collaborationInvitationHandoff";

export type PeoplePanelProps = {
  mode: PeoplePanelMode;
  presence: PeoplePresenceSummary;
  members: PeopleMemberRow[];
  hosts: PeopleHostRow[];
  invitations: PeopleInvitationRow[];
  devices: PeopleDeviceRow[];
  detailsLoading: boolean;
  detailsError: string | null;
  actionError: string | null;
  actionBusy: boolean;
  pendingInvitation: CollaborationInvitationCreateView | null;
  invitationConnection?: { serverBaseUrl: string; projectId: string } | null;
  t: ReturnType<typeof createTranslator>;
  onCreateInvitation: () => Promise<CollaborationInvitationCreateView | null>;
  onCopyInvitationToken: (token: string) => Promise<void>;
  onDismissPendingInvitation: () => void;
  onRevokeInvitation: (invitationId: string) => Promise<boolean>;
  onRevokeInvitations: (invitationIds: readonly string[]) => Promise<boolean>;
  onPromoteMember: (humanPrincipalId: string) => Promise<boolean>;
  onDemoteMember: (humanPrincipalId: string) => Promise<boolean>;
  onRemoveMember: (humanPrincipalId: string) => Promise<boolean>;
  onRevokeDevice: (deviceCredentialId: string) => Promise<boolean>;
  onRefreshDetails: () => Promise<void>;
  /** Optional connect form when disconnected. */
  connectSlot?: ReactNode;
  /** Page shells may already expose the selected destination. */
  showTitle?: boolean;
};

function isLoopbackServer(serverBaseUrl: string): boolean {
  try {
    const hostname = new URL(serverBaseUrl).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function shortIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function MemberAvatar({ initials, label }: { initials: string; label: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-state-selected-surface text-[10px] font-semibold text-text-strong ring-1 ring-border/70"
      title={label}
    >
      {initials}
    </span>
  );
}

function HostStatusBadge({
  status,
  t
}: {
  status: PeopleHostRow["status"];
  t: ReturnType<typeof createTranslator>;
}) {
  const label =
    status === "online"
      ? t("peopleHostOnline")
      : status === "offline"
        ? t("peopleHostOffline")
        : t("peopleHostDegraded");
  const tone =
    status === "online"
      ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-100"
      : status === "offline"
        ? "bg-muted text-muted-foreground"
        : "bg-amber-500/15 text-amber-900 dark:text-amber-100";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      data-testid="people-host-status"
      data-status={status}
    >
      {label}
    </span>
  );
}

export function PeoplePanel({
  mode,
  presence,
  members,
  hosts,
  invitations,
  devices,
  detailsLoading,
  detailsError,
  actionError,
  actionBusy,
  pendingInvitation,
  invitationConnection = null,
  t,
  onCreateInvitation,
  onCopyInvitationToken,
  onDismissPendingInvitation,
  onRevokeInvitation,
  onRevokeInvitations,
  onPromoteMember,
  onDemoteMember,
  onRemoveMember,
  onRevokeDevice,
  onRefreshDetails,
  connectSlot,
  showTitle = true
}: PeoplePanelProps) {
  const [showOwnerDetails, setShowOwnerDetails] = useState(false);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [selectedInvitationIds, setSelectedInvitationIds] = useState<Set<string>>(new Set());
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const pendingInvitationRef = useRef<HTMLTextAreaElement>(null);
  const pendingInvitationDetails = useMemo(() => {
    if (!pendingInvitation) return null;
    if (!invitationConnection) return pendingInvitation.invitationToken;
    return serializeCollaborationInvitationHandoff({
      ...invitationConnection,
      invitationToken: pendingInvitation.invitationToken,
      allowInsecureTransport: new URL(invitationConnection.serverBaseUrl).protocol === "http:"
    });
  }, [invitationConnection, pendingInvitation]);

  useEffect(() => {
    setCopied(false);
    setCopyError(false);
    if (pendingInvitation && pendingInvitationRef.current) {
      pendingInvitationRef.current.focus();
      pendingInvitationRef.current.select();
    }
  }, [pendingInvitation]);

  useEffect(() => {
    if (presence.currentUserIsOwner && presence.memberCount <= 1) {
      setShowOwnerDetails(true);
    }
  }, [presence.currentUserIsOwner, presence.memberCount]);

  const openInvitationIds = useMemo(
    () =>
      invitations
        .filter((invitation) => invitation.open)
        .map((invitation) => invitation.invitationId),
    [invitations]
  );
  const allOpenInvitationsSelected =
    openInvitationIds.length > 0 &&
    openInvitationIds.every((invitationId) => selectedInvitationIds.has(invitationId));
  const someOpenInvitationsSelected =
    selectedInvitationIds.size > 0 && !allOpenInvitationsSelected;

  useEffect(() => {
    const openIds = new Set(openInvitationIds);
    setSelectedInvitationIds((current) => {
      const next = new Set([...current].filter((invitationId) => openIds.has(invitationId)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [openInvitationIds]);

  const confirmDestructive = (message: string): boolean => window.confirm(message);

  if (mode === "disconnected" || mode === "connecting") {
    return (
      <div className="flex flex-col gap-2" data-testid="people-panel" data-mode={mode}>
        {showTitle ? (
          <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
        ) : null}
        {mode === "connecting" ? (
          <p className="text-xs text-muted-foreground">{t("peopleConnecting")}</p>
        ) : null}
        {connectSlot}
      </div>
    );
  }

  if (mode === "auth_expired" || mode === "forbidden") {
    return (
      <div className="flex flex-col gap-2" data-testid="people-panel" data-mode={mode}>
        {showTitle ? (
          <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
        ) : null}
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          role="alert"
          data-testid="people-panel-auth-error"
        >
          {mode === "auth_expired" ? t("peopleAuthExpired") : t("peopleForbidden")}
        </div>
        {connectSlot}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="people-panel" data-mode={mode}>
      <div className="flex items-start justify-between gap-2">
        <div>
          {showTitle ? (
            <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
          ) : null}
          <p className="text-xs text-muted-foreground" data-testid="people-presence-summary">
            {t("peopleMemberCount").replace("{count}", String(presence.memberCount))}
            {" · "}
            {t("peopleHostOnlineCount")
              .replace("{online}", String(presence.onlineHostCount))
              .replace("{total}", String(presence.hostCount))}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {presence.currentUserIsOwner ? (
            <Button
              type="button"
              size="sm"
              data-testid="people-create-invitation"
              disabled={actionBusy || pendingInvitation !== null}
              onClick={() => void onCreateInvitation()}
            >
              {t("peopleCreateInvitation")}
            </Button>
          ) : null}
          {connectSlot ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="people-toggle-connection-settings"
              aria-expanded={showConnectionSettings}
              onClick={() => setShowConnectionSettings((current) => !current)}
            >
              {t(
                showConnectionSettings ? "peopleHideConnectionSettings" : "peopleConnectionSettings"
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="people-refresh-details"
            disabled={detailsLoading || actionBusy}
            onClick={() => void onRefreshDetails()}
          >
            {t("peopleRefresh")}
          </Button>
        </div>
      </div>

      {presence.credentialPersistence === "session-only" || presence.nonPersistenceWarning ? (
        <p
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
          data-testid="people-session-only-banner"
          role="status"
        >
          {t("peopleSessionOnlyCredentialWarning")}
        </p>
      ) : null}

      {mode === "loading" ? (
        <div className="text-xs text-muted-foreground" data-testid="people-loading" role="status">
          {t("peopleLoading")}
        </div>
      ) : null}
      {mode === "offline" ? (
        <div
          className="text-xs text-amber-800 dark:text-amber-100"
          data-testid="people-offline"
          role="status"
        >
          {t("peopleOffline")}
        </div>
      ) : null}
      {mode === "error" ? (
        <div className="text-xs text-muted-foreground" data-testid="people-error" role="status">
          {t("peopleError")}
        </div>
      ) : null}
      {mode === "empty" ? (
        <div className="text-xs text-muted-foreground" data-testid="people-empty">
          {t("peopleEmptyMembers")}
        </div>
      ) : null}

      {actionError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="people-action-error"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}
      {detailsError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="people-details-error"
          role="alert"
        >
          {detailsError}
        </div>
      ) : null}

      {connectSlot && showConnectionSettings ? (
        <div className="border-y border-border/70 py-4" data-testid="people-connection-settings">
          {connectSlot}
        </div>
      ) : null}

      {pendingInvitation ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
          data-testid="people-invitation-secret-once"
          role="alertdialog"
          aria-labelledby="people-invitation-secret-title"
        >
          <div id="people-invitation-secret-title" className="text-xs font-semibold">
            {t("peopleInvitationCopyOnceTitle")}
          </div>
          <p className="text-xs text-muted-foreground">{t("peopleInvitationCopyOnceWarning")}</p>
          {invitationConnection && isLoopbackServer(invitationConnection.serverBaseUrl) ? (
            <p className="text-xs font-medium text-amber-950 dark:text-amber-100" role="status">
              {t("peopleInvitationLoopbackWarning")}
            </p>
          ) : null}
          {invitationConnection ? (
            <dl
              className="grid gap-x-4 gap-y-1 border-y border-amber-500/25 py-2 text-xs sm:grid-cols-[auto_1fr]"
              data-testid="people-invitation-connection-summary"
            >
              <dt className="text-muted-foreground">{t("peopleServerUrl")}</dt>
              <dd className="min-w-0 truncate font-mono text-text-strong">
                {invitationConnection.serverBaseUrl}
              </dd>
              <dt className="text-muted-foreground">{t("peopleProjectId")}</dt>
              <dd className="min-w-0 truncate font-mono text-text-strong">
                {invitationConnection.projectId}
              </dd>
            </dl>
          ) : null}
          <label htmlFor="people-invitation-details" className="text-xs font-semibold">
            {t(invitationConnection ? "peopleInvitationDetails" : "peopleInvitationToken")}
          </label>
          <textarea
            id="people-invitation-details"
            ref={pendingInvitationRef}
            className="min-h-24 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5"
            data-testid="people-invitation-token-value"
            readOnly
            value={pendingInvitationDetails ?? ""}
            aria-label={t(
              invitationConnection ? "peopleInvitationDetails" : "peopleInvitationToken"
            )}
          />
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              data-testid="people-invitation-copy"
              disabled={actionBusy}
              onClick={() => {
                void (async () => {
                  try {
                    const copyValue = pendingInvitationDetails ?? pendingInvitation.invitationToken;
                    await onCopyInvitationToken(copyValue);
                    setCopied(true);
                    setCopyError(false);
                  } catch {
                    setCopied(false);
                    setCopyError(true);
                  }
                })();
              }}
            >
              {copied
                ? t("peopleInvitationCopied")
                : t(invitationConnection ? "peopleInvitationCopyHandoff" : "peopleInvitationCopy")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="people-invitation-dismiss"
              onClick={() => {
                setCopied(false);
                onDismissPendingInvitation();
              }}
            >
              {t("peopleInvitationDismiss")}
            </Button>
          </div>
          {copyError ? (
            <p
              className="text-xs text-destructive"
              data-testid="people-invitation-copy-error"
              role="alert"
            >
              {t("peopleInvitationCopyFailed")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 pr-1">
          <section aria-labelledby="people-members-heading" data-testid="people-members-section">
            <h3 id="people-members-heading" className="mb-1 text-xs font-semibold text-text-strong">
              {t("peopleMembers")}
            </h3>
            {members.length === 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="people-members-empty">
                {t("peopleEmptyMembers")}
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {members.map((member) => {
                  const promote = member.actions.find((action) => action.action === "promote");
                  const demote = member.actions.find((action) => action.action === "demote");
                  const remove = member.actions.find((action) => action.action === "remove");
                  return (
                    <li
                      key={member.membershipId}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
                      data-testid="people-member-row"
                      data-principal-id={member.humanPrincipalId}
                      data-role={member.role}
                    >
                      <MemberAvatar initials={member.initials} label={member.displayName} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-text-strong">
                          {member.displayName}
                          {member.isCurrentUser ? (
                            <span className="ml-1 text-muted-foreground">({t("peopleYou")})</span>
                          ) : null}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {member.role === "owner" ? t("peopleRoleOwner") : t("peopleRoleMember")}
                        </div>
                      </div>
                      {presence.currentUserIsOwner ? (
                        <div className="flex shrink-0 flex-wrap justify-end gap-0.5">
                          {promote?.allowed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-1.5 text-[10px]"
                              data-testid="people-member-promote"
                              disabled={actionBusy}
                              onClick={() => void onPromoteMember(member.humanPrincipalId)}
                            >
                              {t("peoplePromote")}
                            </Button>
                          ) : null}
                          {demote?.allowed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-1.5 text-[10px]"
                              data-testid="people-member-demote"
                              disabled={actionBusy}
                              onClick={() => {
                                if (!confirmDestructive(t("peopleDemoteConfirm"))) return;
                                void onDemoteMember(member.humanPrincipalId);
                              }}
                            >
                              {t("peopleDemote")}
                            </Button>
                          ) : demote && !demote.allowed && demote.reason === "last_owner" ? (
                            <span
                              className="text-[10px] text-muted-foreground"
                              data-testid="people-last-owner-guard"
                            >
                              {t("peopleLastOwnerProtected")}
                            </span>
                          ) : null}
                          {remove?.allowed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-1.5 text-[10px] text-destructive"
                              data-testid="people-member-remove"
                              disabled={actionBusy}
                              onClick={() => {
                                if (!confirmDestructive(t("peopleRemoveConfirm"))) return;
                                void onRemoveMember(member.humanPrincipalId);
                              }}
                            >
                              {t("peopleRemove")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="people-hosts-heading" data-testid="people-hosts-section">
            <h3 id="people-hosts-heading" className="mb-1 text-xs font-semibold text-text-strong">
              {t("peopleAgentHosts")}
            </h3>
            {hosts.length === 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="people-hosts-empty">
                {t("peopleEmptyHosts")}
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {hosts.map((host) => (
                  <li
                    key={host.hostId}
                    className="rounded-md border border-border/60 px-2 py-1.5"
                    data-testid="people-host-row"
                    data-host-id={host.hostId}
                    data-status={host.status}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-xs font-medium text-text-strong">
                        {host.displayName}
                      </div>
                      <HostStatusBadge status={host.status} t={t} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span data-testid="people-host-capacity">
                        {t("peopleHostCapacity")}:{" "}
                        {host.capacityRemaining === undefined
                          ? t("peopleHostCapacityUnknown")
                          : String(host.capacityRemaining)}
                      </span>
                      <span data-testid="people-host-capabilities">
                        {t("peopleHostCapabilities")}:{" "}
                        {host.capabilities.length > 0
                          ? host.capabilities.join(", ")
                          : t("peopleHostCapabilitiesNone")}
                      </span>
                      <span data-testid="people-host-version">
                        {t("peopleHostVersion")}: {t("peopleHostFieldUnavailable")}
                      </span>
                      <span data-testid="people-host-last-seen">
                        {t("peopleHostLastSeen")}: {t("peopleHostFieldUnavailable")}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {presence.currentUserIsOwner ? (
            <section
              aria-labelledby="people-owner-heading"
              data-testid="people-owner-section"
              className="rounded-md border border-border/70"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-between rounded-none px-2 py-1.5 text-xs"
                data-testid="people-owner-toggle"
                aria-expanded={showOwnerDetails}
                onClick={() => setShowOwnerDetails((current) => !current)}
              >
                <span id="people-owner-heading">{t("peopleOwnerActions")}</span>
                <span aria-hidden="true">{showOwnerDetails ? "−" : "+"}</span>
              </Button>
              {showOwnerDetails ? (
                <div className="flex flex-col gap-3 border-t border-border/70 p-2">
                  <div data-testid="people-invitations-list">
                    <div className="mb-1 flex min-h-7 items-center justify-between gap-3">
                      <div className="text-[11px] font-semibold">{t("peopleInvitations")}</div>
                      {openInvitationIds.length > 0 ? (
                        <div className="flex items-center gap-3 text-[10px]">
                          <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                            <input
                              type="checkbox"
                              className="size-3.5 accent-foreground"
                              data-testid="people-invitation-select-all"
                              checked={allOpenInvitationsSelected}
                              disabled={actionBusy}
                              aria-checked={
                                someOpenInvitationsSelected ? "mixed" : allOpenInvitationsSelected
                              }
                              ref={(element) => {
                                if (element) {
                                  element.indeterminate = someOpenInvitationsSelected;
                                }
                              }}
                              onChange={(event) => {
                                setSelectedInvitationIds(
                                  event.currentTarget.checked
                                    ? new Set(openInvitationIds)
                                    : new Set()
                                );
                              }}
                            />
                            {t("peopleSelectAllOpenInvitations")}
                          </label>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[10px] text-destructive"
                            data-testid="people-invitation-revoke-selected"
                            disabled={actionBusy || selectedInvitationIds.size === 0}
                            onClick={() => {
                              const invitationIds = [...selectedInvitationIds];
                              if (
                                !confirmDestructive(
                                  t("peopleRevokeSelectedInvitationsConfirm").replace(
                                    "{count}",
                                    String(invitationIds.length)
                                  )
                                )
                              ) {
                                return;
                              }
                              void onRevokeInvitations(invitationIds).then((ok) => {
                                if (!ok) return;
                                setSelectedInvitationIds((current) => {
                                  const next = new Set(current);
                                  for (const invitationId of invitationIds) {
                                    next.delete(invitationId);
                                  }
                                  return next;
                                });
                              });
                            }}
                          >
                            {t("peopleRevokeSelected").replace(
                              "{count}",
                              String(selectedInvitationIds.size)
                            )}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {detailsLoading ? (
                      <div className="text-xs text-muted-foreground">{t("peopleLoading")}</div>
                    ) : invitations.length === 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {t("peopleEmptyInvitations")}
                      </div>
                    ) : (
                      <ul className="divide-y divide-border/60 border-y border-border/60">
                        {invitations.map((invitation) => {
                          const status = invitation.open
                            ? t("peopleInvitationOpen")
                            : invitation.consumedAt
                              ? t("peopleInvitationConsumed")
                              : invitation.revokedAt
                                ? t("peopleInvitationRevoked")
                                : t("peopleInvitationExpired");
                          return (
                            <li
                              key={invitation.invitationId}
                              className="flex items-center justify-between gap-4 py-2 text-xs"
                              data-testid="people-invitation-row"
                              data-open={invitation.open ? "true" : "false"}
                            >
                              {invitation.open ? (
                                <input
                                  type="checkbox"
                                  className="size-3.5 shrink-0 accent-foreground"
                                  data-testid="people-invitation-select"
                                  aria-label={t("peopleSelectInvitation").replace(
                                    "{id}",
                                    shortIdentifier(invitation.invitationId)
                                  )}
                                  checked={selectedInvitationIds.has(invitation.invitationId)}
                                  disabled={actionBusy}
                                  onChange={(event) => {
                                    setSelectedInvitationIds((current) => {
                                      const next = new Set(current);
                                      if (event.currentTarget.checked) {
                                        next.add(invitation.invitationId);
                                      } else {
                                        next.delete(invitation.invitationId);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              ) : null}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="font-medium text-text-strong">{status}</span>
                                  <span className="text-[10px] text-muted-foreground">
                                    {t("peopleInvitationCreated").replace(
                                      "{time}",
                                      formatTimestamp(invitation.createdAt)
                                    )}
                                  </span>
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {t("peopleInvitationExpires").replace(
                                    "{time}",
                                    formatTimestamp(invitation.expiresAt)
                                  )}
                                  <span aria-hidden="true"> · </span>
                                  <span title={invitation.invitationId}>
                                    {t("peopleInvitationIdLabel").replace(
                                      "{id}",
                                      shortIdentifier(invitation.invitationId)
                                    )}
                                  </span>
                                </div>
                              </div>
                              {invitation.open ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-1.5 text-[10px] text-destructive"
                                  data-testid="people-invitation-revoke"
                                  disabled={actionBusy}
                                  onClick={() => {
                                    if (!confirmDestructive(t("peopleRevokeInvitationConfirm")))
                                      return;
                                    void onRevokeInvitation(invitation.invitationId);
                                  }}
                                >
                                  {t("peopleRevoke")}
                                </Button>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div data-testid="people-devices-list">
                    <div className="mb-1 text-[11px] font-semibold">{t("peopleDevices")}</div>
                    {detailsLoading ? (
                      <div className="text-xs text-muted-foreground">{t("peopleLoading")}</div>
                    ) : devices.length === 0 ? (
                      <div className="text-xs text-muted-foreground">{t("peopleEmptyDevices")}</div>
                    ) : (
                      <ul className="divide-y divide-border/60 border-y border-border/60">
                        {devices.map((device, index) => {
                          const memberName = members.find(
                            (member) => member.humanPrincipalId === device.humanPrincipalId
                          )?.displayName;
                          const displayName =
                            device.label !== device.deviceCredentialId
                              ? device.label
                              : t("peopleUnnamedDevice").replace("{number}", String(index + 1));
                          return (
                            <li
                              key={device.deviceCredentialId}
                              className="flex items-center justify-between gap-4 py-2 text-xs"
                              data-testid="people-device-row"
                              data-revoked={device.isRevoked ? "true" : "false"}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="truncate font-medium text-text-strong">
                                    {displayName}
                                  </span>
                                  {memberName ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      {t("peopleDeviceOwner").replace("{name}", memberName)}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {t("peopleDeviceCreated").replace(
                                    "{time}",
                                    formatTimestamp(device.createdAt)
                                  )}
                                  <span aria-hidden="true"> · </span>
                                  {t("peopleDeviceLastSeen")}:{" "}
                                  {device.lastSeenAt
                                    ? formatTimestamp(device.lastSeenAt)
                                    : t("peopleHostFieldUnavailable")}
                                  <span aria-hidden="true"> · </span>
                                  <span title={device.deviceCredentialId}>
                                    {t("peopleDeviceCredentialId").replace(
                                      "{id}",
                                      shortIdentifier(device.deviceCredentialId)
                                    )}
                                  </span>
                                </div>
                              </div>
                              {!device.isRevoked ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-1.5 text-[10px] text-destructive"
                                  data-testid="people-device-revoke"
                                  disabled={actionBusy}
                                  onClick={() => {
                                    if (!confirmDestructive(t("peopleRevokeDeviceConfirm"))) return;
                                    void onRevokeDevice(device.deviceCredentialId);
                                  }}
                                >
                                  {t("peopleRevoke")}
                                </Button>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">
                                  {t("peopleDeviceRevoked")}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      <div
        ref={liveRegionRef}
        className="sr-only"
        aria-live="polite"
        data-testid="people-live-region"
      >
        {actionError ?? detailsError ?? (copied ? t("peopleInvitationCopied") : "")}
      </div>
    </div>
  );
}
