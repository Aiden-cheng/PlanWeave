import type { createTranslator } from "../i18n";
import type { WorkspaceAccessScopeOption } from "../hooks/useWorkspaceAccessScope";

export function WorkspaceAccessScopeSelector({
  options,
  selectedKey,
  loading,
  error,
  busy,
  t,
  onSelect
}: {
  options: readonly WorkspaceAccessScopeOption[];
  selectedKey: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="px-1 pb-4" data-testid="workspace-access-scope-selector">
      <label className="block min-w-0" htmlFor="workspace-access-scope">
        <span
          id="workspace-access-scope-label"
          className="block text-xs font-semibold text-text-strong"
        >
          {t("accessScopeLabel")}
        </span>
        <select
          id="workspace-access-scope"
          className="mt-2 h-9 w-full max-w-xl rounded-md border border-border bg-background px-3 text-sm text-text-strong outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={selectedKey ?? ""}
          disabled={loading || busy || options.length === 0}
          data-testid="workspace-access-scope-select"
          onChange={(event) => onSelect(event.target.value)}
        >
          {options.length === 0 ? <option value="">{t("accessScopeEmpty")}</option> : null}
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.projectLabel} / {option.canvasLabel}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {t("accessScopeLoading")}
        </p>
      ) : error ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
