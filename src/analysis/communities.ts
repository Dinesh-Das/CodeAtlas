import { sha256 } from "../core/hashing.js";
import type { CommunityMembership, FileGraph } from "./types.js";

interface WeightedGraph {
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
  degree: ReadonlyMap<string, number>;
  totalEdgeWeight: number;
}

function buildWeightedGraph(graph: FileGraph): WeightedGraph {
  const adjacency = new Map<string, Map<string, number>>();
  for (const filePath of graph.fileNodes.keys()) adjacency.set(filePath, new Map());

  for (const link of graph.links) {
    if (link.sourceFile === link.targetFile) continue;
    const weight = Math.max(0.05, link.confidence);
    const source = adjacency.get(link.sourceFile);
    const target = adjacency.get(link.targetFile);
    if (source === undefined || target === undefined) continue;
    source.set(link.targetFile, (source.get(link.targetFile) ?? 0) + weight);
    target.set(link.sourceFile, (target.get(link.sourceFile) ?? 0) + weight);
  }

  const degree = new Map<string, number>();
  let totalDegree = 0;
  for (const [filePath, neighbors] of adjacency) {
    const value = [...neighbors.values()].reduce((sum, weight) => sum + weight, 0);
    degree.set(filePath, value);
    totalDegree += value;
  }
  return { adjacency, degree, totalEdgeWeight: totalDegree / 2 };
}

/** Deterministic Louvain local-moving phase. */
function optimizeModularity(weighted: WeightedGraph): ReadonlyMap<string, string> {
  const nodes = [...weighted.adjacency.keys()].sort((left, right) => left.localeCompare(right));
  const communityByNode = new Map(nodes.map((node) => [node, node]));
  const communityWeight = new Map(nodes.map((node) => [node, weighted.degree.get(node) ?? 0]));
  const denominator = weighted.totalEdgeWeight * 2;
  if (denominator === 0) return communityByNode;

  for (let pass = 0; pass < 50; pass += 1) {
    let moved = false;
    for (const node of nodes) {
      const nodeDegree = weighted.degree.get(node) ?? 0;
      if (nodeDegree === 0) continue;
      const current = communityByNode.get(node)!;
      communityWeight.set(current, (communityWeight.get(current) ?? 0) - nodeDegree);

      const weightByCommunity = new Map<string, number>();
      for (const [neighbor, weight] of weighted.adjacency.get(node) ?? []) {
        const community = communityByNode.get(neighbor)!;
        weightByCommunity.set(community, (weightByCommunity.get(community) ?? 0) + weight);
      }

      let best = current;
      let bestGain = weightByCommunity.get(current) ?? 0;
      bestGain -= ((communityWeight.get(current) ?? 0) * nodeDegree) / denominator;
      for (const community of [...weightByCommunity.keys()].sort((left, right) =>
        left.localeCompare(right),
      )) {
        const gain = (weightByCommunity.get(community) ?? 0) -
          ((communityWeight.get(community) ?? 0) * nodeDegree) / denominator;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && community < best)) {
          best = community;
          bestGain = gain;
        }
      }

      communityByNode.set(node, best);
      communityWeight.set(best, (communityWeight.get(best) ?? 0) + nodeDegree);
      if (best !== current) moved = true;
    }
    if (!moved) break;
  }
  return communityByNode;
}

function aggregateGraph(
  weighted: WeightedGraph,
  communityByNode: ReadonlyMap<string, string>,
): WeightedGraph {
  const communities = [...new Set(communityByNode.values())].sort((left, right) =>
    left.localeCompare(right),
  );
  const adjacency = new Map<string, Map<string, number>>(
    communities.map((community) => [community, new Map()]),
  );
  // The source graph stores both directions. Retaining both directions here also retains
  // internal community weight as a self-loop, which is required at the next Louvain level.
  for (const [source, neighbors] of weighted.adjacency) {
    const sourceCommunity = communityByNode.get(source)!;
    const aggregated = adjacency.get(sourceCommunity)!;
    for (const [target, weight] of neighbors) {
      const targetCommunity = communityByNode.get(target)!;
      aggregated.set(targetCommunity, (aggregated.get(targetCommunity) ?? 0) + weight);
    }
  }
  const degree = new Map<string, number>();
  let totalDegree = 0;
  for (const [community, neighbors] of adjacency) {
    const value = [...neighbors.values()].reduce((sum, weight) => sum + weight, 0);
    degree.set(community, value);
    totalDegree += value;
  }
  return { adjacency, degree, totalEdgeWeight: totalDegree / 2 };
}

/** Full deterministic multilevel Louvain: local move, aggregate, and repeat. */
function multilevelCommunities(weighted: WeightedGraph): ReadonlyMap<string, string> {
  const originals = [...weighted.adjacency.keys()].sort((left, right) => left.localeCompare(right));
  const currentByOriginal = new Map(originals.map((node) => [node, node]));
  let current = weighted;
  for (let level = 0; level < 20; level += 1) {
    const optimized = optimizeModularity(current);
    for (const original of originals) {
      currentByOriginal.set(original, optimized.get(currentByOriginal.get(original)!)!);
    }
    const communityCount = new Set(optimized.values()).size;
    if (communityCount === current.adjacency.size || communityCount <= 1) break;
    current = aggregateGraph(current, optimized);
  }
  return currentByOriginal;
}

export function findDependencyCommunities(
  repositoryId: string,
  graph: FileGraph,
): CommunityMembership[] {
  const communities = multilevelCommunities(buildWeightedGraph(graph));
  const membersByCommunity = new Map<string, string[]>();
  for (const [filePath, community] of communities) {
    const members = membersByCommunity.get(community) ?? [];
    members.push(filePath);
    membersByCommunity.set(community, members);
  }

  const memberships: CommunityMembership[] = [];
  const groups = [...membersByCommunity.values()]
    .map((members) => members.sort((left, right) => left.localeCompare(right)))
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
  for (const members of groups) {
    const communityId = sha256(`${repositoryId}:community:${members.join("\n")}`);
    for (const filePath of members) {
      const node = graph.fileNodes.get(filePath);
      if (node === undefined) continue;
      memberships.push({ communityId, nodeId: node.id, filePath, memberCount: members.length });
    }
  }
  return memberships;
}
