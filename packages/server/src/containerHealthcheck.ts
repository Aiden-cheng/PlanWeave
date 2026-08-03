import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { loadServerConfig } from "./config.js";

const requestTimeoutMs = 5_000;

async function checkReadiness(): Promise<void> {
  const configPath = process.env.PLANWEAVE_SERVER_CONFIG;
  if (!configPath) throw new Error("container_healthcheck_config_missing");
  const config = await loadServerConfig(configPath);
  if (config.transport.mode !== "direct_https") {
    throw new Error("container_healthcheck_direct_https_required");
  }
  const endpoint = new URL(config.transport.advertisedOrigin);
  const certificateAuthority =
    config.deployment?.tlsTrust === "configured_ca"
      ? await readFile(config.transport.listener.tls.certificatePath)
      : undefined;
  await new Promise<void>((resolve, reject) => {
    const healthcheck = request(
      {
        host: "127.0.0.1",
        port: config.transport.listener.port,
        servername: endpoint.hostname,
        path: "/readyz",
        method: "GET",
        ca: certificateAuthority,
        rejectUnauthorized: true,
        timeout: requestTimeoutMs
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          if (response.statusCode === 200) resolve();
          else reject(new Error("container_healthcheck_not_ready"));
        });
      }
    );
    healthcheck.once("timeout", () =>
      healthcheck.destroy(new Error("container_healthcheck_timeout"))
    );
    healthcheck.once("error", reject);
    healthcheck.end();
  });
}

try {
  await checkReadiness();
} catch {
  process.exitCode = 1;
}
