import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDurableStateForReenrollment,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import { ensureHostInstallationIdentity } from "../state/hostInstallationIdentity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Agent Host installation identity", () => {
  it("survives credential-generation durable state cleanup with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-host-installation-"));
    directories.push(directory);
    const dataDirectory = join(directory, "data");
    const first = await ensureHostInstallationIdentity(dataDirectory);
    await ensureDurableHostIdentity(dataDirectory, "host-generation-one", "workspace-one");

    await clearDurableStateForReenrollment(dataDirectory);

    expect(await ensureHostInstallationIdentity(dataDirectory)).toBe(first);
    expect((await stat(join(dataDirectory, "installation.json"))).mode & 0o777).toBe(0o600);
  });
});
