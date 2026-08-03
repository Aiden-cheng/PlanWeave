import { z } from "zod";

export function isDeploymentServerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function isLoopbackDeploymentHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

export function isPrivateDeploymentHostname(hostname: string): boolean {
  if (isLoopbackDeploymentHostname(hostname)) return true;
  const octets = hostname.split(".").map((part) => Number(part));
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [first, second] = octets as [number, number, number, number];
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return false;
}

export const deploymentServerOriginSchema = z
  .string()
  .url()
  .refine(isDeploymentServerOrigin, "serverOrigin must be an http(s) origin without a path");

export const deploymentTopologySchema = z.enum([
  "loopback_http",
  "lan_http",
  "loopback_https",
  "lan_https",
  "tailscale_https",
  "public_https"
]);
export type DeploymentTopology = z.infer<typeof deploymentTopologySchema>;

export const deploymentTlsTrustSchema = z.enum(["not_applicable", "system_ca", "configured_ca"]);
export type DeploymentTlsTrust = z.infer<typeof deploymentTlsTrustSchema>;

const allowedClientOriginsSchema = z
  .array(deploymentServerOriginSchema)
  .min(1)
  .max(32)
  .superRefine((origins, context) => {
    if (new Set(origins).size !== origins.length) {
      context.addIssue({ code: "custom", message: "duplicate_allowed_client_origin" });
    }
  });

function originPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function validateDeploymentEndpoint(
  value: {
    topology: DeploymentTopology;
    serverOrigin: string;
    allowedClientOrigins: string[];
    tlsTrust: DeploymentTlsTrust;
  },
  context: z.RefinementCtx
): void {
  const url = new URL(value.serverOrigin);
  const loopback = isLoopbackDeploymentHostname(url.hostname);
  const originsMatch = (protocol: "http:" | "https:", allowed: (url: URL) => boolean) =>
    value.allowedClientOrigins.every((origin) => {
      const client = new URL(origin);
      return client.protocol === protocol && allowed(client);
    });

  if (value.topology === "loopback_http") {
    if (
      url.protocol !== "http:" ||
      !loopback ||
      value.tlsTrust !== "not_applicable" ||
      !originsMatch("http:", (client) => isLoopbackDeploymentHostname(client.hostname))
    ) {
      context.addIssue({
        code: "custom",
        message: "loopback_http_requires_loopback_http_origins_without_tls",
        path: ["serverOrigin"]
      });
    }
    return;
  }
  if (value.topology === "lan_http") {
    if (
      url.protocol !== "http:" ||
      loopback ||
      !isPrivateDeploymentHostname(url.hostname) ||
      value.tlsTrust !== "not_applicable" ||
      !originsMatch(
        "http:",
        (client) =>
          !isLoopbackDeploymentHostname(client.hostname) &&
          isPrivateDeploymentHostname(client.hostname)
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "lan_http_requires_private_http_origins_without_tls",
        path: ["serverOrigin"]
      });
    }
    return;
  }
  if (value.topology === "loopback_https") {
    if (
      url.protocol !== "https:" ||
      !loopback ||
      value.tlsTrust === "not_applicable" ||
      !originsMatch("https:", (client) => isLoopbackDeploymentHostname(client.hostname))
    ) {
      context.addIssue({
        code: "custom",
        message: "loopback_https_requires_trusted_loopback_https_origins",
        path: ["serverOrigin"]
      });
    }
    return;
  }
  if (value.topology === "tailscale_https") {
    if (
      url.protocol !== "https:" ||
      loopback ||
      !url.hostname.toLowerCase().endsWith(".ts.net") ||
      originPort(url) !== 443 ||
      value.tlsTrust !== "system_ca" ||
      !originsMatch(
        "https:",
        (client) =>
          !isLoopbackDeploymentHostname(client.hostname) &&
          client.hostname.toLowerCase().endsWith(".ts.net") &&
          originPort(client) === 443
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "tailscale_https_requires_system_ca_ts_net_port_443_origins",
        path: ["serverOrigin"]
      });
    }
    return;
  }
  if (
    url.protocol !== "https:" ||
    loopback ||
    value.tlsTrust === "not_applicable" ||
    !originsMatch("https:", (client) => !isLoopbackDeploymentHostname(client.hostname))
  ) {
    context.addIssue({
      code: "custom",
      message: "network_topology_requires_trusted_non_loopback_https_origins",
      path: ["serverOrigin"]
    });
  }
  if (value.topology === "public_https" && originPort(url) !== 443) {
    context.addIssue({
      code: "custom",
      message: "public_https_requires_direct_tls_port_443",
      path: ["serverOrigin"]
    });
  }
}

export const deploymentEndpointSchema = z
  .object({
    topology: deploymentTopologySchema,
    serverOrigin: deploymentServerOriginSchema,
    allowedClientOrigins: allowedClientOriginsSchema,
    tlsTrust: deploymentTlsTrustSchema
  })
  .strict()
  .superRefine(validateDeploymentEndpoint);
export type DeploymentEndpoint = z.infer<typeof deploymentEndpointSchema>;
