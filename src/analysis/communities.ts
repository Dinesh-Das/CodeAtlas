import { sha256 } from "../core/hashing.js";
import type { CommunityMembership, FileGraph } from "./types.js";

export function findDependencyCommunities(
  repositoryId: string,
  graph: FileGraph,
): CommunityMembership[] {
  const adjacency = new Map<string, Set<string>>();
  for (const filePath of graph.fileNodes.keys()) adjacency.set(filePath, new Set());
  for (const link of graph.links) {
    adjacency.get(link.sourceFile)?.add(link.targetFile);
    adjacency.get(link.targetFile)?.add(link.sourceFile);
  }

  const visited = new Set<string>();
  const memberships: CommunityMembership[] = [];
  for (const start of [...adjacency.keys()].sort((left, right) => left.localeCompare(right))) {
    if (visited.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort((left, right) =>
        left.localeCompare(right),
      )) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    members.sort((left, right) => left.localeCompare(right));
    const communityId = sha256(`${repositoryId}:community:${members.join("\n")}`);
    for (const filePath of members) {
      const node = graph.fileNodes.get(filePath);
      if (node === undefined) continue;
      memberships.push({
        communityId,
        nodeId: node.id,
        filePath,
        memberCount: members.length,
      });
    }
  }
  return memberships;
}
