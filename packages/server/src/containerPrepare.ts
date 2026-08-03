import { chown, chmod, copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadServerConfig, serverConfigFileInput, serverConfigSchema } from "./config.js";

const inputConfigPath = "/run/planweave/input/config/server.json";
const inputTlsDirectory = "/run/planweave/input/tls";
const runtimeDirectory = "/run/planweave/runtime";
const stateDirectory = "/var/lib/planweave-server";
const nodeOwner = { uid: 1_000, gid: 1_000 };

export type ContainerPrepareOptions = {
  inputConfigPath?: string;
  inputTlsDirectory?: string;
  runtimeDirectory?: string;
  stateDirectory?: string;
  owner?: { uid: number; gid: number };
};

async function initializeOwnedDirectory(
  directory: string,
  owner: { uid: number; gid: number }
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.uid === owner.uid && metadata.gid === owner.gid) return;
  if (metadata.uid !== 0 || metadata.gid !== 0 || (await readdir(directory)).length !== 0) {
    throw new Error("server_container_state_owner_invalid");
  }
  await chown(directory, owner.uid, owner.gid);
  await chmod(directory, 0o700);
}

async function initializeEmptyRuntimeDirectory(
  directory: string,
  owner: { uid: number; gid: number }
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  const ownedByInitializer = metadata.uid === 0 && metadata.gid === 0;
  const ownedByRuntime = metadata.uid === owner.uid && metadata.gid === owner.gid;
  if ((!ownedByInitializer && !ownedByRuntime) || (await readdir(directory)).length !== 0) {
    throw new Error("server_container_runtime_directory_invalid");
  }
  await chmod(directory, 0o700);
}

/** Prepares private runtime material without logging configuration or credential contents. */
export async function prepareContainerRuntime(
  options: ContainerPrepareOptions = {}
): Promise<void> {
  const configPath = options.inputConfigPath ?? inputConfigPath;
  const tlsDirectory = options.inputTlsDirectory ?? inputTlsDirectory;
  const runtime = options.runtimeDirectory ?? runtimeDirectory;
  const state = options.stateDirectory ?? stateDirectory;
  const owner = options.owner ?? nodeOwner;
  const certificatePath = join(tlsDirectory, "server.crt");
  const privateKeyPath = join(tlsDirectory, "server.key");
  const config = await loadServerConfig(configPath);
  if (config.transport.mode !== "direct_https") {
    throw new Error("server_container_direct_https_required");
  }
  if (
    config.transport.listener.tls.certificatePath !== certificatePath ||
    config.transport.listener.tls.privateKeyPath !== privateKeyPath
  ) {
    throw new Error("server_container_tls_path_mismatch");
  }
  if (config.dataDirectory !== state) throw new Error("server_container_state_directory_mismatch");

  await initializeEmptyRuntimeDirectory(runtime, owner);
  await initializeOwnedDirectory(state, owner);
  const runtimeTlsDirectory = join(runtime, "tls");
  await mkdir(runtimeTlsDirectory, { mode: 0o700 });
  const runtimeCertificatePath = join(runtimeTlsDirectory, "server.crt");
  const runtimePrivateKeyPath = join(runtimeTlsDirectory, "server.key");
  await Promise.all([
    copyFile(certificatePath, runtimeCertificatePath),
    copyFile(privateKeyPath, runtimePrivateKeyPath)
  ]);
  await Promise.all([chmod(runtimeCertificatePath, 0o600), chmod(runtimePrivateKeyPath, 0o600)]);
  const runtimeConfig = serverConfigSchema.parse({
    ...config,
    transport: {
      ...config.transport,
      listener: {
        ...config.transport.listener,
        tls: {
          certificatePath: runtimeCertificatePath,
          privateKeyPath: runtimePrivateKeyPath
        }
      }
    }
  });
  const runtimeConfigInput = serverConfigFileInput(runtimeConfig);
  const runtimeConfigPath = join(runtime, "server.json");
  await writeFile(runtimeConfigPath, `${JSON.stringify(runtimeConfigInput)}\n`, { mode: 0o600 });
  await chmod(runtimeConfigPath, 0o600);
  await Promise.all([
    chown(runtimeCertificatePath, owner.uid, owner.gid),
    chown(runtimePrivateKeyPath, owner.uid, owner.gid),
    chown(runtimeConfigPath, owner.uid, owner.gid),
    chown(runtimeTlsDirectory, owner.uid, owner.gid)
  ]);
  await chown(runtime, owner.uid, owner.gid);
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  await prepareContainerRuntime();
}
