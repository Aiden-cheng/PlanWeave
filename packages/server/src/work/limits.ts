/** Public assignment wire budgets are owned by collaboration-protocol. */
export {
  WORK_ASSIGNMENT_BATCH_MAX,
  WORK_HOST_DISPLAY_NAME_MAX_LENGTH,
  WORK_HOST_DISPLAY_NAME_MIN_LENGTH
} from "@planweave-ai/collaboration-protocol/core/limits";

/** Reuse the public identity assignment-reason budget. */
export { HUMAN_ASSIGN_REASON_MAX_LENGTH as WORK_ASSIGN_REASON_MAX_LENGTH } from "../identity/limits.js";

/** Revision 0 means no durable assignment row exists yet. */
export const WORK_ASSIGNMENT_INITIAL_REVISION = 0 as const;
