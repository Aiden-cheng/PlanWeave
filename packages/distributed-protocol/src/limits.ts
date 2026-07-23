/**
 * Wire and envelope byte/count limits shared by Execution Envelope schemas.
 * String budgets are UTF-8 bytes. Identifier token limits live with their schemas.
 */

/** Maximum length of a source revision or graph fingerprint token. */
export const SOURCE_IDENTITY_MAX_LENGTH = 256 as const;

/** Maximum rendered Block prompt size carried in one envelope. */
export const RENDERED_PROMPT_MAX_LENGTH = 512_000 as const;

/** Maximum length of one acceptance requirement line. */
export const ACCEPTANCE_ITEM_MAX_LENGTH = 4_096 as const;

/** Maximum acceptance requirement lines on one envelope. */
export const ACCEPTANCE_MAX_COUNT = 128 as const;

/** Maximum length of one dependency result summary string. */
export const DEPENDENCY_SUMMARY_MAX_LENGTH = 4_096 as const;

/** Maximum dependency result summaries on one envelope. */
export const DEPENDENCY_SUMMARY_MAX_COUNT = 256 as const;

/** Maximum dispatch-scoped input artifact references on one envelope. */
export const INPUT_ARTIFACT_MAX_COUNT = 256 as const;

/** Maximum length of a logical input artifact name. */
export const INPUT_ARTIFACT_NAME_MAX_LENGTH = 256 as const;

/** Maximum ACP session config options requested in one envelope. */
export const SESSION_CONFIG_OPTION_MAX_COUNT = 32 as const;

/** Maximum length of one ACP session config option value. */
export const SESSION_CONFIG_OPTION_VALUE_MAX_LENGTH = 128 as const;

/** Upper bound for a single output artifact byte budget declared in the envelope. */
export const OUTPUT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

/** Upper bound for output artifact count declared in the envelope. */
export const OUTPUT_MAX_ARTIFACT_COUNT = 256 as const;

/** Maximum length of a portable block ref (taskId#blockId). */
export const BLOCK_REF_MAX_LENGTH = 256 as const;

/** Maximum canonical UTF-8 size of one complete Execution Envelope. */
export const EXECUTION_ENVELOPE_MAX_BYTES = 768 * 1024;
