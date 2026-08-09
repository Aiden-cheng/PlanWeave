import { z } from "zod";

/** Authority boundary used by remote execution ownership and public read models. */
export const remoteExecutionControlPlaneSchema = z.enum(["collaboration", "owner"]);

export type RemoteExecutionControlPlane = z.infer<typeof remoteExecutionControlPlaneSchema>;
