import { describe, expect, it, vi } from "vitest";
import { restorePersistedCollaborationSession } from "../main/collaboration/persistedCollaborationSessionRecovery.js";

describe("restorePersistedCollaborationSession", () => {
  it("reconnects an active persisted remote profile during app startup", async () => {
    const connectSession = vi.fn(async () => undefined);
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "remote-workspace",
        profiles: [{ profileId: "remote-workspace", hasDeviceCredential: true }],
        session: { phase: "idle" }
      })),
      connectSession
    };

    await expect(restorePersistedCollaborationSession(service)).resolves.toBe(true);

    expect(connectSession).toHaveBeenCalledOnce();
    expect(connectSession).toHaveBeenCalledWith({ profileId: "remote-workspace" });
  });

  it("does not reconnect an already active session", async () => {
    const connectSession = vi.fn(async () => undefined);
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "remote-workspace",
        profiles: [{ profileId: "remote-workspace", hasDeviceCredential: true }],
        session: { phase: "connected" }
      })),
      connectSession
    };

    await expect(restorePersistedCollaborationSession(service)).resolves.toBe(false);
    expect(connectSession).not.toHaveBeenCalled();
  });

  it("does not reconnect a profile without a persisted credential", async () => {
    const connectSession = vi.fn(async () => undefined);
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "remote-workspace",
        profiles: [{ profileId: "remote-workspace", hasDeviceCredential: false }],
        session: { phase: "idle" }
      })),
      connectSession
    };

    await expect(restorePersistedCollaborationSession(service)).resolves.toBe(false);
    expect(connectSession).not.toHaveBeenCalled();
  });
});
