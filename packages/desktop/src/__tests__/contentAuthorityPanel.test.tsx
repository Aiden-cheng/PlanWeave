/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import {
  contentVersionDesktopReadModelSchema,
  type ContentVersionDesktopReadModel
} from "@planweave-ai/collaboration-contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentAuthorityPanel } from "../renderer/collaboration/ContentAuthorityPanel";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function materializableModel(): ContentVersionDesktopReadModel {
  const canonicalDigest = "a".repeat(64);
  const content = {
    versionId: `version-${canonicalDigest}`,
    canonicalDigest,
    verification: "complete" as const
  };
  return contentVersionDesktopReadModelSchema.parse({
    authoritativeHead: {
      schemaVersion: "content-version/v1",
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      revision: 1,
      content,
      advancedAt: "2026-07-31T00:00:00.000Z"
    },
    localReplica: null,
    replicaStatus: "snapshot_required",
    lastAcknowledgement: null,
    canPublishInitial: false,
    canMaterialize: true,
    canRecover: true,
    offlineWriteReason: null
  });
}

describe("ContentAuthorityPanel", () => {
  it("refreshes the local project and reports success after materializing the authority head", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const api = {
      bindCollaborationContentAuthority: vi.fn().mockResolvedValue(model),
      materializeCollaborationContentHead: vi.fn().mockResolvedValue({
        ...model,
        localReplica: model.authoritativeHead?.content ?? null,
        replicaStatus: "in_sync"
      })
    } as unknown as PlanWeaveCollaborationApi;
    const onMaterialized = vi.fn().mockResolvedValue(undefined);

    render(
      <ContentAuthorityPanel
        api={api}
        canvasId="default"
        connected
        onMaterialized={onMaterialized}
        t={createTranslator("en")}
      />
    );

    await user.click(
      await screen.findByRole("button", { name: "Restore from authoritative version" })
    );

    await waitFor(() => expect(onMaterialized).toHaveBeenCalledTimes(1));
    expect(api.materializeCollaborationContentHead).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "The authoritative version is synced to this device and the project view has been refreshed."
      )
    ).toBeInTheDocument();
  });

  it("keeps the materialized model but does not report refresh success when the project refresh fails", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const api = {
      bindCollaborationContentAuthority: vi.fn().mockResolvedValue(model),
      materializeCollaborationContentHead: vi.fn().mockResolvedValue({
        ...model,
        localReplica: model.authoritativeHead?.content ?? null,
        replicaStatus: "in_sync"
      })
    } as unknown as PlanWeaveCollaborationApi;
    const onMaterialized = vi.fn().mockRejectedValue(new Error("project_refresh_failed"));

    render(
      <ContentAuthorityPanel
        api={api}
        canvasId="default"
        connected
        onMaterialized={onMaterialized}
        t={createTranslator("en")}
      />
    );

    await user.click(
      await screen.findByRole("button", { name: "Restore from authoritative version" })
    );

    await waitFor(() => expect(screen.getByText("project_refresh_failed")).toBeInTheDocument());
    expect(api.materializeCollaborationContentHead).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Replica: in_sync")).toBeInTheDocument();
    expect(screen.queryByText(/project view has been refreshed/i)).not.toBeInTheDocument();
  });
});
