import { z } from "zod";

export const hostEnrollmentCodeSchema = z.string().regex(/^pw_enroll_[A-Za-z0-9_-]{43}$/);
export const hostCredentialTokenSchema = z.string().regex(/^pw_host_[A-Za-z0-9_-]{43}$/);
