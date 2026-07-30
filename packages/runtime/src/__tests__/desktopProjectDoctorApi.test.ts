import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDesktopProjectReference: vi.fn(),
  runProjectDoctor: vi.fn()
}));

vi.mock("../desktop/projectApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktop/projectApi.js")>()),
  resolveDesktopProjectReference: mocks.resolveDesktopProjectReference
}));

vi.mock("../taskManager/projectDoctor.js", () => ({
  runProjectDoctor: mocks.runProjectDoctor
}));

describe("desktop project doctor API", () => {
  beforeEach(() => {
    mocks.resolveDesktopProjectReference.mockReset();
    mocks.resolveDesktopProjectReference.mockResolvedValue({
      projectId: "project-a",
      projectRoot: "/tmp/project-a"
    });
    mocks.runProjectDoctor.mockReset();
    mocks.runProjectDoctor.mockResolvedValue({
      ok: true,
      repaired: false,
      errors: [],
      warnings: [],
      canvasReports: []
    });
  });

  it("runs checks read-only against the resolved registered project", async () => {
    const { checkDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");

    await checkDesktopProjectDoctor({ projectId: "project-a" });

    expect(mocks.resolveDesktopProjectReference).toHaveBeenCalledWith({ projectId: "project-a" });
    expect(mocks.runProjectDoctor).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-a",
      repair: false
    });
  });

  it("rejects raw paths before resolving or running Doctor", async () => {
    const { checkDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");

    await expect(checkDesktopProjectDoctor({ projectRoot: "/tmp/project-a" })).rejects.toThrow();

    expect(mocks.resolveDesktopProjectReference).not.toHaveBeenCalled();
    expect(mocks.runProjectDoctor).not.toHaveBeenCalled();
  });

  it("rejects project registry traversal before resolving or running Doctor", async () => {
    const { checkDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");

    await expect(checkDesktopProjectDoctor({ projectId: "../outside" })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: "nested/project" })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: "project\\outside" })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: "." })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: ".." })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: " project-a " })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: "project-a\0" })).rejects.toThrow();
    await expect(checkDesktopProjectDoctor({ projectId: "a".repeat(257) })).rejects.toThrow();

    expect(mocks.resolveDesktopProjectReference).not.toHaveBeenCalled();
    expect(mocks.runProjectDoctor).not.toHaveBeenCalled();
  });

  it("accepts registered project identities at the shared 256-character limit", async () => {
    const { checkDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");
    const projectId = "a".repeat(256);

    await checkDesktopProjectDoctor({ projectId });

    expect(mocks.resolveDesktopProjectReference).toHaveBeenCalledWith({ projectId });
  });

  it("rejects missing or incorrect repair confirmation before project resolution or mutation", async () => {
    const { repairDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");

    await expect(repairDesktopProjectDoctor({ projectId: "project-a" }, {})).rejects.toThrow();
    await expect(
      repairDesktopProjectDoctor({ projectId: "project-a" }, { confirmation: "repair" })
    ).rejects.toThrow();

    expect(mocks.resolveDesktopProjectReference).not.toHaveBeenCalled();
    expect(mocks.runProjectDoctor).not.toHaveBeenCalled();
  });

  it("runs repair only with the exact confirmation literal", async () => {
    const { repairDesktopProjectDoctor } = await import("../desktop/projectDoctorApi.js");

    await repairDesktopProjectDoctor(
      { projectId: "project-a" },
      { confirmation: "repair_project_runtime_drift" }
    );

    expect(mocks.runProjectDoctor).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-a",
      repair: true
    });
  });
});
