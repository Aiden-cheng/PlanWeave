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
    expect(await store.read()).toEqual({
      lanSharingEnabled: true,
      exposureMode: "lan_http",
      preferredPort: null
    });

    await store.write({ lanSharingEnabled: true, preferredPort: 18_787 });

    expect(await new LocalCollaborationNetworkStore(path).read()).toEqual({
      lanSharingEnabled: true,
      exposureMode: "lan_http",
      preferredPort: 18_787
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 4,
      exposureMode: "lan_http",
      preferredPort: 18_787
    });
  });

  it("migrates the provider-specific private HTTPS mode to the generic mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-network-"));
    const path = join(root, "local-network.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 3,
        exposureMode: "tailscale_private",
        preferredPort: 18_787
      })}\n`
    );

    await expect(new LocalCollaborationNetworkStore(path).read()).resolves.toEqual({
      lanSharingEnabled: false,
      exposureMode: "private_https",
      preferredPort: 18_787
    });
  });

  it("migrates version 2 without changing its local exposure meaning", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-network-"));
    const path = join(root, "local-network.json");
    await writeFile(
      path,
      `${JSON.stringify({ version: 2, lanSharingEnabled: false, preferredPort: 18_787 })}\n`
    );
    await expect(new LocalCollaborationNetworkStore(path).read()).resolves.toEqual({
      lanSharingEnabled: false,
      exposureMode: "local_only",
      preferredPort: 18_787
    });
  });

  it("rejects custom HTTPS in the persisted local network state", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-network-"));
    const path = join(root, "local-network.json");
    await writeFile(
      path,
      `${JSON.stringify({ version: 3, exposureMode: "custom_https", preferredPort: null })}\n`
    );
    await expect(new LocalCollaborationNetworkStore(path).read()).rejects.toThrow(
      "local_collaboration_network_store_invalid"
    );
  });
});
