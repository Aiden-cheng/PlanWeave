import { describe, expect, it } from "vitest";
import type { DispatchRecord, DispatchWriteback } from "../dispatches.js";
import * as serverApi from "../index.js";

/** Compile-time guard: residual packageRef must not return to public DTOs. */
type AssertNoPackageRefKey<T> = "packageRef" extends keyof T ? never : true;
const _dispatchRecordHasNoPackageRef: AssertNoPackageRefKey<DispatchRecord> = true;
const _writebackCompleteHasNoPackageRef: AssertNoPackageRefKey<
  Parameters<DispatchWriteback["complete"]>[0]
> = true;
const _writebackFailHasNoPackageRef: AssertNoPackageRefKey<
  Parameters<DispatchWriteback["fail"]>[0]
> = true;
void _dispatchRecordHasNoPackageRef;
void _writebackCompleteHasNoPackageRef;
void _writebackFailHasNoPackageRef;

describe("server public export surface", () => {
  it("exports remote coordination and omits the retired thin dual factory", () => {
    expect(typeof serverApi.createRemoteBlockCoordination).toBe("function");
    expect(typeof serverApi.startRemoteBlockCoordinationServer).toBe("function");
    expect(serverApi).not.toHaveProperty("createDistributedCoordination");
    expect(serverApi).not.toHaveProperty("DistributedCoordinationOptions");
  });

  it("keeps DispatchService as the application-layer host-facing dispatch authority", () => {
    expect(typeof serverApi.DispatchService).toBe("function");
    expect(serverApi.dispatchStatusSchema).toBeDefined();
  });
});
