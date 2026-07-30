import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type OnboardingStep = "start" | "create" | "local" | "existing-server" | "join";

export type CollaborationWorkspaceOnboardingProps = {
  t: ReturnType<typeof createTranslator>;
  localHostingSlot: ReactNode;
  existingServerSlot: ReactNode;
  joinSlot: ReactNode;
};

/**
 * A bridge-free entry surface for collaboration setup. Concrete local-hosting,
 * existing-server, and join actions are owned by the slots supplied by its parent.
 */
export function CollaborationWorkspaceOnboarding({
  t,
  localHostingSlot,
  existingServerSlot,
  joinSlot
}: CollaborationWorkspaceOnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("start");

  const returnToStart = () => setStep("start");
  const returnToCreate = () => setStep("create");

  return (
    <section
      className="max-w-3xl"
      data-testid="collaboration-workspace-onboarding"
      aria-labelledby="collaboration-workspace-onboarding-title"
    >
      <div className="border-b border-border/70 pb-5">
        <h2
          id="collaboration-workspace-onboarding-title"
          className="text-sm font-semibold text-text-strong"
        >
          {t("collaborationOnboardingTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          {t("collaborationOnboardingDescription")}
        </p>
      </div>

      {step === "start" ? (
        <div className="mt-5 divide-y divide-border/70 border-y border-border/70">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-0 py-3 text-left"
            data-testid="collaboration-onboarding-create"
            onClick={() => setStep("create")}
          >
            <span>
              <span className="block text-xs font-medium text-text-strong">
                {t("collaborationOnboardingCreateWorkspace")}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {t("collaborationOnboardingCreateDescription")}
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-0 py-3 text-left"
            data-testid="collaboration-onboarding-join"
            onClick={() => setStep("join")}
          >
            <span>
              <span className="block text-xs font-medium text-text-strong">
                {t("collaborationOnboardingJoinWorkspace")}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {t("collaborationOnboardingJoinDescription")}
              </span>
            </span>
          </Button>
        </div>
      ) : null}

      {step === "create" ? (
        <div className="mt-5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mb-3 px-0"
            onClick={returnToStart}
          >
            {t("collaborationOnboardingBack")}
          </Button>
          <h3 className="text-xs font-semibold text-text-strong">
            {t("collaborationOnboardingCreateTitle")}
          </h3>
          <div className="mt-2 divide-y divide-border/70 border-y border-border/70">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between rounded-none px-0 py-3 text-left"
              data-testid="collaboration-onboarding-host-locally"
              onClick={() => setStep("local")}
            >
              <span>
                <span className="block text-xs font-medium text-text-strong">
                  {t("collaborationOnboardingHostLocallyTitle")}
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {t("collaborationOnboardingHostLocallyDescription")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between rounded-none px-0 py-3 text-left"
              data-testid="collaboration-onboarding-existing-server"
              onClick={() => setStep("existing-server")}
            >
              <span>
                <span className="block text-xs font-medium text-text-strong">
                  {t("collaborationOnboardingUseExistingServerTitle")}
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {t("collaborationOnboardingUseExistingServerDescription")}
                </span>
              </span>
            </Button>
          </div>
        </div>
      ) : null}

      {step === "local" || step === "existing-server" ? (
        <div className="mt-5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mb-3 px-0"
            onClick={returnToCreate}
          >
            {t("collaborationOnboardingBack")}
          </Button>
          {step === "local" ? localHostingSlot : existingServerSlot}
        </div>
      ) : null}

      {step === "join" ? (
        <div className="mt-5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mb-3 px-0"
            onClick={returnToStart}
          >
            {t("collaborationOnboardingBack")}
          </Button>
          <h3 className="text-xs font-semibold text-text-strong">
            {t("collaborationOnboardingJoinTitle")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("collaborationOnboardingJoinDescription")}
          </p>
          <div className="mt-4">{joinSlot}</div>
          <p className="mt-4 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
            {t("collaborationOnboardingSaasNote")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
