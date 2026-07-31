import { useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LaptopIcon,
  LogInIcon,
  PlusIcon,
  ServerIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type OnboardingStep = "start" | "create" | "local" | "existing-server" | "join";

export type CollaborationWorkspaceOnboardingProps = {
  t: ReturnType<typeof createTranslator>;
  localHostingSlot: ReactNode;
  existingServerSlot: ReactNode;
  joinSlot: ReactNode;
};

type OnboardingActionProps = {
  title: string;
  description: string;
  icon: ReactNode;
  testId: string;
  onClick: () => void;
};

function OnboardingAction({ title, description, icon, testId, onClick }: OnboardingActionProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="group h-auto min-h-20 w-full justify-between rounded-none px-5 py-4 text-left hover:bg-muted/35 focus-visible:z-10 focus-visible:ring-inset"
      data-testid={testId}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/45 text-muted-foreground transition-colors group-hover:border-border group-hover:bg-background group-hover:text-text-strong">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-5 text-text-strong">{title}</span>
          <span className="mt-0.5 block max-w-xl text-xs font-normal leading-5 text-muted-foreground">
            {description}
          </span>
        </span>
      </span>
      <ChevronRightIcon
        className="ml-5 size-4 shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
        aria-hidden="true"
      />
    </Button>
  );
}

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

  const header = (() => {
    switch (step) {
      case "create":
        return {
          title: t("collaborationOnboardingCreateTitle"),
          description: t("collaborationOnboardingCreateDescription")
        };
      case "local":
        return {
          title: t("collaborationOnboardingHostLocallyTitle"),
          description: t("collaborationOnboardingHostLocallyDescription")
        };
      case "existing-server":
        return {
          title: t("collaborationOnboardingUseExistingServerTitle"),
          description: t("collaborationOnboardingUseExistingServerDescription")
        };
      case "join":
        return {
          title: t("collaborationOnboardingJoinTitle"),
          description: t("collaborationOnboardingJoinDescription")
        };
      default:
        return {
          title: t("collaborationOnboardingTitle"),
          description: t("collaborationOnboardingDescription")
        };
    }
  })();

  const backTarget =
    step === "local" || step === "existing-server" ? returnToCreate : returnToStart;

  return (
    <section
      className="mx-auto w-full max-w-[880px] px-8 pb-16 pt-14 sm:px-10 lg:pt-20"
      data-testid="collaboration-workspace-onboarding"
      data-step={step}
      aria-labelledby="collaboration-workspace-onboarding-title"
    >
      <header className="mb-8">
        {step !== "start" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 mb-5 gap-1.5 text-muted-foreground hover:text-text-strong"
            onClick={backTarget}
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
            {t("collaborationOnboardingBack")}
          </Button>
        ) : null}
        <h2
          id="collaboration-workspace-onboarding-title"
          className="text-2xl font-semibold tracking-[-0.025em] text-text-strong"
        >
          {header.title}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {header.description}
        </p>
      </header>

      {step === "start" ? (
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <OnboardingAction
            title={t("collaborationOnboardingCreateWorkspace")}
            description={t("collaborationOnboardingCreateDescription")}
            icon={<PlusIcon className="size-4" aria-hidden="true" />}
            testId="collaboration-onboarding-create"
            onClick={() => setStep("create")}
          />
          <OnboardingAction
            title={t("collaborationOnboardingJoinWorkspace")}
            description={t("collaborationOnboardingJoinDescription")}
            icon={<LogInIcon className="size-4" aria-hidden="true" />}
            testId="collaboration-onboarding-join"
            onClick={() => setStep("join")}
          />
        </div>
      ) : null}

      {step === "create" ? (
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <OnboardingAction
            title={t("collaborationOnboardingHostLocallyTitle")}
            description={t("collaborationOnboardingHostLocallyDescription")}
            icon={<LaptopIcon className="size-4" aria-hidden="true" />}
            testId="collaboration-onboarding-host-locally"
            onClick={() => setStep("local")}
          />
          <OnboardingAction
            title={t("collaborationOnboardingUseExistingServerTitle")}
            description={t("collaborationOnboardingUseExistingServerDescription")}
            icon={<ServerIcon className="size-4" aria-hidden="true" />}
            testId="collaboration-onboarding-existing-server"
            onClick={() => setStep("existing-server")}
          />
        </div>
      ) : null}

      {step === "local" || step === "existing-server" ? (
        <div className="rounded-xl border border-border/80 bg-background p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-6">
          {step === "local" ? localHostingSlot : existingServerSlot}
        </div>
      ) : null}

      {step === "join" ? (
        <>
          <div className="rounded-xl border border-border/80 bg-background p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-6">
            {joinSlot}
          </div>
          <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
            {t("collaborationOnboardingSaasNote")}
          </p>
        </>
      ) : null}
    </section>
  );
}
