import type { ReactNode } from "react";
import type { createTranslator } from "../i18n";

export function WorkspaceManagementPanel({
  connection,
  hostedCanvases,
  contentAuthority,
  t
}: {
  connection: ReactNode;
  hostedCanvases: ReactNode;
  contentAuthority: ReactNode;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section className="flex min-w-0 flex-col" data-testid="people-workspace-management">
      <p className="max-w-3xl pb-6 text-sm leading-6 text-text-muted">
        {t("peopleRemoteWorkspaceDescription")}
      </p>

      <div className="py-6" data-testid="people-workspace-connection-section">
        {connection}
      </div>
      <div className="pt-7" data-testid="people-workspace-hosting-section">
        {hostedCanvases}
      </div>
      <div data-testid="people-workspace-content-section">{contentAuthority}</div>
    </section>
  );
}
