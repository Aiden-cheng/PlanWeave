import { z } from "zod";

export const serverReadinessStatusSchema = z.enum([
  "starting",
  "migrating",
  "reconciling",
  "listening",
  "ready",
  "draining"
]);

const schemaVersionSchema = z.number().int().positive();

export const serverReadinessSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), schemaVersion: schemaVersionSchema }).strict(),
  z
    .object({
      status: z.enum(["starting", "migrating", "reconciling", "listening", "draining"]),
      schemaVersion: schemaVersionSchema.optional()
    })
    .strict()
]);

export type ServerReadiness = z.infer<typeof serverReadinessSchema>;
export type ServerReadinessStatus = z.infer<typeof serverReadinessStatusSchema>;

const transitions: Readonly<Record<ServerReadinessStatus, readonly ServerReadinessStatus[]>> = {
  starting: ["migrating", "draining"],
  migrating: ["reconciling", "draining"],
  reconciling: ["listening", "ready", "draining"],
  listening: ["ready", "draining"],
  ready: ["draining"],
  draining: []
};

export class ServerReadinessController {
  private current: ServerReadiness = { status: "starting" };

  readiness(): ServerReadiness {
    return serverReadinessSchema.parse(this.current);
  }

  transition(status: ServerReadinessStatus, schemaVersion?: number): ServerReadiness {
    if (status === this.current.status) {
      if (schemaVersion === undefined) return this.readiness();
      this.current = serverReadinessSchema.parse({ status, schemaVersion });
      return this.readiness();
    }
    if (!transitions[this.current.status].includes(status)) {
      throw new Error("server_readiness_transition_invalid");
    }
    this.current = serverReadinessSchema.parse({
      status,
      schemaVersion: schemaVersion ?? this.current.schemaVersion
    });
    return this.readiness();
  }
}
