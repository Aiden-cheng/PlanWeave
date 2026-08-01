import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCollaborationNetworkStore } from "../main/collaboration/LocalCollaborationNetworkStore";

describe("LocalCollaborationNetworkStore", () => {
  it("migrates the legacy LAN switch and persists the advertised port", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-network-"));
    const path = join(root, "collaboration", "local-network.json");
    await mkdir(join(root, "collaboration"), { recursive: true });
    await writeFile(path, `${JSON.stringify({ version: 1, lanSharingEnabled: true })}\n`);

    const store = new LocalCollaborationNetworkStore(path);
    expect(await store.read()).toEqual({ lanSharingEnabled: true, preferredPort: null });

    await store.write({ lanSharingEnabled: true, preferredPort: 18_787 });

    expect(await new LocalCollaborationNetworkStore(path).read()).toEqual({
      lanSharingEnabled: true,
      preferredPort: 18_787
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 2,
      lanSharingEnabled: true,
      preferredPort: 18_787
    });
  });
});
