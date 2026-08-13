import type { createTranslator } from "../i18n";
import { SettingsCredentialStorageSection } from "./SettingsCredentialStorageSection";

type SettingsSecuritySectionProps = {
  t: ReturnType<typeof createTranslator>;
};

export function SettingsSecuritySection({ t }: SettingsSecuritySectionProps) {
  return (
    <section className="flex flex-col gap-6" data-testid="settings-security-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-strong">
          {t("settingsSecurity")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
          {t("settingsSecurityHint")}
        </p>
      </div>

      <SettingsCredentialStorageSection t={t} />
    </section>
  );
}
