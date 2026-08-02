import { z } from "zod";
import { requireMapValue } from "../../graph/requireMapValue.js";
import { requireBlockState } from "../../taskManager/selectors.js";
import type { CompiledExecutionGraph, RuntimeState } from "../../types.js";
import type { ClaimHint } from "../../types/taskManager.js";
import type {
  DesktopBlockPreview,
  DesktopGraphViewModel,
  DesktopSharedResourceGroup,
  DesktopTaskNodeViewModel
} from "../types/graphTypes.js";

export const desktopSharedResourceGroupSchema = z
  .object({
    name: z.string().min(1),
    memberTaskIds: z.array(z.string().min(1)),
    memberBlockRefs: z.array(z.string().min(1)),
    activeBlockRefs: z.array(z.string().min(1))
  })
  .strict();

export type DesktopSharedResourceGroupDto = z.infer<typeof desktopSharedResourceGroupSchema>;

export type SharedResourceBlockMembership = {
  ref: string;
  taskId: string;
  resources: readonly string[];
  status: "in_progress" | "inactive";
};

/** Builds informational resource groups from content membership and transient block status. */
export function buildSharedResourceGroupsFromMembership(
  memberships: readonly SharedResourceBlockMembership[]
): DesktopSharedResourceGroup[] {
  const membersByResource = new Map<string, SharedResourceBlockMembership[]>();
  for (const membership of memberships) {
    for (const resource of membership.resources) {
      const members = membersByResource.get(resource);
      if (members) {
        members.push(membership);
      } else {
        membersByResource.set(resource, [membership]);
      }
    }
  }
  return [...membersByResource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => {
      const memberBlockRefs = members
        .map((membership) => membership.ref)
        .sort((left, right) => left.localeCompare(right));
      const memberTaskIds = [...new Set(members.map((membership) => membership.taskId))].sort(
        (left, right) => left.localeCompare(right)
      );
      return {
        name,
        memberTaskIds,
        memberBlockRefs,
        activeBlockRefs: members
          .filter((membership) => membership.status === "in_progress")
          .map((membership) => membership.ref)
          .sort((left, right) => left.localeCompare(right))
      };
    });
}

export function buildSharedResourceGroups(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): DesktopSharedResourceGroup[] {
  return buildSharedResourceGroupsFromMembership(
    graph.blockRefsInManifestOrder.map((ref) => ({
      ref,
      taskId: requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef"),
      resources: requireMapValue(graph.sharedResourcesByBlockRef, ref, "sharedResourcesByBlockRef"),
      status: requireBlockState(state, ref).status === "in_progress" ? "in_progress" : "inactive"
    }))
  );
}

function enrichBlockPreview(
  block: DesktopBlockPreview,
  claimHintByRef: Map<string, ClaimHint>
): DesktopBlockPreview {
  return {
    ...block,
    dispatchable: claimHintByRef.get(block.ref)?.dispatchable ?? false
  };
}

function taskSharedResources(
  graph: CompiledExecutionGraph,
  task: DesktopTaskNodeViewModel
): string[] {
  const resources = new Set<string>();
  for (const block of task.blocks) {
    for (const resource of requireMapValue(
      graph.sharedResourcesByBlockRef,
      block.ref,
      "sharedResourcesByBlockRef"
    )) {
      resources.add(resource);
    }
  }
  return [...resources].sort((left, right) => left.localeCompare(right));
}

export function enrichGraphViewModelSharedResources(
  graphView: Omit<DesktopGraphViewModel, "sharedResourceGroups">,
  options: {
    graph: CompiledExecutionGraph;
    state: RuntimeState;
    claimHints: ClaimHint[];
  }
): DesktopGraphViewModel {
  const claimHintByRef = new Map(options.claimHints.map((hint) => [hint.ref, hint]));
  const tasks = graphView.tasks.map((task) => {
    const blocks = task.blocks.map((block) => enrichBlockPreview(block, claimHintByRef));
    const visibleCount = task.blockPreview.length;
    return {
      ...task,
      sharedResources: taskSharedResources(options.graph, { ...task, blocks }),
      blocks,
      blockPreview: blocks.slice(0, visibleCount)
    };
  });
  return {
    ...graphView,
    tasks,
    sharedResourceGroups: buildSharedResourceGroups(options.graph, options.state)
  };
}
