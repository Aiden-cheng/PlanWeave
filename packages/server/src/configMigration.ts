import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  parseServerConfigDocumentBytes,
  serverConfigFileInput,
  type LoadedServerConfigDocument,
  type ServerConfigInputVersion
} from "./config.js";

export type ServerConfigMigrationResult = {
  schemaVersion: "server-config-migration/v1";
  configPath: string;
  fromVersion: ServerConfigInputVersion;
  toVersion: "server-config/v2";
  changed: boolean;
};

function pathError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error("server_config_path_not_found", { cause: error });
  if (code === "ELOOP") {
    return new Error("server_config_path_symlink_not_allowed", { cause: error });
  }
  return new Error("server_config_path_unreadable", { cause: error });
}

async function regularFileMetadata(configPath: string): Promise<BigIntStats> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(configPath, { bigint: true });
  } catch (error) {
    throw pathError(error);
  }
  if (metadata.isSymbolicLink()) throw new Error("server_config_path_symlink_not_allowed");
  if (!metadata.isFile()) throw new Error("server_config_path_not_file");
  return metadata;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Explicitly rewrites one validated v1 config without changing its normalized transport. */
export async function migrateServerConfigFile(
  configPath: string
): Promise<ServerConfigMigrationResult> {
  if (!isAbsolute(configPath)) throw new Error("server_config_path_must_be_absolute");
  const pathMetadata = await regularFileMetadata(configPath);
  let handle: FileHandle;
  try {
    handle = await open(
      configPath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
  } catch (error) {
    throw pathError(error);
  }

  let sourceMetadata: BigIntStats;
  let document: LoadedServerConfigDocument;
  try {
    const beforeRead = await handle.stat({ bigint: true });
    if (!beforeRead.isFile()) throw new Error("server_config_path_not_file");
    if (!sameFile(pathMetadata, beforeRead))
      throw new Error("server_config_changed_during_migration");
    const bytes = await handle.readFile();
    sourceMetadata = await handle.stat({ bigint: true });
    if (!sameContentVersion(beforeRead, sourceMetadata)) {
      throw new Error("server_config_changed_during_migration");
    }
    document = parseServerConfigDocumentBytes(bytes);
  } finally {
    await handle.close();
  }

  if (document.sourceVersion === "server-config/v2") {
    return {
      schemaVersion: "server-config-migration/v1",
      configPath,
      fromVersion: document.sourceVersion,
      toVersion: "server-config/v2",
      changed: false
    };
  }

  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.migrate`
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(serverConfigFileInput(document.config), null, 2)}\n`,
      { flag: "wx", mode: Number(sourceMetadata.mode & 0o777n) }
    );
    if (process.platform !== "win32") {
      await chown(temporaryPath, Number(sourceMetadata.uid), Number(sourceMetadata.gid));
    }
    await chmod(temporaryPath, Number(sourceMetadata.mode & 0o777n));
    if (!sameContentVersion(sourceMetadata, await regularFileMetadata(configPath))) {
      throw new Error("server_config_changed_during_migration");
    }
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    schemaVersion: "server-config-migration/v1",
    configPath,
    fromVersion: document.sourceVersion,
    toVersion: "server-config/v2",
    changed: true
  };
}
