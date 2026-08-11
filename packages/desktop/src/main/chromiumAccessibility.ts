export type ChromiumAxNodeId = string | number;

export type ChromiumAxNode = {
  nodeId?: ChromiumAxNodeId;
  parentId?: ChromiumAxNodeId;
  childIds?: ChromiumAxNodeId[];
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: Array<{ name?: unknown; value?: unknown }>;
};

export type ChromiumAxTree = { nodes?: ChromiumAxNode[] };

export type ChromiumAxSurfaceSummary = {
  nodeCount: number;
  namedRegion: boolean;
  liveRegion: boolean;
  roleNamePairs: number;
};

const defaultAllowedRoles = ["group", "region"] as const;

function axValue(value: unknown): string {
  if (typeof value === "object" && value !== null && "value" in value) {
    return String((value as { value?: unknown }).value ?? "");
  }
  return String(value ?? "");
}

function nodeKey(nodeId: ChromiumAxNodeId): string {
  return `${typeof nodeId}:${String(nodeId)}`;
}

function isInSubtree(
  node: ChromiumAxNode,
  anchor: ChromiumAxNode,
  nodesById: ReadonlyMap<string, ChromiumAxNode>
): boolean {
  if (node === anchor) return true;
  if (node.nodeId === undefined || anchor.nodeId === undefined) return false;

  const anchorKey = nodeKey(anchor.nodeId);
  const targetKey = nodeKey(node.nodeId);
  const visited = new Set<string>();
  const visitChildren = (current: ChromiumAxNode): boolean => {
    for (const childId of current.childIds ?? []) {
      const childKey = nodeKey(childId);
      if (childKey === targetKey) return true;
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      const child = nodesById.get(childKey);
      if (child && visitChildren(child)) return true;
    }
    return false;
  };

  if (visitChildren(anchor)) return true;

  let current = node;
  while (current.parentId !== undefined) {
    const parentKey = nodeKey(current.parentId);
    if (parentKey === anchorKey) return true;
    if (visited.has(parentKey)) return false;
    visited.add(parentKey);
    const parent = nodesById.get(parentKey);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function hasLiveProperty(node: ChromiumAxNode): boolean {
  return (node.properties ?? []).some((property) => {
    if (axValue(property.name).toLocaleLowerCase() !== "live") return false;
    const value = axValue(property.value).trim().toLocaleLowerCase();
    return value.length > 0 && value !== "off";
  });
}

export function summarizeChromiumAccessibilityTree(
  tree: ChromiumAxTree,
  names: readonly string[],
  options: { allowedRoles?: readonly string[] } = {}
): ChromiumAxSurfaceSummary {
  const nodes = tree.nodes ?? [];
  const nodesById = new Map<string, ChromiumAxNode>();
  for (const node of nodes) {
    if (node.nodeId !== undefined) nodesById.set(nodeKey(node.nodeId), node);
  }

  const expectedNames = names
    .map((name) => name.trim().toLocaleLowerCase())
    .filter((name) => name.length > 0);
  const allowedRoles = new Set(
    (options.allowedRoles ?? defaultAllowedRoles).map((role) => role.trim().toLocaleLowerCase())
  );
  const anchors = nodes.filter((node) => {
    const role = axValue(node.role?.value).trim().toLocaleLowerCase();
    const name = axValue(node.name?.value).trim().toLocaleLowerCase();
    return (
      allowedRoles.has(role) && expectedNames.some((expectedName) => name.includes(expectedName))
    );
  });

  let liveRegion = false;
  let roleNamePairs = 0;
  for (const anchor of anchors) {
    const subtree = nodes.filter((node) => isInSubtree(node, anchor, nodesById));
    if (subtree.some(hasLiveProperty)) liveRegion = true;
    roleNamePairs = Math.max(
      roleNamePairs,
      subtree.filter((node) => {
        const role = axValue(node.role?.value).trim();
        const name = axValue(node.name?.value).trim();
        return role.length > 0 && name.length > 0;
      }).length
    );
  }

  return {
    nodeCount: nodes.length,
    namedRegion: anchors.length > 0,
    liveRegion,
    roleNamePairs
  };
}
