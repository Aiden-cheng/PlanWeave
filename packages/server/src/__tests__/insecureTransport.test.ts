import { describe, expect, it } from "vitest";
import {
  createTransportAdmissionPolicyForMode,
  humanNetworkTransportAllowed,
  isPrivateNetworkAddress
} from "../insecureTransport.js";

describe("private-network insecure transport", () => {
  it("recognizes loopback, RFC1918, link-local, and private IPv6 addresses", () => {
    for (const address of [
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "169.254.10.20",
      "fd12::1",
      "fe80::1"
    ]) {
      expect(isPrivateNetworkAddress(address), address).toBe(true);
    }
  });

  it("keeps public or malformed HTTP peers outside the explicit LAN exception", () => {
    const directHttps = createTransportAdmissionPolicyForMode("direct_https");
    const lanHttp = createTransportAdmissionPolicyForMode("lan_http");
    for (const address of ["8.8.8.8", "172.32.0.1", "203.0.113.10", "fc-not-an-ip", undefined]) {
      expect(isPrivateNetworkAddress(address), String(address)).toBe(false);
      expect(
        humanNetworkTransportAllowed({ remoteAddress: address }, lanHttp),
        String(address)
      ).toBe(false);
    }
    expect(humanNetworkTransportAllowed({ remoteAddress: "192.168.1.20" }, directHttps)).toBe(
      false
    );
    expect(humanNetworkTransportAllowed({ remoteAddress: "192.168.1.20" }, lanHttp)).toBe(true);
    expect(
      humanNetworkTransportAllowed({ encrypted: true, remoteAddress: "8.8.8.8" }, directHttps)
    ).toBe(true);
  });
});
