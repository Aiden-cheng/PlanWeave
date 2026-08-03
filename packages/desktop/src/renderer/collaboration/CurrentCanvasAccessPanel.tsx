import type {
  ActiveCanvasPersonGrant,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { LockKeyholeIcon, ShieldCheckIcon, UsersRoundIcon } from "lucide-react";
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
};

export type CurrentCanvasMemberAccessProps = {
  view: CurrentCanvasAccessView;
  person: CurrentCanvasAccessView["people"][number];
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
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

function roleLabel(
  role: CurrentCanvasAccessView["canvas"]["effectiveRole"],
  t: ReturnType<typeof createTranslator>
) {
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
    <li
      className="flex min-w-0 items-start gap-2.5 border-b border-border/50 px-1 py-2.5 text-xs last:border-b-0"
      data-testid="canvas-access-capability"
    >
      <span
        className={`mt-1 size-1.5 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 font-medium text-text-strong">{label}</span>
      <span
        className={enabled ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}
      >
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
  const label =
    scopeKind === "project" ? t("accessProjectVisibility") : t("accessCanvasVisibility");
  return (
    <div
      className="flex flex-col gap-2 border-t border-border/60 px-1 py-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`canvas-access-${scopeKind}-visibility`}
    >
      <span className="text-xs font-medium text-text-strong">{label}</span>
      <div className="flex items-center gap-1 rounded-md bg-muted/50 p-0.5">
        {(["private", "shared"] as const).map((nextVisibility) => (
          <Button
            key={nextVisibility}
            type="button"
            size="sm"
            variant={visibility === nextVisibility ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-[11px]"
            data-testid={`canvas-access-${scopeKind}-${nextVisibility}`}
            aria-pressed={visibility === nextVisibility}
            disabled={!allowed || busy}
            title={!allowed ? reasonLabel(reason, t) : undefined}
            onClick={() => {
              if (visibility !== nextVisibility) void onUpdate(scopeKind, nextVisibility);
            }}
          >
            {nextVisibility === "private"
              ? t("accessVisibilityPrivate")
              : t("accessVisibilityShared")}
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
    <div className="py-1" data-testid="canvas-access-canvas-visibility">
      <div className="mb-3">
        <div className="text-sm font-semibold text-text-strong">
          {t("accessCurrentCanvasVisibility")}
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("accessCanvasVisibilityHint")}
        </div>
      </div>
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-label={t("accessCurrentCanvasVisibility")}
      >
        {choices.map((choice) => {
          const selected = visibility === choice.value;
          const Icon = choice.icon;
          return (
            <label
              key={choice.value}
              className={`flex min-w-0 items-start gap-3 border-l-2 px-3 py-3 text-left transition-colors ${
                selected
                  ? "border-foreground bg-muted/35 text-text-strong"
                  : "border-transparent text-muted-foreground hover:bg-muted/25"
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
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-xs font-semibold">{choice.label}</span>
                <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
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
  onUpdateVisibility
}: CurrentCanvasAccessPanelProps) {
  if (!view && !loading && !error) return null;
  if (!view) {
    return (
      <section
        className="border-t border-border/70 py-7"
        data-testid="canvas-access-panel"
        aria-labelledby="canvas-access-title"
      >
        <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-1 pb-5">
          <div
            className="flex size-8 items-center justify-center text-sky-700 dark:text-sky-300"
            data-testid="canvas-access-section-icon"
          >
            <ShieldCheckIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 pt-0.5">
            <h2
              id="canvas-access-title"
              className="text-base font-semibold tracking-tight text-text-strong"
            >
              {t("accessTitle")}
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              {t("accessDescription")}
            </p>
          </div>
        </div>
        <div
          className="border-t border-border/60 px-1 py-5 text-sm text-muted-foreground sm:ml-11"
          role="status"
        >
          {loading ? t("accessLoading") : (error ?? t("accessUnavailable"))}
        </div>
      </section>
    );
  }

  const { project, canvas } = view;
  const projectDisabledReason = project.disabledReason ?? "capability_denied";
  const canvasDisabledReason = canvas.disabledReason ?? "capability_denied";
  return (
    <section
      className="min-w-0 border-t border-border/70 py-7"
      data-testid="canvas-access-panel"
      aria-labelledby="canvas-access-title"
    >
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-1 pb-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto]">
        <div
          className="flex size-8 items-center justify-center text-sky-700 dark:text-sky-300"
          data-testid="canvas-access-section-icon"
        >
          <ShieldCheckIcon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 pt-0.5">
          <h2
            id="canvas-access-title"
            className="text-base font-semibold tracking-tight text-text-strong"
          >
            {t("accessTitle")}
          </h2>
          <div className="mt-0.5 text-xs text-muted-foreground" data-testid="canvas-access-role">
            {t("accessEffectiveRole")}: {t("accessProjectScope")}{" "}
            {roleLabel(project.effectiveRole, t)} · {t("accessCanvasScope")}{" "}
            {roleLabel(canvas.effectiveRole, t)}
          </div>
          <p className="mt-1 max-w-3xl text-[11px] leading-4 text-muted-foreground">
            {t("accessDescription")}
          </p>
        </div>
        <div className="col-start-2 mt-4 sm:col-start-3 sm:row-start-1 sm:mt-0">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-2.5 text-xs"
            data-testid="canvas-access-refresh"
            disabled={loading || busy}
            onClick={() => void onRefresh()}
          >
            {t("peopleRefresh")}
          </Button>
        </div>
      </div>

      {error ? (
        <div
          className="mx-1 mb-4 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-xs text-destructive sm:ml-11"
          role="alert"
        >
          {errorLabel(error, t)}
        </div>
      ) : null}

      <div className="grid min-w-0 gap-8 border-t border-border/60 px-1 py-5 sm:ml-11 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] xl:gap-0">
        <div
          className="flex min-w-0 flex-col gap-3"
          data-testid="canvas-access-visibility-controls"
        >
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

        <div className="min-w-0 border-t border-border/60 pt-5 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
          <div className="border-b border-border/60 px-1 pb-3 text-xs font-semibold text-text-strong">
            {t("accessCapabilities")}
          </div>
          <ul
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1"
            aria-label={t("accessCapabilities")}
          >
            <CapabilityState
              label={t("accessCapabilityWrite")}
              enabled={canvas.capabilities.persistent_canvas_command}
              reason={canvasDisabledReason}
              t={t}
            />
            <CapabilityState
              label={t("accessCapabilityAssignment")}
              enabled={canvas.capabilities.assignment}
              reason={canvasDisabledReason}
              t={t}
            />
            <CapabilityState
              label={t("accessCapabilityComment")}
              enabled={canvas.capabilities.comment}
              reason={canvasDisabledReason}
              t={t}
            />
            <CapabilityState
              label={t("accessCapabilityAdministration")}
              enabled={canvas.capabilities.administration}
              reason={canvasDisabledReason}
              t={t}
            />
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Per-person project and current-canvas access controls, embedded in the member row. */
export function CurrentCanvasMemberAccess({
  view,
  person,
  busy,
  t,
  onGrant,
  onRevoke
}: CurrentCanvasMemberAccessProps) {
  const grantScopes = [
    { scopeKind: "project" as const, access: view.project },
    { scopeKind: "canvas" as const, access: view.canvas }
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="canvas-member-access">
      <div>
        <div className="text-xs font-semibold text-text-strong">
          {t("accessMemberEffectiveRole")}: {roleLabel(person.effectiveRole, t)}
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          {t("accessMemberPermissionHint")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        {grantScopes.map(({ scopeKind, access }) => (
          <div
            key={scopeKind}
            className="flex min-w-0 flex-wrap items-center gap-1 border-l border-border/60 py-1 pl-2"
          >
            <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {scopeKind === "project" ? t("accessProjectScope") : t("accessCanvasScope")}
            </span>
            {(["viewer", "editor"] as const).map((role) => (
              <Button
                key={`${scopeKind}-${role}`}
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                data-testid={`canvas-access-grant-${scopeKind}-${role}`}
                disabled={!access.capabilities.grant || busy}
                title={
                  !access.capabilities.grant
                    ? reasonLabel(access.disabledReason ?? "capability_denied", t)
                    : undefined
                }
                onClick={() => void onGrant(person.humanPrincipalId, role, scopeKind)}
              >
                {role === "viewer" ? t("accessGrantViewer") : t("accessGrantEditor")}
              </Button>
            ))}
          </div>
        ))}
        {person.grants.length === 0 ? (
          <span className="px-1 text-[11px] text-muted-foreground">
            {t("accessNoRevocableGrant")}
          </span>
        ) : (
          person.grants.map((grant) => {
            const access = grant.scopeKind === "project" ? view.project : view.canvas;
            return (
              <Button
                key={grant.grantId}
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-destructive"
                data-testid="canvas-access-revoke"
                disabled={!access.capabilities.revoke || busy}
                title={
                  !access.capabilities.revoke
                    ? reasonLabel(access.disabledReason ?? "capability_denied", t)
                    : undefined
                }
                onClick={() => void onRevoke(grant)}
              >
                {t("peopleRevoke")}{" "}
                {grant.scopeKind === "project" ? t("accessProjectScope") : t("accessCanvasScope")}
              </Button>
            );
          })
        )}
      </div>
    </div>
  );
}
