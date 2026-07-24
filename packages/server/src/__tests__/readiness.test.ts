import { describe, expect, it } from "vitest";
import { ServerReadinessController } from "../readiness.js";

describe("server readiness", () => {
  it("moves through startup to ready without requiring an online host", () => {
    const readiness = new ServerReadinessController();
    expect(readiness.readiness()).toEqual({ status: "starting" });
    readiness.transition("migrating");
    readiness.transition("reconciling", 15);
    readiness.transition("listening");
    expect(readiness.transition("ready")).toEqual({ status: "ready", schemaVersion: 15 });
    expect(readiness.transition("draining")).toEqual({
      status: "draining",
      schemaVersion: 15
    });
  });

  it("rejects invalid lifecycle transitions", () => {
    const readiness = new ServerReadinessController();
    expect(() => readiness.transition("ready")).toThrow("server_readiness_transition_invalid");
  });
});
