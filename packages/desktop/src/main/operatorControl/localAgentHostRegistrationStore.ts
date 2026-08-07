import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const registrationSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    workspaceId: z.string().trim().min(1).max(128),
    updatedAt: z.iso.datetime()
  })
  .strict();

const documentSchema = z
  .object({
    version: z.literal(1),
    registrations: z.array(registrationSchema).max(128)
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, registration] of value.registrations.entries()) {
      if (seen.has(registration.profileId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate local Agent Host profile",
          path: ["registrations", index, "profileId"]
        });
      }
      seen.add(registration.profileId);
    }
  });

export type LocalAgentHostRegistration = z.infer<typeof registrationSchema>;

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class LocalAgentHostRegistrationStore {
  private loaded: z.infer<typeof documentSchema> | null = null;

  constructor(
    private readonly filePath: string = desktopHomePaths().operatorLocalAgentHostsFile,
    private readonly clock: { now(): Date } = { now: () => new Date() }
  ) {}

  private async readDocument(): Promise<z.infer<typeof documentSchema>> {
    if (this.loaded) return this.loaded;
    try {
      this.loaded = documentSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (!isMissingFile(error))
        throw new Error("local_agent_host_store_invalid", { cause: error });
      this.loaded = { version: 1, registrations: [] };
    }
    return this.loaded;
  }

  async get(profileId: string): Promise<LocalAgentHostRegistration | null> {
    return (
      (await this.readDocument()).registrations.find((item) => item.profileId === profileId) ?? null
    );
  }

  async latest(): Promise<LocalAgentHostRegistration | null> {
    return (await this.readDocument()).registrations.at(-1) ?? null;
  }

  async upsert(profileId: string, workspaceId: string): Promise<LocalAgentHostRegistration> {
    const current = await this.readDocument();
    const registration = registrationSchema.parse({
      profileId,
      workspaceId,
      updatedAt: this.clock.now().toISOString()
    });
    const document = documentSchema.parse({
      version: 1,
      registrations: [
        ...current.registrations.filter((item) => item.profileId !== profileId),
        registration
      ]
    });
    await this.writeDocument(document);
    return registration;
  }

  async remove(profileId: string): Promise<void> {
    const current = await this.readDocument();
    if (!current.registrations.some((item) => item.profileId === profileId)) return;
    await this.writeDocument(
      documentSchema.parse({
        version: 1,
        registrations: current.registrations.filter((item) => item.profileId !== profileId)
      })
    );
  }

  private async writeDocument(document: z.infer<typeof documentSchema>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM") throw error;
    });
    this.loaded = document;
  }
}
