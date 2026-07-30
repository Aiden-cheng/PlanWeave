import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../i18n";

export type CollaborationInvitationJoinFieldsProps = {
  formId: string;
  t: ReturnType<typeof createTranslator>;
  invitationDetails: string;
  displayName: string;
  manualJoinOpen: boolean;
  serverBaseUrl: string;
  projectId: string;
  invitationToken: string;
  allowInsecureTransport: boolean;
  onInvitationDetailsChange: (value: string) => void;
  onDisplayNameChange: (value: string) => void;
  onManualJoinOpenChange: (open: boolean) => void;
  onServerBaseUrlChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onInvitationTokenChange: (value: string) => void;
  onAllowInsecureTransportChange: (allow: boolean) => void;
};

/** Invitation-first join fields with manual protocol details behind a disclosure. */
export function CollaborationInvitationJoinFields({
  formId,
  t,
  invitationDetails,
  displayName,
  manualJoinOpen,
  serverBaseUrl,
  projectId,
  invitationToken,
  allowInsecureTransport,
  onInvitationDetailsChange,
  onDisplayNameChange,
  onManualJoinOpenChange,
  onServerBaseUrlChange,
  onProjectIdChange,
  onInvitationTokenChange,
  onAllowInsecureTransportChange
}: CollaborationInvitationJoinFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${formId}-invitation-details`}>{t("peopleInvitationDetails")}</Label>
        <Textarea
          id={`${formId}-invitation-details`}
          data-testid="people-connect-invitation-details"
          className="min-h-28 resize-y font-mono text-xs"
          value={invitationDetails}
          placeholder={t("peopleInvitationDetailsPlaceholder")}
          onChange={(event) => onInvitationDetailsChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {t("peopleInvitationDetailsHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${formId}-name-join`}>{t("peopleDisplayName")}</Label>
        <Input
          id={`${formId}-name-join`}
          data-testid="people-connect-display-name"
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          autoComplete="nickname"
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="w-fit px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-text-strong"
        data-testid="people-connect-manual-toggle"
        aria-expanded={manualJoinOpen}
        onClick={() => onManualJoinOpenChange(!manualJoinOpen)}
      >
        {manualJoinOpen ? (
          <ChevronUpIcon className="mr-1 size-3.5" aria-hidden="true" />
        ) : (
          <ChevronDownIcon className="mr-1 size-3.5" aria-hidden="true" />
        )}
        {t(
          manualJoinOpen ? "peopleHideAdvancedConnectionDetails" : "peopleAdvancedConnectionDetails"
        )}
      </Button>
      {manualJoinOpen ? (
        <div
          className="grid grid-cols-1 gap-x-5 gap-y-3 border-l-2 border-border/70 pl-4 md:grid-cols-2"
          data-testid="people-connect-manual-fields"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${formId}-url-join`}>{t("peopleServerUrl")}</Label>
            <Input
              id={`${formId}-url-join`}
              data-testid="people-connect-server-url"
              value={serverBaseUrl}
              onChange={(event) => onServerBaseUrlChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${formId}-project-join`}>{t("peopleProjectId")}</Label>
            <Input
              id={`${formId}-project-join`}
              data-testid="people-connect-project-id"
              value={projectId}
              onChange={(event) => onProjectIdChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <Label htmlFor={`${formId}-token`}>{t("peopleInvitationToken")}</Label>
            <Input
              id={`${formId}-token`}
              data-testid="people-connect-invitation-token"
              value={invitationToken}
              onChange={(event) => onInvitationTokenChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
            <input
              type="checkbox"
              data-testid="people-connect-allow-insecure"
              checked={allowInsecureTransport}
              onChange={(event) => onAllowInsecureTransportChange(event.target.checked)}
            />
            {t("peopleAllowInsecureTransport")}
          </label>
        </div>
      ) : null}
    </div>
  );
}
