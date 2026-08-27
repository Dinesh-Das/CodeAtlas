import type { NodeKind } from "../graph/types.js";
import type { AtlasDatabase } from "../storage/database.js";
import { getNodesByIds, type StoredEdge, type StoredNode } from "./query.js";

const KIND_WEIGHT: Record<NodeKind, number> = {
  repository: 2,
  package: 5,
  directory: 3,
  module: 8,
  file: 7,
  class: 14,
  interface: 12,
  function: 15,
  method: 15,
  variable: 6,
  api_route: 18,
  database_model: 17,
  database_table: 15,
  configuration: 8,
  documentation: 9,
  external_service: 13,
  test: 10,
  feature: 18,
  domain: 12,
  event: 13,
  queue: 13,
};

function terms(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}_$-]+/gu) ?? [];
}

function similarity(node: StoredNode, query: string | undefined): number {
  if (query === undefined || query.trim() === "") return 0;
  const normalized = query.trim().toLowerCase();
  const name = node.name.toLowerCase();
  const qualified = (node.qualifiedName ?? "").toLowerCase();
  const file = (node.filePath ?? "").toLowerCase();
  if (name === normalized || qualified === normalized) return 40;
  if (name.startsWith(normalized)) return 32;
  const queryTerms = terms(normalized);
  const haystack = new Set(terms(`${name} ${qualified} ${file}`));
  const overlap = queryTerms.filter((term) => haystack.has(term)).length;
  return Math.min(28, overlap * 8 + (qualified.includes(normalized) || file.includes(normalized) ? 8 : 0));
}

function featureMembers(database: AtlasDatabase, nodeIds: readonly string[]): Set<string> {
  if (nodeIds.length === 0) return new Set();
  const placeholders = nodeIds.map(() => "?").join(", ");
  return new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT source_node_id AS id FROM edges
           WHERE source_node_id IN (${placeholders})
             AND edge_type = 'BELONGS_TO_FEATURE'`,
        )
        .all(...nodeIds) as Array<{ id: string }>
    ).map((row) => row.id),
  );
}

export interface NodeRankContext {
  query?: string;
  distanceByNodeId?: ReadonlyMap<string, number>;
  directStrengthByNodeId?: ReadonlyMap<string, number>;
}

export function rankNodes(
  database: AtlasDatabase,
  nodes: readonly StoredNode[],
  context: NodeRankContext = {},
): StoredNode[] {
  const memberships = featureMembers(database, nodes.map((node) => node.id));
  return [...nodes]
    .map((node) => {
      const distance = context.distanceByNodeId?.get(node.id);
      const directStrength = context.directStrengthByNodeId?.get(node.id) ?? 0;
      const score =
        similarity(node, context.query) +
        KIND_WEIGHT[node.kind] +
        node.confidence * 20 +
        (memberships.has(node.id) ? 8 : 0) +
        (distance === undefined ? 0 : 20 / Math.max(1, distance)) +
        directStrength * 12;
      return { node, score };
    })
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .map((entry) => entry.node);
}

export function rankEdges(
  database: AtlasDatabase,
  edges: readonly StoredEdge[],
  anchorNodeId: string,
  distanceByNodeId?: ReadonlyMap<string, number>,
): StoredEdge[] {
  const relatedIds = edges.map((edge) =>
    edge.sourceNodeId === anchorNodeId ? edge.targetNodeId : edge.sourceNodeId,
  );
  const directStrength = new Map<string, number>();
  for (const edge of edges) {
    const related = edge.sourceNodeId === anchorNodeId ? edge.targetNodeId : edge.sourceNodeId;
    directStrength.set(related, Math.max(directStrength.get(related) ?? 0, edge.confidence));
  }
  const rankedIds = rankNodes(database, getNodesByIds(database, relatedIds), {
    ...(distanceByNodeId === undefined ? {} : { distanceByNodeId }),
    directStrengthByNodeId: directStrength,
  }).map((node) => node.id);
  const position = new Map(rankedIds.map((id, index) => [id, index]));
  return [...edges].sort((left, right) => {
    const leftId = left.sourceNodeId === anchorNodeId ? left.targetNodeId : left.sourceNodeId;
    const rightId = right.sourceNodeId === anchorNodeId ? right.targetNodeId : right.sourceNodeId;
    return (
      (position.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
      right.confidence - left.confidence ||
      left.id.localeCompare(right.id)
    );
  });
}
