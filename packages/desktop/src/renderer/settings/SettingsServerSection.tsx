import type { createTranslator } from "../i18n";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";

export type SettingsServerSectionProps = {
  t: ReturnType<typeof createTranslator>;
  showHeader?: boolean;
};

/** Advanced Server endpoint configuration. Workspace content is managed from People. */
export function SettingsServerSection({ t, showHeader = true }: SettingsServerSectionProps) {
  return (
    <section data-testid="settings-server-section" className="flex flex-col gap-6">
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("settingsServer")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsServerHint")}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-6" data-testid="settings-server-panels">
        <div data-testid="settings-server-connection-block">
          <DeploymentConnectionCard presentation="plain" t={t} />
        </div>
      </div>
    </section>
  );
}
