import { createVitestConfig } from "./vitest.config";
import { testFilesForIntegrationShard } from "./vitest.suites";

/** Server + Agent Host integration (realProcess, lifecycle, operator, load recovery, …). */
export default createVitestConfig(testFilesForIntegrationShard("distributed"));
