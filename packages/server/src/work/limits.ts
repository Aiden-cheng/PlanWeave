/**
 * Bounds for work assignment contracts (coordination metadata only).
 * Assignment never mutates Plan Package content and never stores secrets.
 */

/** Reuse identity assign-reason budget for optional reassignment notes. */
export { HUMAN_ASSIGN_REASON_MAX_LENGTH as WORK_ASSIGN_REASON_MAX_LENGTH } from "../identity/limits.js";

/** Host display name budget for assignment projections (aligned with AgentHostRepository). */
export const WORK_HOST_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const WORK_HOST_DISPLAY_NAME_MAX_LENGTH = 128 as const;

/** Maximum WorkItemRefs accepted in one batch read/update command (B-002 APIs). */
export const WORK_ASSIGNMENT_BATCH_MAX = 100 as const;

/**
 * Revision 0 means "no durable assignment row yet".
 * First successful assign/unassign write becomes revision 1.
 */
export const WORK_ASSIGNMENT_INITIAL_REVISION = 0 as const;
