import { runProjectDoctor } from "../taskManager/projectDoctor.js";
import type { ProjectDoctorReport } from "../types.js";
import {
  desktopProjectDoctorRepairConfirmationSchema,
  desktopProjectReferenceSchema
} from "./types/desktopBridgeInputSchemas.js";
import { resolveDesktopProjectReference } from "./projectApi.js";

export async function checkDesktopProjectDoctor(input: unknown): Promise<ProjectDoctorReport> {
  const reference = desktopProjectReferenceSchema.parse(input);
  const project = await resolveDesktopProjectReference(reference);
  return runProjectDoctor({ projectRoot: project.projectRoot, repair: false });
}

export async function repairDesktopProjectDoctor(
  referenceInput: unknown,
  confirmationInput: unknown
): Promise<ProjectDoctorReport> {
  desktopProjectDoctorRepairConfirmationSchema.parse(confirmationInput);
  const reference = desktopProjectReferenceSchema.parse(referenceInput);
  const project = await resolveDesktopProjectReference(reference);
  return runProjectDoctor({ projectRoot: project.projectRoot, repair: true });
}
