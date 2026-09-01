import { sha256 } from "../core/hashing.js";
import type {
  Atlas,
  AtlasFlow,
  AtlasFlowEdge,
  AtlasFlowPath,
  AtlasFlowStep,
  AtlasRelationship,
} from "../ir/models.js";

const FLOW_EDGE_TYPES = new Set([
  "HANDLES",
  "CALLS",
  "MAY_CONTINUE_TO",
  "TRIGGERS",
  "IMPLEMENTED_BY",
  "QUERIES",
  "UPDATES",
  "READS_FROM",
  "WRITES_TO",
]);

interface QueueItem {
  symbolId: string;
  depth: number;
  relationship: AtlasRelationship | null;
  symbolPath: string[];
  relationshipPath: string[];
}

export function buildExecutionFlows(
  atlas: Atlas,
  options: { maxDepth?: number; maxSteps?: number; maxPaths?: number } = {},
): AtlasFlow[] {
  const maxDepth = options.maxDepth ?? 8;
  const maxSteps = options.maxSteps ?? 80;
  const maxPaths = Math.max(1, options.maxPaths ?? 20);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const outgoing = new Map<string, AtlasRelationship[]>();
  for (const relationship of atlas.relationships) {
    if (!FLOW_EDGE_TYPES.has(relationship.type)) continue;
    const edges = outgoing.get(relationship.source) ?? [];
    edges.push(relationship);
    outgoing.set(relationship.source, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) =>
      right.confidence - left.confidence ||
      (symbolById.get(left.target)?.qualified_name ?? left.target).localeCompare(
        symbolById.get(right.target)?.qualified_name ?? right.target,
      ) || left.id.localeCompare(right.id),
    );
  }

  return atlas.entrypoint_ids.map((entrypointId): AtlasFlow => {
    const entrypoint = symbolById.get(entrypointId);
    const queue: QueueItem[] = [{
      symbolId: entrypointId,
      depth: 0,
      relationship: null,
      symbolPath: [entrypointId],
      relationshipPath: [],
    }];
    const discovered = new Set<string>();
    const steps: AtlasFlowStep[] = [];
    const flowEdges = new Map<string, AtlasFlowEdge>();
    const paths: AtlasFlowPath[] = [];
    let cycleDetected = false;
    let truncated = false;
    const addPath = (item: QueueItem, pathTruncated: boolean, pathCycle: boolean): void => {
      if (paths.length >= maxPaths) {
        truncated = true;
        return;
      }
      paths.push({
        id: `flow-path:${sha256(`${entrypointId}\0${item.relationshipPath.join("\0")}\0${item.symbolPath.join("\0")}`)}`,
        symbol_ids: item.symbolPath,
        relationship_ids: item.relationshipPath,
        truncated: pathTruncated,
        cycle_detected: pathCycle,
      });
    };
    while (queue.length > 0) {
      const current = queue.shift()!;
      const symbol = symbolById.get(current.symbolId);
      if (symbol === undefined) continue;
      if (!discovered.has(current.symbolId)) {
        if (steps.length >= maxSteps) {
          truncated = true;
          addPath(current, true, false);
          continue;
        }
        discovered.add(current.symbolId);
        steps.push({
          order: steps.length + 1,
          symbol_id: current.symbolId,
          relationship_id: current.relationship?.id ?? null,
          confidence: current.relationship?.confidence ?? symbol.confidence,
          evidence_ids: [
            ...symbol.evidence_ids,
            ...(current.relationship?.evidence_ids ?? []),
          ],
        });
      }
      const next = outgoing.get(current.symbolId) ?? [];
      if (current.depth >= maxDepth) {
        const pathTruncated = next.length > 0;
        if (pathTruncated) truncated = true;
        addPath(current, pathTruncated, false);
        continue;
      }
      if (next.length === 0) {
        addPath(current, false, false);
        continue;
      }
      for (const relationship of next) {
        flowEdges.set(relationship.id, {
          id: `flow-edge:${relationship.id}`,
          source: relationship.source,
          target: relationship.target,
          relationship_id: relationship.id,
          confidence: relationship.confidence,
          evidence_ids: [...relationship.evidence_ids],
        });
        const item: QueueItem = {
          symbolId: relationship.target,
          depth: current.depth + 1,
          relationship,
          symbolPath: [...current.symbolPath, relationship.target],
          relationshipPath: [...current.relationshipPath, relationship.id],
        };
        if (current.symbolPath.includes(relationship.target)) {
          cycleDetected = true;
          addPath(item, false, true);
          continue;
        }
        if (paths.length + queue.length >= maxPaths) {
          truncated = true;
          addPath(item, true, false);
          continue;
        }
        queue.push(item);
      }
    }
    if (paths.length === 0) {
      addPath({
        symbolId: entrypointId,
        depth: 0,
        relationship: null,
        symbolPath: [entrypointId],
        relationshipPath: [],
      }, false, false);
    }
    return {
      id: `flow:${sha256(entrypointId)}`,
      name: entrypoint?.name ?? entrypointId,
      entrypoint_id: entrypointId,
      steps,
      edges: [...flowEdges.values()],
      paths,
      truncated,
      cycle_detected: cycleDetected,
    };
  });
}
