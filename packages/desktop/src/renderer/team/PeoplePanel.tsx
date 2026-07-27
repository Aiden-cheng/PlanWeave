import { useEffect, useRef, useState, type ReactNode } from "react";
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
  t: ReturnType<typeof createTranslator>;
  onCreateInvitation: () => Promise<CollaborationInvitationCreateView | null>;
  onCopyInvitationToken: (token: string) => Promise<void>;
  onDismissPendingInvitation: () => void;
  onRevokeInvitation: (invitationId: string) => Promise<boolean>;
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
  t,
  onCreateInvitation,
  onCopyInvitationToken,
  onDismissPendingInvitation,
  onRevokeInvitation,
  onPromoteMember,
  onDemoteMember,
  onRemoveMember,
  onRevokeDevice,
  onRefreshDetails,
  connectSlot,
  showTitle = true
}: PeoplePanelProps) {
  const [showOwnerDetails, setShowOwnerDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const liveRegionRef = useRef<HTMLDivElement>(null);
  const pendingTokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingInvitation && pendingTokenRef.current) {
      pendingTokenRef.current.focus();
      pendingTokenRef.current.select();
    }
  }, [pendingInvitation]);

  const confirmDestructive = (message: string): boolean => window.confirm(message);

  if (mode === "disconnected" || mode === "connecting") {
    return (
      <div className="flex flex-col gap-2" data-testid="people-panel" data-mode={mode}>
        {showTitle ? (
          <h1 className="text-lg font-semibold text-text-strong">{t("peopleTitle")}</h1>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {mode === "connecting" ? t("peopleConnecting") : t("peopleDisconnected")}
        </p>
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
        <div className="text-xs text-destructive" data-testid="people-error" role="alert">
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
          <input
            ref={pendingTokenRef}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            data-testid="people-invitation-token-value"
            readOnly
            value={pendingInvitation.invitationToken}
            aria-label={t("peopleInvitationToken")}
          />
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              data-testid="people-invitation-copy"
              disabled={actionBusy}
              onClick={() => {
                void onCopyInvitationToken(pendingInvitation.invitationToken).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? t("peopleInvitationCopied") : t("peopleInvitationCopy")}
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
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 pr-1">
          <section aria-labelledby="people-members-heading" data-testid="people-members-section">
            <h3 id="people-members-heading" className="mb-1 text-xs font-semibold text-text-strong">
              {t("peopleMembers")}
            </h3>
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
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="people-create-invitation"
                      disabled={actionBusy}
                      onClick={() => void onCreateInvitation()}
                    >
                      {t("peopleCreateInvitation")}
                    </Button>
                  </div>

                  <div data-testid="people-invitations-list">
                    <div className="mb-1 text-[11px] font-semibold">{t("peopleInvitations")}</div>
                    {detailsLoading ? (
                      <div className="text-xs text-muted-foreground">{t("peopleLoading")}</div>
                    ) : invitations.length === 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {t("peopleEmptyInvitations")}
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {invitations.map((invitation) => (
                          <li
                            key={invitation.invitationId}
                            className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1 text-xs"
                            data-testid="people-invitation-row"
                            data-open={invitation.open ? "true" : "false"}
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[10px]">
                                {invitation.invitationId}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {invitation.open
                                  ? t("peopleInvitationOpen")
                                  : invitation.consumedAt
                                    ? t("peopleInvitationConsumed")
                                    : t("peopleInvitationClosed")}
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
                        ))}
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
                      <ul className="flex flex-col gap-1">
                        {devices.map((device) => (
                          <li
                            key={device.deviceCredentialId}
                            className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1 text-xs"
                            data-testid="people-device-row"
                            data-revoked={device.isRevoked ? "true" : "false"}
                          >
                            <div className="min-w-0">
                              <div className="truncate">{device.label}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {t("peopleDeviceLastSeen")}:{" "}
                                {device.lastSeenAt ?? t("peopleHostFieldUnavailable")}
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
                        ))}
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
