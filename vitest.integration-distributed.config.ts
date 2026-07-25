import { createVitestConfig } from "./vitest.config";
import { testFilesForRoots } from "./vitest.suites";

/** Server + Agent Host integration (realProcess, lifecycle, operator, load recovery, …). */
export default createVitestConfig(
  testFilesForRoots("integration", [
    "packages/server/src/__tests__",
    "packages/agent-host/src/__tests__"
  ])
);
