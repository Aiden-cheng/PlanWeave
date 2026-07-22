import { resolve } from "node:path";

export type ServerConfig = {
  dataDirectory: string;
  databasePath: string;
  busyTimeoutMs: number;
};

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDirectory = resolve(env.PLANWEAVE_SERVER_DATA_DIR?.trim() || ".planweave-server");
  const busyTimeoutMs = Number(env.PLANWEAVE_SERVER_BUSY_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60000) {
    throw new Error("PLANWEAVE_SERVER_BUSY_TIMEOUT_MS must be an integer between 1 and 60000.");
  }
  return {
    dataDirectory,
    databasePath: resolve(dataDirectory, "planweave-server.sqlite"),
    busyTimeoutMs
  };
}
