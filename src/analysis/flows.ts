import { sha256 } from "../core/hashing.js";
import type { Atlas, AtlasFlow, AtlasFlowStep, AtlasRelationship } from "../ir/models.js";

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
}

export function buildExecutionFlows(
  atlas: Atlas,
  options: { maxDepth?: number; maxSteps?: number } = {},
): AtlasFlow[] {
  const maxDepth = options.maxDepth ?? 8;
  const maxSteps = options.maxSteps ?? 80;
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
    const queue: QueueItem[] = [{ symbolId: entrypointId, depth: 0, relationship: null }];
    const visited = new Set<string>();
    const steps: AtlasFlowStep[] = [];
    let cycleDetected = false;
    let truncated = false;
    while (queue.length > 0 && steps.length < maxSteps) {
      const current = queue.shift()!;
      if (visited.has(current.symbolId)) {
        cycleDetected = true;
        continue;
      }
      visited.add(current.symbolId);
      const symbol = symbolById.get(current.symbolId);
      if (symbol === undefined) continue;
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
      const next = outgoing.get(current.symbolId) ?? [];
      if (current.depth >= maxDepth) {
        if (next.length > 0) truncated = true;
        continue;
      }
      for (const relationship of next) {
        if (visited.has(relationship.target)) cycleDetected = true;
        else queue.push({
          symbolId: relationship.target,
          depth: current.depth + 1,
          relationship,
        });
      }
    }
    if (queue.length > 0) truncated = true;
    return {
      id: `flow:${sha256(entrypointId)}`,
      name: entrypoint?.name ?? entrypointId,
      entrypoint_id: entrypointId,
      steps,
      truncated,
      cycle_detected: cycleDetected,
    };
  });
}
