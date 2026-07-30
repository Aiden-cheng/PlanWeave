import * as z from "zod/v4";
import type { PlanweaveToolName } from "../toolTypes.js";

export const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false
} as const;

export const writeAnnotations = {
  readOnlyHint: false,
  openWorldHint: false
} as const;

export type ToolDefinition<InputSchema extends z.ZodType = z.ZodType> = {
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: typeof readOnlyAnnotations | typeof writeAnnotations;
};

export type PlanweavePartialToolDefinitionRegistry = Partial<
  Record<PlanweaveToolName, ToolDefinition>
>;

export type ToolDefinitionInput = Omit<ToolDefinition, "inputSchema"> & {
  inputSchema?: z.core.$ZodLooseShape | z.ZodType;
};

export type PlanweavePartialToolDefinitionInputRegistry = Partial<
  Record<PlanweaveToolName, ToolDefinitionInput>
>;

export const emptyToolInputSchema = z.strictObject({});

export type CanonicalToolInputSchema<InputSchema> = InputSchema extends z.ZodType
  ? InputSchema
  : InputSchema extends z.core.$ZodLooseShape
    ? ReturnType<typeof z.strictObject<InputSchema>>
    : typeof emptyToolInputSchema;

export type CanonicalToolDefinition<Definition extends ToolDefinitionInput> = Omit<
  Definition,
  "inputSchema"
> & {
  inputSchema: CanonicalToolInputSchema<Definition["inputSchema"]>;
};

export type CanonicalToolDefinitionRegistry<
  Definitions extends PlanweavePartialToolDefinitionInputRegistry
> = {
  [Name in keyof Definitions]: Definitions[Name] extends ToolDefinitionInput
    ? CanonicalToolDefinition<Definitions[Name]>
    : never;
};

export function defineToolDefinitions<
  const Definitions extends PlanweavePartialToolDefinitionInputRegistry
>(definitions: Definitions): CanonicalToolDefinitionRegistry<Definitions> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      {
        ...definition,
        inputSchema: canonicalToolInputSchema(definition.inputSchema)
      }
    ])
  ) as CanonicalToolDefinitionRegistry<Definitions>;
}

export function canonicalToolInputSchema<
  const InputSchema extends ToolDefinitionInput["inputSchema"]
>(inputSchema: InputSchema): CanonicalToolInputSchema<InputSchema> {
  if (inputSchema === undefined) {
    return emptyToolInputSchema as CanonicalToolInputSchema<InputSchema>;
  }
  if (inputSchema instanceof z.ZodType) {
    return inputSchema as CanonicalToolInputSchema<InputSchema>;
  }
  return z.strictObject(inputSchema) as CanonicalToolInputSchema<InputSchema>;
}

export type PlanweavePartialToolOutputSchemaRegistry = Partial<
  Record<PlanweaveToolName, z.core.$ZodLooseShape>
>;
