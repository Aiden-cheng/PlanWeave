import { authoringToolDefinitions } from "./toolContracts/authoringDefinitions.js";
import { contentToolDefinitions } from "./toolContracts/contentDefinitions.js";
import { debugToolDefinitions } from "./toolContracts/debugDefinitions.js";
import { graphToolDefinitions } from "./toolContracts/graphDefinitions.js";
import { projectToolDefinitions } from "./toolContracts/projectDefinitions.js";
import { readToolDefinitions } from "./toolContracts/readDefinitions.js";
import { buildToolContractRegistry } from "./toolContracts/registry.js";
import type { ToolDefinition } from "./toolContracts/types.js";
import { planweaveToolNames, type PlanweaveToolName } from "./toolTypes.js";

export type { ToolDefinition } from "./toolContracts/types.js";

export const planweaveToolDefinitionRegistries = [
  authoringToolDefinitions,
  readToolDefinitions,
  projectToolDefinitions,
  graphToolDefinitions,
  contentToolDefinitions,
  debugToolDefinitions
] as const;

type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection
) => void
  ? Intersection
  : never;

type PlanweaveToolDefinitionRegistry = UnionToIntersection<
  (typeof planweaveToolDefinitionRegistries)[number]
>;

export const planweaveToolDefinitions = buildToolContractRegistry<
  ToolDefinition,
  PlanweaveToolDefinitionRegistry
>(
  planweaveToolDefinitionRegistries,
  planweaveToolNames,
  "PlanWeave tool definition"
) satisfies Record<PlanweaveToolName, ToolDefinition>;
