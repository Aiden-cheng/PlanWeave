import { z } from "zod";

const token = String.raw`[A-Za-z0-9!#$%&'*+.^_\x60|~-]+`;
const quotedString = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;

export const artifactMediaTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    new RegExp(
      `^${token}/${token}(?:[ \\t]*;[ \\t]*${token}[ \\t]*=[ \\t]*(?:${token}|${quotedString}))*$`
    )
  );
