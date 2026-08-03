import suiteManifest from "./vitest.suites.json";

export type TestSuiteName = "unit" | "integration" | "platform" | "performance";
export type IntegrationShardName = "cli" | "core" | "distributed";

export function testFilesFor(suite: TestSuiteName): string[] {
  return suiteManifest.groups.flatMap((group) =>
    group[suite].map((fileName) => `${group.root}/${fileName}`)
  );
}

export function testFilesForRoots(suite: TestSuiteName, roots: string[]): string[] {
  const selectedRoots = new Set(roots);
  return suiteManifest.groups.flatMap((group) => {
    if (!selectedRoots.has(group.root)) return [];
    return group[suite].map((fileName) => `${group.root}/${fileName}`);
  });
}

export function testFilesForIntegrationShard(shard: IntegrationShardName): string[] {
  return testFilesForRoots("integration", suiteManifest.integrationShards[shard]);
}
