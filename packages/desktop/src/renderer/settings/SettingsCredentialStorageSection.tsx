import { useEffect, useState } from "react";
import { CheckIcon, HardDriveIcon, KeyRoundIcon } from "lucide-react";
import type {
  CredentialStorageMode,
  CredentialStorageSettingsStatus
} from "../../shared/credentialStorageSettings";
import { credentialStorageSettingsBridge } from "../bridge";
import type { createTranslator } from "../i18n";

type SettingsCredentialStorageSectionProps = {
  t: ReturnType<typeof createTranslator>;
};

export function SettingsCredentialStorageSection({
  t
}: SettingsCredentialStorageSectionProps) {
  const [status, setStatus] = useState<CredentialStorageSettingsStatus | null>(null);
  const [savingMode, setSavingMode] = useState<CredentialStorageMode | null>(null);
  const [confirmationMode, setConfirmationMode] = useState<CredentialStorageMode | null>(null);
  const [error, setError] = useState<"load" | "save" | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!credentialStorageSettingsBridge) {
      setError("load");
      return undefined;
    }
    void credentialStorageSettingsBridge.getCredentialStorageSettings().then(
      (next) => {
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      },
      () => {
        if (!cancelled) setError("load");
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const configure = async (mode: CredentialStorageMode) => {
    if (!credentialStorageSettingsBridge || mode === status?.configuredMode || savingMode) return;
    setSavingMode(mode);
    setError(null);
    try {
      setStatus(await credentialStorageSettingsBridge.configureCredentialStorage({ mode }));
      setConfirmationMode(null);
    } catch {
      setError("save");
    } finally {
      setSavingMode(null);
    }
  };

  const options: Array<{
    mode: CredentialStorageMode;
    icon: typeof HardDriveIcon;
    title: string;
    description: string;
  }> = [
    {
      mode: "application",
      icon: HardDriveIcon,
      title: t("credentialStorageApplication"),
      description: t("credentialStorageApplicationDescription")
    },
    {
      mode: "system",
      icon: KeyRoundIcon,
      title: t("credentialStorageSystem"),
      description: t("credentialStorageSystemDescription")
    }
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-5" data-testid="credential-storage-settings">
      <div>
        <h2 className="text-base font-semibold text-text-strong">{t("credentialStorageTitle")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
          {t("credentialStorageHint")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = status?.configuredMode === option.mode;
          const active = status?.activeMode === option.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={selected}
              disabled={!status || savingMode !== null}
              onClick={() => {
                if (option.mode === "system") {
                  setConfirmationMode("system");
                  return;
                }
                void configure(option.mode);
              }}
              className={`min-h-40 rounded-xl border p-5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                selected
                  ? "border-foreground/35 bg-surface-subtle"
                  : "border-border/70 bg-background hover:bg-surface-subtle/60"
              }`}
              data-testid={`credential-storage-option-${option.mode}`}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="flex size-9 items-center justify-center rounded-lg bg-background shadow-sm">
                  <Icon className="size-4 text-text-strong" />
                </span>
                {selected ? <CheckIcon className="size-4 text-emerald-600" /> : null}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text-strong">{option.title}</span>
                {option.mode === "application" ? (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    {t("credentialStorageApplicationRecommended")}
                  </span>
                ) : null}
                {active ? (
                  <span className="text-[11px] font-medium text-text-muted">
                    {t("credentialStorageActive")}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm leading-6 text-text-muted">{option.description}</p>
            </button>
          );
        })}
      </div>

      {!status ? (
        <p className="text-sm text-text-muted" data-testid="credential-storage-loading-state">
          {error === "load" ? t("credentialStorageLoadFailed") : t("credentialStorageLoading")}
        </p>
      ) : null}

      {confirmationMode === "system" ? (
        <div
          className="rounded-xl bg-surface-subtle p-4"
          data-testid="credential-storage-system-confirmation"
        >
          <h3 className="text-sm font-semibold text-text-strong">
            {t("credentialStorageSystemConfirmTitle")}
          </h3>
          <p className="mt-1 text-sm leading-6 text-text-muted">
            {t("credentialStorageSystemConfirmDescription")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
              disabled={savingMode !== null}
              onClick={() => void configure("system")}
              data-testid="credential-storage-system-confirm"
            >
              {t("credentialStorageSystemConfirmAction")}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm font-medium text-text-muted hover:bg-background"
              disabled={savingMode !== null}
              onClick={() => setConfirmationMode(null)}
            >
              {t("credentialStorageSystemConfirmCancel")}
            </button>
          </div>
        </div>
      ) : null}

      {status?.restartRequired ? (
        <p className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          {t("credentialStorageRestartRequired")}
        </p>
      ) : null}
      {error === "save" ? (
        <p className="text-sm text-destructive">{t("credentialStorageSaveFailed")}</p>
      ) : null}
    </div>
  );
}
