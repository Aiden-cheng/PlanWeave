import { z } from "zod";

/** Maximum serialized length of an artifact media type. Values are ASCII, so bytes equal chars. */
export const ARTIFACT_MEDIA_TYPE_MAX_LENGTH = 255;

const token = String.raw`[A-Za-z0-9!#$%&'*+.^_\x60|~-]+`;
const quotedString = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;
const parameter = new RegExp(
  String.raw`[ \t]*;[ \t]*(${token})[ \t]*=[ \t]*(${token}|${quotedString})`,
  "g"
);
const mediaType = new RegExp(
  String.raw`^(${token})\/(${token})((?:[ \t]*;[ \t]*${token}[ \t]*=[ \t]*(?:${token}|${quotedString}))*)$`
);

function canonicalizeArtifactMediaType(value: string): string {
  const match = mediaType.exec(value);
  if (!match) return value;
  const parameters = match[3].replace(parameter, (_part, name: string, parameterValue: string) => {
    return `; ${name.toLowerCase()}=${parameterValue}`;
  });
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}${parameters}`;
}

/**
 * Canonical artifact Content-Type contract.
 *
 * Accepts RFC token type/subtype and token or quoted parameters, ASCII only, with a 255-byte
 * serialized limit. Type, subtype, parameter names, and optional whitespace are canonicalized;
 * parameter values are preserved because their case can be significant.
 */
export const artifactMediaTypeSchema = z
  .string()
  .min(1)
  .max(ARTIFACT_MEDIA_TYPE_MAX_LENGTH)
  .regex(mediaType)
  .transform(canonicalizeArtifactMediaType);

export type ArtifactMediaType = z.infer<typeof artifactMediaTypeSchema>;
