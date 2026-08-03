import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeFileNotFoundError } from "./fs/optionalFile.js";
import { resolvePlanweaveHome } from "./paths.js";

function globalPromptPath(): string {
  return join(resolvePlanweaveHome(), "config", "global-prompt.md");
}

export async function readGlobalPrompt(): Promise<string> {
  try {
    return await readFile(globalPromptPath(), "utf8");
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return "";
    throw error;
  }
}

export async function updateGlobalPrompt(markdown: string): Promise<string> {
  const path = globalPromptPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return markdown;
}
