import type { ActiveCanvasPersonGrant, CurrentCanvasAccessView } from "@planweave-ai/collaboration-contracts";
import { LockKeyholeIcon, UsersRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { CurrentCanvasVisibilityScope } from "../hooks/useCurrentCanvasAccess";

export type CurrentCanvasAccessPanelProps = {
  view: CurrentCanvasAccessView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
  onRefresh: () => Promise<void>;
  onUpdateVisibility: (
    scopeKind: CurrentCanvasVisibilityScope,
    visibility: "private" | "shared"
  ) => Promise<unknown>;
  onGrant: (
    humanPrincipalId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
    role: "viewer" | "editor",
    scopeKind: CurrentCanvasVisibilityScope
  ) => Promise<unknown>;
  onRevoke: (grant: ActiveCanvasPersonGrant) => Promise<unknown>;
};

function reasonLabel(
  reason: CurrentCanvasAccessView["canvas"]["disabledReason"] | "capability_denied",
  t: ReturnType<typeof createTranslator>
): string {
  const labels = {
    membership_missing: t("accessReasonMembershipMissing"),
    membership_revoked: t("accessReasonMembershipRevoked"),
    session_missing: t("accessReasonSessionMissing"),
    session_expired: t("accessReasonSessionExpired"),
    session_revoked: t("accessReasonSessionRevoked"),
    scope_private: t("accessReasonScopePrivate"),
    grant_revoked: t("accessReasonGrantRevoked"),
    capability_denied: t("accessReasonCapabilityDenied"),
    acl_revision_conflict: t("accessReasonRevisionConflict"),
    cross_workspace: t("accessReasonCrossWorkspace"),
    cross_project: t("accessReasonCrossProject"),
    cross_canvas: t("accessReasonCrossCanvas")
  } as const;
  return labels[reason ?? "capability_denied"];
}

function errorLabel(error: string, t: ReturnType<typeof createTranslator>): string {
  const knownReasons = [
    "membership_missing",
    "membership_revoked",
    "session_missing",
    "session_expired",
    "session_revoked",
    "scope_private",
    "grant_revoked",
    "capability_denied",
    "acl_revision_conflict",
    "cross_workspace",
    "cross_project",
    "cross_canvas"
  ] as const;
  const reason = knownReasons.find((candidate) => candidate === error);
  return reason ? reasonLabel(reason, t) : error;
}

function roleLabel(role: CurrentCanvasAccessView["canvas"]["effectiveRole"], t: ReturnType<typeof createTranslator>) {
  if (role === "owner") return t("accessRoleOwner");
  if (role === "editor") return t("accessRoleEditor");
  if (role === "viewer") return t("accessRoleViewer");
  return t("accessRoleNone");
}

function CapabilityState({
  label,
  enabled,
  reason,
  t
}: {
  label: string;
  enabled: boolean;
  reason: CurrentCanvasAccessView["canvas"]["disabledReason"] | "capability_denied";
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <li className="flex items-center justify-between gap-2 text-[11px]" data-testid="canvas-access-capability">
      <span>{label}</span>
      <span className={enabled ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>
        {enabled ? t("accessCapabilityAvailable") : reasonLabel(reason, t)}
      </span>
    </li>
  );
}

function VisibilityControl({
  scopeKind,
  visibility,
  allowed,
  reason,
  busy,
  t,
  onUpdate
}: {
  scopeKind: CurrentCanvasVisibilityScope;
  visibility: "private" | "shared";
  allowed: boolean;
  reason: CurrentCanvasAccessView["canvas"]["disabledReason"] | "capability_denied";
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
  onUpdate: CurrentCanvasAccessPanelProps["onUpdateVisibility"];
}) {
  const label = scopeKind === "project" ? t("accessProjectVisibility") : t("accessCanvasVisibility");
  return (
    <div className="flex items-center justify-between gap-2" data-testid={`canvas-access-${scopeKind}-visibility`}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {(["private", "shared"] as const).map((nextVisibility) => (
          <Button
            key={nextVisibility}
            type="button"
            size="sm"
            variant={visibility === nextVisibility ? "secondary" : "ghost"}
            className="h-7 px-1.5 text-[10px]"
            data-testid={`canvas-access-${scopeKind}-${nextVisibility}`}
            disabled={!allowed || busy || visibility === nextVisibility}
            title={!allowed ? reasonLabel(reason, t) : undefined}
            onClick={() => void onUpdate(scopeKind, nextVisibility)}
          >
            {nextVisibility === "private" ? t("accessVisibilityPrivate") : t("accessVisibilityShared")}
          </Button>
        ))}
      </div>
    </div>
  );
}

function CanvasVisibilitySelector({
  visibility,
  allowed,
  reason,
  busy,
  t,
  onUpdate
}: Omit<Parameters<typeof VisibilityControl>[0], "scopeKind">) {
  const choices = [
    {
      value: "private" as const,
      label: t("accessVisibilityPrivate"),
      hint: t("accessVisibilityPrivateHint"),
      icon: LockKeyholeIcon
    },
    {
      value: "shared" as const,
      label: t("accessVisibilityShared"),
      hint: t("accessVisibilitySharedHint"),
      icon: UsersRoundIcon
    }
  ];
  return (
    <div
      className="rounded-lg border border-border/70 bg-muted/20 p-3"
      data-testid="canvas-access-canvas-visibility"
    >
      <div className="mb-2">
        <div className="text-xs font-semibold text-text-strong">
          {t("accessCurrentCanvasVisibility")}
        </div>
        <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
          {t("accessCanvasVisibilityHint")}
        </div>
      </div>
      <div
        className="grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label={t("accessCurrentCanvasVisibility")}
      >
        {choices.map((choice) => {
          const selected = visibility === choice.value;
          const Icon = choice.icon;
          return (
            <label
              key={choice.value}
              className={`flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-primary/45 bg-background text-text-strong shadow-sm"
                  : "border-transparent bg-background/55 text-muted-foreground hover:border-border hover:bg-background"
              }`}
              title={!allowed ? reasonLabel(reason, t) : undefined}
            >
              <input
                type="radio"
                name="current-canvas-visibility"
                value={choice.value}
                checked={selected}
                className="sr-only"
                data-testid={`canvas-access-canvas-${choice.value}`}
                disabled={!allowed || busy || selected}
                title={!allowed ? reasonLabel(reason, t) : undefined}
                onChange={() => void onUpdate("canvas", choice.value)}
              />
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[11px] font-semibold">{choice.label}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                  {choice.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Compact current-canvas access read model and owner-only visibility actions. */
export function CurrentCanvasAccessPanel({
  view,
  loading,
  error,
  busy,
  t,
  onRefresh,
  onUpdateVisibility,
  onGrant,
  onRevoke
}: CurrentCanvasAccessPanelProps) {
  if (!view && !loading && !error) return null;
  if (!view) {
    return (
      <section className="flex flex-col gap-1" data-testid="canvas-access-panel">
        <div className="text-xs text-muted-foreground" role="status">
          {loading ? t("accessLoading") : error ?? t("accessUnavailable")}
        </div>
      </section>
    );
  }

  const { project, canvas } = view;
  const projectDisabledReason = project.disabledReason ?? "capability_denied";
  const canvasDisabledReason = canvas.disabledReason ?? "capability_denied";
  return (
    <section className="flex flex-col gap-2" data-testid="canvas-access-panel" aria-label={t("accessTitle")}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-text-strong">{t("accessTitle")}</div>
          <div className="text-[11px] text-muted-foreground" data-testid="canvas-access-role">
            {t("accessEffectiveRole")}: {t("accessProjectScope")} {roleLabel(project.effectiveRole, t)} · {t("accessCanvasScope")} {roleLabel(canvas.effectiveRole, t)}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-1.5 text-[10px]"
          data-testid="canvas-access-refresh"
          disabled={loading || busy}
          onClick={() => void onRefresh()}
        >
          {t("peopleRefresh")}
        </Button>
      </div>

      {error ? <div className="text-xs text-destructive" role="alert">{errorLabel(error, t)}</div> : null}

      <div className="flex flex-col gap-2" data-testid="canvas-access-visibility-controls">
        <CanvasVisibilitySelector
          visibility={view.canvasVisibility}
          allowed={canvas.capabilities.visibility}
          reason={canvasDisabledReason}
          busy={busy}
          t={t}
          onUpdate={onUpdateVisibility}
        />
        <VisibilityControl
          scopeKind="project"
          visibility={view.projectVisibility}
          allowed={project.capabilities.visibility}
          reason={projectDisabledReason}
          busy={busy}
          t={t}
          onUpdate={onUpdateVisibility}
        />
      </div>

      <ul className="grid grid-cols-1 gap-0.5" aria-label={t("accessCapabilities")}>
        <CapabilityState label={t("accessCapabilityWrite")} enabled={canvas.capabilities.persistent_canvas_command} reason={canvasDisabledReason} t={t} />
        <CapabilityState label={t("accessCapabilityAssignment")} enabled={canvas.capabilities.assignment} reason={canvasDisabledReason} t={t} />
        <CapabilityState label={t("accessCapabilityComment")} enabled={canvas.capabilities.comment} reason={canvasDisabledReason} t={t} />
        <CapabilityState label={t("accessCapabilityAdministration")} enabled={canvas.capabilities.administration} reason={canvasDisabledReason} t={t} />
      </ul>

      <section data-testid="canvas-access-people">
        <div className="mb-1 text-[11px] font-semibold text-text-strong">{t("accessPeople")}</div>
        <ul className="flex flex-col gap-1">
          {view.people.map((person) => {
            const grants = person.grants;
            const grantScopes = [
              { scopeKind: "project" as const, access: project },
              { scopeKind: "canvas" as const, access: canvas }
            ];
            return (
              <li
                key={person.humanPrincipalId}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                data-testid="canvas-access-person"
                data-principal-id={person.humanPrincipalId}
              >
                <span className="min-w-0 flex-1 truncate">
                  {person.displayName} · {roleLabel(person.effectiveRole, t)}
                </span>
                <div className="flex flex-wrap gap-1">
                  {grantScopes.flatMap(({ scopeKind, access }) =>
                    (["viewer", "editor"] as const).map((role) => (
                      <Button
                        key={`${scopeKind}-${role}`}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-1.5 text-[10px]"
                        data-testid={`canvas-access-grant-${scopeKind}-${role}`}
                        disabled={!access.capabilities.grant || busy}
                        title={
                          !access.capabilities.grant
                            ? reasonLabel(access.disabledReason ?? "capability_denied", t)
                            : undefined
                        }
                        onClick={() => void onGrant(person.humanPrincipalId, role, scopeKind)}
                      >
                        {scopeKind === "project" ? t("accessProjectScope") : t("accessCanvasScope")} {role === "viewer" ? t("accessGrantViewer") : t("accessGrantEditor")}
                      </Button>
                    ))
                  )}
                  {grants.length === 0 ? (
                    <span className="text-muted-foreground" data-testid="canvas-access-no-revocable-grant">
                      {t("accessNoRevocableGrant")}
                    </span>
                  ) : (
                    grants.map((grant) => (
                      <Button
                        key={grant.grantId}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-1.5 text-[10px] text-destructive"
                        data-testid="canvas-access-revoke"
                        disabled={!(grant.scopeKind === "project" ? project : canvas).capabilities.revoke || busy}
                        title={
                          !(grant.scopeKind === "project" ? project : canvas).capabilities.revoke
                            ? reasonLabel((grant.scopeKind === "project" ? project : canvas).disabledReason ?? "capability_denied", t)
                            : undefined
                        }
                        onClick={() => void onRevoke(grant)}
                      >
                        {t("peopleRevoke")} {grant.scopeKind === "project" ? t("accessProjectScope") : t("accessCanvasScope")}
                      </Button>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
