import { createHash, randomBytes } from "node:crypto";
import {
  credentialSha256Schema,
  setupCodeTokenSchema,
  SETUP_CODE_TOKEN_PREFIX
} from "@planweave-ai/collaboration-protocol";
import { HUMAN_TOKEN_SECRET_CHAR_LENGTH } from "./limits.js";

export function hashSetupCode(token: string): string {
  const parsed = setupCodeTokenSchema.parse(token);
  return credentialSha256Schema.parse(createHash("sha256").update(parsed).digest("hex"));
}

export function mintSetupCodeToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== HUMAN_TOKEN_SECRET_CHAR_LENGTH) {
    throw new Error("setup_code_token_entropy_invalid");
  }
  return setupCodeTokenSchema.parse(`${SETUP_CODE_TOKEN_PREFIX}${secret}`);
}

export function mintOperatorCredentialToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== HUMAN_TOKEN_SECRET_CHAR_LENGTH) {
    throw new Error("operator_token_entropy_invalid");
  }
  return `pw_operator_${secret}`;
}
