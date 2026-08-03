import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

export type CollaborationDiagnosticsDetailsProps = {
  enabled: boolean;
  report: string;
  t: ReturnType<typeof createTranslator>;
  onCopy?: (report: string) => Promise<void>;
  testIdPrefix: string;
};

/** Flat, collapsed troubleshooting output containing only allowlisted diagnostic fields. */
export function CollaborationDiagnosticsDetails({
  enabled,
  report,
  t,
  onCopy,
  testIdPrefix
}: CollaborationDiagnosticsDetailsProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  if (!enabled) return null;

  return (
    <details
      className="border-y border-border/70 py-3"
      data-testid={testIdPrefix}
      onToggle={() => {
        setCopied(false);
        setCopyError(false);
      }}
    >
      <summary className="cursor-pointer select-none text-xs font-semibold text-text-strong">
        {t("peopleConnectionDiagnostics")}
      </summary>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {t("peopleConnectionDiagnosticsHint")}
      </p>
      <pre
        className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all border-y border-border/60 py-3 font-mono text-[11px] leading-5 text-muted-foreground"
        data-testid={`${testIdPrefix}-report`}
      >
        {report}
      </pre>
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs"
          data-testid={`${testIdPrefix}-copy`}
          disabled={!onCopy}
          onClick={() => {
            if (!onCopy) return;
            void (async () => {
              try {
                await onCopy(report);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopied(false);
                setCopyError(true);
              }
            })();
          }}
        >
          {copied ? t("peopleConnectionDiagnosticsCopied") : t("peopleConnectionDiagnosticsCopy")}
        </Button>
        {copyError ? (
          <span className="text-xs text-destructive" role="alert">
            {t("peopleConnectionDiagnosticsCopyFailed")}
          </span>
        ) : null}
      </div>
    </details>
  );
}
