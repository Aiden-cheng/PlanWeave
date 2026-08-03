import { createVitestConfig } from "./vitest.config";
import { testFilesForIntegrationShard } from "./vitest.suites";

export default createVitestConfig(testFilesForIntegrationShard("core"));
