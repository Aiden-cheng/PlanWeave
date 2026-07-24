export {
  parseVpsE2eGate,
  precondition,
  dispositionForGate,
  type VpsE2eGate,
  type VpsE2eGateMode,
  type VpsE2eProfileId,
  type VpsE2ePrecondition,
  type VpsE2ePreconditionKind,
  type VpsE2ePreconditionDisposition
} from "./gate.js";
export {
  remoteVpsE2eConfigSchema,
  resolveVpsE2eTarget,
  type RemoteVpsE2eConfig,
  type ResolvedVpsE2eTarget
} from "./config.js";
export {
  emptyChecks,
  emptyIdentities,
  writeVpsE2eEvidence,
  type VpsE2eEvidence,
  type VpsE2eEvidenceChecks,
  type VpsE2eEnvironmentClass,
  type VpsE2eIdentityEvidence
} from "./evidence.js";
export { redactSensitiveText, redactPathForEvidence, digestLabel } from "./redaction.js";
export { runVpsAuthenticatedE2e, type RunVpsE2eOptions } from "./run.js";
export { runVpsE2eCli, type VpsE2eCliIo } from "./cli.js";
export { resolveOpensslBinary, generateLocalTlsMaterial } from "./tlsMaterial.js";
